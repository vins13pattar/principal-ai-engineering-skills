# Patterns

Four excerpts from two labs, each naming its file. Two come from
`labs/policy-gated-tool-runtime/src/tool_gateway/` — the enforcement half,
deciding what a known caller may do. Two come from
`labs/agent-identity-broker/src/agent_identity/` — the identity half, deciding
who the caller is. The labs share no code and nothing below is composed across
them. All four were verified by binding them over the originals and running
each lab's suite, baselines established first: 44 tests in the tool runtime, 22
in the identity broker.

One condition applies to everything from the tool runtime: registry, rate
limiter, approval queue, and audit log are in-memory and single-replica, and
caller identity is a spoofable `x-agent-id` header. The pipeline transfers;
none of the storage does.

## The five checks, and the audit fan-in

From `gateway.py` in the tool runtime. Each stage runs cheapest-first, and every
branch writes to the log before it re-raises.

```python
    async def call(
        self, identity: CallerIdentity, tool_name: str, arguments: dict[str, Any]
    ) -> ToolResult:
        try:
            spec = self.registry.get(tool_name)      # NOTE: ahead of the scope check
        except ToolNotFoundError as exc:
            self._deny(identity, tool_name, CallOutcome.ERROR, str(exc))
            raise

        try:
            self.scope_policy.check(identity, tool_name)
        except ScopeDeniedError as exc:
            self._deny(identity, tool_name, CallOutcome.DENIED_SCOPE, str(exc))
            raise

        try:
            validate_arguments(spec, arguments)      # the REGISTRY's schema, not the caller's
        except ArgumentValidationError as exc:
            self._deny(identity, tool_name, CallOutcome.DENIED_VALIDATION, str(exc))
            raise

        try:
            await self.rate_limiter.acquire(identity.tenant_id, tool_name, spec.rate_limit_per_minute)
        except RateLimitExceededError as exc:
            self._deny(identity, tool_name, CallOutcome.DENIED_RATE_LIMIT, str(exc))
            raise

        approval_id = None
        if spec.risk is RiskLevel.HIGH:              # LOW is the ToolSpec default
            try:
                approval = await self.approvals.request(
                    tool_name, identity.agent_id, identity.tenant_id, arguments,
                    timeout_seconds=self._approval_timeout_seconds,
                )
            except (ApprovalDeniedError, ApprovalTimeoutError) as exc:
                self._deny(identity, tool_name, CallOutcome.DENIED_APPROVAL, str(exc))
                raise
            approval_id = approval.id

        handler = self.registry.handler_for(tool_name)
        try:
            output = await handler(arguments)
        except Exception as exc:
            self._deny(identity, tool_name, CallOutcome.ERROR, f"{type(exc).__name__}: {exc}")
            raise

        self.audit_log.record(
            agent_id=identity.agent_id, tenant_id=identity.tenant_id,
            tool_name=tool_name, outcome=CallOutcome.ALLOWED,
        )
        return ToolResult(tool_name=tool_name, output=output, approval_id=approval_id)
```

Five decisions, not five filters. Scope before validation, so a schema error
never describes a tool the caller was not entitled to know exists. Validation
before the limiter, so a malformed call cannot spend a well-behaved caller's
budget. Approval last, because it is the only stage that blocks on a human.

Copy the first `try` block's structure and not its position. `registry.get()`
runs ahead of the scope check, so an ungranted tool and an unknown tool raise
different errors, mapped to `403` and `404` at the HTTP edge. Confirmed by
running it: a caller holding no scopes gets `ScopeDeniedError` for a registered
tool and `ToolNotFoundError` for an invented one — a name-enumeration oracle
for exactly the surface the ordering was meant to conceal. And those probes
record as `ERROR` rather than as a denial, so the activity most worth counting
is filed under the most generic outcome.

`if spec.risk is RiskLevel.HIGH` matters because the default on the other side
is `RiskLevel.LOW`: a tool registered by someone who never thought about
approval is ungated, and that registration looks exactly like a considered one.

The denial arm repeats on every branch because it must. `_deny` sends `agent_id`,
`tenant_id`, `tool_name`, `outcome`, and `detail` to `AuditLog.record` — no
arguments. `detail` is whatever `str(exc)` produced, which on the validation
branch is the validator's message. Running it with a nested argument produced
the entry `invalid arguments for tool 'search_docs': {'secret': 'sk-live-abcdef'}
is not of type 'string'`. The branch you would never have chosen to store keeps
the payload verbatim; scope and quota denials keep nothing and cannot be
investigated.

