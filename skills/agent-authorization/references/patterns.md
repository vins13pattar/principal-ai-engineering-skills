# Patterns

Four excerpts, each naming its file: two from
`labs/policy-gated-tool-runtime/src/tool_gateway/` (what a known caller may
do) and two from
`labs/agent-identity-broker/src/agent_identity/` (who the caller is). The labs
share no code and nothing below is composed across them. All four were verified
by binding them over the originals and running each lab's suite, baselines
first: 44 tests in the tool runtime, 22 in the identity broker.

Both labs are `production-shaped` and each simulates something different. In
the tool runtime, registry, rate limiter, approval queue, and audit log are all
in-memory and single-replica and caller identity is a spoofable `x-agent-id`
header — the pipeline transfers, none of the storage does. In the identity
broker the identity provider is simulated: an in-memory RSA keypair per
process, **no JWKS endpoint and no rotation**, no OIDC flow, no revocation
beyond short lifetimes, no HTTP transport. So in the second pair
`key=self._issuer_public_key` stands in for a fetched, cached, rotating JWKS —
a real deployment adds a bounded cache TTL and a rotation path, and getting it
wrong makes a rotation against a warm cache look exactly like a forged token.

## The five checks, and the audit fan-in

From `gateway.py` in the tool runtime. Each stage runs cheapest-first, and
every branch writes to the log before it re-raises.

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

Copy the first `try` block's structure and not its position. `registry.get()`
runs ahead of the scope check, so an ungranted tool and an unknown tool raise
different errors, mapped to `403` and `404` at the HTTP edge. Confirmed by
running it: a caller holding no scopes gets `ScopeDeniedError` for a registered
tool and `ToolNotFoundError` for an invented one — a name-enumeration oracle
for the surface the ordering was meant to conceal. Those probes also record as
`ERROR` rather than as a denial, filing the activity most worth counting under
the most generic outcome.

`if spec.risk is RiskLevel.HIGH` matters because the default is `LOW`: a tool
registered by someone who never considered approval is ungated, and reads
exactly like one where the question was asked and answered.

The denial arm repeats on every branch because it must. `_deny` sends
`agent_id`, `tenant_id`, `tool_name`, `outcome`, and `detail` to
`AuditLog.record` — no arguments. `detail` is whatever `str(exc)` produced,
which on the validation branch is the validator's message. Run against a
`ToolSpec` I built for the measurement (the lab registers
`search_knowledge_base` and `issue_refund`, not this) it produced `invalid
arguments for tool 'search_docs': {'secret': 'sk-live-abcdef'} is not of type
'string'` — the branch you would never have chosen to store keeps the payload
verbatim, while scope and quota denials keep nothing and are uninvestigable.

Deliberately omitted: the `class ToolGateway:` header — the missing header is
why this does not compile as printed — plus `__init__` and `_deny` itself.
Edits to disclose: the `started` / `latency_ms` timing is removed; the
`rate_limiter.acquire` call, the `approvals.request` arguments, the handler-
error `detail`, and the final `record(...)` are reflowed onto fewer lines with
no change to the arguments; the three trailing comments are mine.

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
the schema comes from the registry by name — never from the request, never from
what the model was shown. That is the difference between a prompt and a
contract, and in a diff it is one argument.

Only `get` is on the enforcement path. Dispatch takes a name, so a tool
withheld from a caller's listing is still callable by it; `list()` hands every
spec to every caller, which is fine precisely because filtering it was never
the control. Filtering a listing for security means the scope check is missing.

Bounds belong in the schema. The lab's `demo.py` gives `issue_refund` a
`"maximum": 10_000` and `"additionalProperties": False` — the two things a
generated schema reliably omits, and both matter for where they sit: an out-of-
range refund is refused here, before quota is spent and before an operator is
woken.

Deliberately omitted: `register`, `handler_for`, `__init__` and the `_specs` /
`_handlers` it declares, the class docstring, and the imports including
`jsonschema` — so this compiles as printed but the class has no state.

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

`audience=self.identity` inside the decode call, rather than a `claims["aud"]
== self.identity` after it, is the load-bearing line. The manual version keeps
working after somebody sets `verify_aud: False` to unblock a staging session,
and there is no runtime symptom — the server stays functional and enforces its
policy against tokens minted for other people. The lab reports that flipping
that one option makes six tests fail across three files; reproduced here, and
restoring it returns all 22 to green.

Four `except` arms exist because the audit log needs to say which invariant
broke; the wire gets a bare `401` or `403`, since telling the caller turns the
endpoint into an oracle for probing what a stolen token is missing. `authorize`
stays separate for the same reason — audience gets you in the door and says
nothing about which room, and the split is what distinguishes "not addressed to
me" from "addressed to me, not entitled to this". Both run per invocation, not
per connection: a stateless protocol has no session to have decided on. Note
`actor` is optional — a token with no `act` claim authenticates fine and audits
as just the user.

Deliberately omitted: the `class ResourceServer:` header — the missing header
is why this does not compile as printed — plus `__init__` and the `identity` /
`_trusted_issuer` / `_issuer_public_key` it sets, the module and class
docstrings (the module's lists the five checks), `call_tool` (which is
`authenticate` then `authorize`), and the imports. Edits to disclose: the lab's
comment on the `InvalidAudienceError` arm is dropped, both method docstrings
are removed, and the two comments on the `audience` and `issuer` lines are
mine.

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
names *this* broker as its audience stops the broker being an escalation
service: without it, anyone holding any stolen token receives a correctly-
signed credential for a target of their choosing. Confirmed by running it — a
token minted for the identity provider, presented as though addressed to the
billing server, is refused with `subject token invalid: InvalidAudienceError`.

Guard 2 is `widened`: set subtraction against what the subject actually holds,
because a narrowing mechanism that can widen is not a control. `may_act` has a
default worth knowing before relying on it — `permitted is not None` means a
subject token issued *without* the claim permits any actor at all, so the
constraint is opt-in where the user token is minted, not where it is used.

The three narrowings happen together in the encoded payload — `aud` from the
requested resource, `scope` from the request, `exp` minutes out. Doing one and
not the others reads as compliant; the lab measures that at 2 of 6 tools opened
versus 1, refund inside the difference.

Deliberately omitted: the `class TokenBroker:` header — the missing header is
why this does not compile as printed — plus `__init__` and the `_key` /
`_issuer` / `_lifetime` it sets, all three docstrings (module, class, and
`exchange`'s own), `issue_user_token`, the `GRANT_TYPE` constant naming the RFC
8693 grant, and the imports (`datetime as dt`, `jwt`, `ExchangeRequest`,
`ExchangeDenied`, `ALGORITHM`). Edits: the lab's two-line comments above the
`aud` and `act` claims are compressed to one-line trailing comments carrying
the same RFC references, its two-line comment above the widen denial ("The
whole point of the exchange is narrowing…") is dropped entirely, and the
`guard 1` and `exp` comments are mine.

**Source:** [Lab: Policy-Gated Tool Runtime](https://handbook.vinodspattar.in/build/labs/policy-gated-tool-runtime/), [Lab: Agent Identity Broker](https://handbook.vinodspattar.in/build/labs/agent-identity-broker/), [Architecture: Policy-Gated Tool Execution](https://handbook.vinodspattar.in/architecture/systems/policy-gated-tool-execution/), [`labs/policy-gated-tool-runtime`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/policy-gated-tool-runtime), [`labs/agent-identity-broker`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/agent-identity-broker)