Deliberately omitted: the class body, `__init__`, and `_deny` itself, without
which this does not run as printed. Edits to disclose — the `started` /
`latency_ms` timing is removed, the `rate_limiter.acquire` call, the
`approvals.request` arguments, the handler-error `detail`, and the final
`record(...)` are reflowed onto fewer lines with no change to the arguments,
and the three trailing `# ...` comments are mine.

## The registry owns the schema; the listing is not a control

From `registry.py` in the tool runtime.

```python
class ToolRegistry:
    def get(self, tool_name: str) -> ToolSpec:
        spec = self._specs.get(tool_name)
        if spec is None:
            raise ToolNotFoundError(tool_name)
        return spec

    def list(self) -> list[ToolSpec]:
        return list(self._specs.values())


def validate_arguments(spec: ToolSpec, arguments: dict[str, Any]) -> None:
    """Validate call arguments against a tool's declared JSON Schema.

    Tool arguments are attacker-controlled: they may come from a model's
    generation, not from a trusted client. Rejecting malformed input before
    it reaches a handler is the same discipline as validating any other
    untrusted request body.
    """
    try:
        jsonschema.validate(arguments, spec.input_schema)
    except jsonschema.ValidationError as exc:
        raise ArgumentValidationError(spec.name, exc.message) from exc
```

`spec.input_schema` is the rule this skill exists for, expressed as a lookup:
the schema comes from the registry, by name — never from the request, never
from what the model was shown. That is the whole difference between a prompt
and a contract, and in a diff it is one argument.

`get` and `list` answer different questions and only `get` is on the
enforcement path. Dispatch takes a name, so a tool withheld from a caller's
listing is still callable by that name; `list()` hands every spec to every
caller, which is fine precisely because filtering it was never the control. If
you are filtering a listing for security, the scope check is missing.

Bounds belong in the schema. The lab's `demo.py` gives `issue_refund` a schema
carrying `"maximum": 10_000` and `"additionalProperties": False` — the two
things a generated schema reliably omits, and both matter for where they sit:
an out-of-range refund is refused here, before quota is spent and before an
operator is woken.

Deliberately omitted: `register`, `handler_for`, `__init__` and the `_specs` /
`_handlers` it declares, the class docstring, and the module imports including
`jsonschema` — so the class compiles as printed but has no state.

## Five checks a resource server owes, four of them delegated

From `resource_server.py` in the identity broker.

```python
    def authenticate(self, token: str) -> AgentPrincipal:
        try:
            claims = jwt.decode(
                token,
                key=self._issuer_public_key,
                algorithms=[ALGORITHM],
                audience=self.identity,       # checks 1-4 are configuration, not
                issuer=self._trusted_issuer,  # a conditional you can invert
                options={"require": ["exp", "aud", "iss", "sub"]},
            )
        except jwt.InvalidAudienceError as error:
            raise TokenRejected("audience does not name this server") from error
        except jwt.ExpiredSignatureError as error:
            raise TokenRejected("token has expired") from error
        except jwt.InvalidIssuerError as error:
            raise TokenRejected("issuer is not trusted") from error
        except jwt.PyJWTError as error:
            raise TokenRejected(f"token invalid: {type(error).__name__}") from error

        actor = claims.get("act")
        return AgentPrincipal(
            subject=str(claims["sub"]),
            actor=str(actor["sub"]) if actor else None,
            audience=str(claims["aud"]),
            scopes=frozenset(str(claims.get("scope", "")).split()),
        )

    def authorize(self, principal: AgentPrincipal, *, tool: str, required_scope: str) -> None:
        if required_scope not in principal.scopes:
            raise TokenRejected(
                f"scope {required_scope!r} required for {tool!r}; "
                f"token carries {sorted(principal.scopes)}"
            )
```

`audience=self.identity` inside the decode call, rather than a
`claims["aud"] == self.identity` after it, is the load-bearing line. The manual
version keeps working after somebody sets `verify_aud: False` to unblock a
staging session, and there is no runtime symptom when it does — the server
stays functional and enforces its policy against tokens minted for other
people. Measured on this lab: flipping that one option makes six tests fail
across three files; restoring it returns all 22 to green.

Four `except` arms exist because the audit log needs to say which invariant
broke. The wire gets a bare `401` or `403`, since telling the caller turns the
endpoint into an oracle for probing what a stolen token is missing.

`authorize` stays separate from `authenticate`: audience gets you in the door
and says nothing about which room, and the split is what lets the log
distinguish "not addressed to me" from "addressed to me, not entitled to this".
Both run per invocation, not per connection — a stateless protocol has no
session on which the decision could have been made earlier. Note `actor` is
optional: a token with no `act` claim authenticates fine and audits as just the
user.

Deliberately omitted: the class body, `__init__` and the `identity` /
`_trusted_issuer` / `_issuer_public_key` it sets, the module docstring listing
the five checks, `call_tool` (which is `authenticate` then `authorize`), and
the imports — without which this does not run as printed. Edits to disclose:
the lab's comment on the `InvalidAudienceError` arm is dropped, the two
comments on the `audience` and `issuer` lines are mine, and both method
docstrings are removed.

## The exchange, and the two guards that make it a control

From `broker.py` in the identity broker.

```python
    def exchange(self, request: ExchangeRequest, *, presented_to: str) -> str:
        try:
            subject_claims = jwt.decode(
                request.subject_token,
                key=self._key.public_pem,
                algorithms=[ALGORITHM],
                audience=presented_to,      # guard 1: was this token addressed to ME?
                issuer=self._issuer,
                options={"require": ["exp", "aud", "iss", "sub"]},
            )
        except jwt.PyJWTError as error:
            raise ExchangeDenied(f"subject token invalid: {type(error).__name__}") from error

        held = frozenset(str(subject_claims.get("scope", "")).split())
        widened = request.scopes - held
        if widened:
            raise ExchangeDenied(f"cannot widen scope; subject does not hold {sorted(widened)}")

        permitted = subject_claims.get("may_act")
        if permitted is not None and request.actor not in set(permitted.get("sub", [])):
            raise ExchangeDenied(f"actor {request.actor!r} is not in the subject's may_act")

        now = dt.datetime.now(dt.UTC)
        return jwt.encode(
            {
                "iss": self._issuer,
                "sub": subject_claims["sub"],
                "aud": request.resource,        # RFC 8707 resource becomes the audience
                "scope": " ".join(sorted(request.scopes)),
                "act": {"sub": request.actor},  # RFC 8693 s4.1: delegation, and by whom
                "iat": now,
                "exp": now + self._lifetime,    # minutes, not the user's session
            },
            self._key.private_pem,
            algorithm=ALGORITHM,
        )
```

Guard 1 is the one people leave out. Verifying the presented subject token
names *this* broker as its audience is what stops the broker being an
escalation service: without it, anyone holding any stolen token receives a
correctly-signed credential for a target of their choosing. Confirmed by
running it — presenting a token minted for the identity provider while claiming
it was addressed to the billing server is refused with `subject token invalid:
InvalidAudienceError`.

Guard 2 is `widened`: set subtraction against what the subject actually holds,
because a narrowing mechanism that can widen is not a control.

The `may_act` check has a default worth knowing before relying on it.
`permitted is not None` means a subject token issued *without* a `may_act`
claim permits any actor at all — the constraint is opt-in where the user token
is minted, not where it is used.

The three narrowings happen together in the encoded payload: `aud` from the
requested resource, `scope` from the request, `exp` minutes out. Doing one and
not the others is the failure that reads as compliant, and the lab measures it
at 2 of 6 tools opened versus 1, with the refund inside the difference.

Deliberately omitted: the class body, `__init__` and the `_key` / `_issuer` /
`_lifetime` it sets, both docstrings, and `issue_user_token`, which mints the
broad credential this narrows — without which this does not run as printed.
Edits to disclose: the lab's two-line comments above the `aud` and `act` claims
are compressed to one-line trailing comments carrying the same RFC references,
and the `guard 1` and `exp` comments are mine.

**Source:** [Lab: Policy-Gated Tool Runtime](https://handbook.vinodspattar.in/build/labs/policy-gated-tool-runtime/), [Lab: Agent Identity Broker](https://handbook.vinodspattar.in/build/labs/agent-identity-broker/), [Architecture: Policy-Gated Tool Execution](https://handbook.vinodspattar.in/architecture/systems/policy-gated-tool-execution/), [`labs/policy-gated-tool-runtime`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/policy-gated-tool-runtime), [`labs/agent-identity-broker`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/agent-identity-broker)
