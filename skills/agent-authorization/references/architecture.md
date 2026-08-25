# Policy-gated tool execution architecture

## The problem the design exists to solve

A model deciding to call a tool is a request. The naive architecture wires that
request straight into a dispatch table, producing a system whose effective
permission set is whatever the model can be talked into — by a user, by a
retrieved document, or by a tool description somebody else wrote — and whose
blast radius is every capability any agent was ever given.

What is needed is a layer between the decision and the action, answering five
separate questions in a fixed order. They stay separate because each fails
differently, and collapsing any two produces a system permissive in one
direction and brittle in the other. Scope and schema are the pair usually
collapsed: "may this caller use this tool at all" and "is this particular call
well-formed" are different questions, and neither substitutes for the other.

Underneath sits a prior question the enforcement layer cannot answer for
itself: **on whose authority, and as whom?** Every control here is scoped by
caller, so identity is not one more check alongside the others — it is the
thing that makes the others mean anything.

## Requirements worth writing down

- **Capability scope.** A caller may only invoke tools it was explicitly
  granted.
- **Argument validation.** Every call is checked server-side against the
  server's own copy of the schema, regardless of what the model was shown.
- **Per-tool quota.** Limits are owned by the tool, not shared across the
  platform.
- **Human approval for high-risk actions**, with a bounded wait and a defined
  timeout behaviour.
- **Complete audit.** Every attempt is recorded with its outcome, including —
  especially — refusals.
- **Attributable identity.** Every decision is tied to a verified caller, and
  the record distinguishes the agent from the human it acted for.

## Constraints that decide the design

- **The model is not a trust boundary.** Descriptions and schemas shown to a
  model are hints that shape its output; they constrain nothing. Every check
  must hold against an adversarial caller as well as a confused one.
- **Tool descriptions are untrusted input.** They enter the model's context, so
  a compromised or hostile tool source is a prompt-injection vector — the same
  risk class as user input, arriving through metadata.
- **Approval blocks a request.** Any human-in-the-loop step introduces a wait
  bounded only by human availability, so it must have a timeout and a defined
  outcome when it fires.
- **Identity must be verified, not asserted.** A forgeable caller identity
  voids scope, quota, approval routing, and audit attribution simultaneously,
  and the system looks correct in every test that does not try to forge it.
- **A signed token proves only that someone with the signing key issued it.**
  It says nothing about who it was issued *for* until audience is checked,
  nothing about what it permits until scope is checked, and nothing about
  currency until expiry is checked.

## Request flow

Two paths meet at the tool. First, the credential, as transitions rather than
a diagram:

1. **The user authenticates** and the host receives a token whose audience is
   the host, carrying the user's full permission set for the length of a
   session.
2. **The host exchanges it** (RFC 8693) before touching any server, presenting
   the subject token, an actor identity for the agent, and a `resource`
   parameter (RFC 8707) naming the target server's canonical URI.
3. **The authorization server refuses to launder.** It verifies the subject
   token was addressed to *it* before minting anything — without that check,
   any stolen token buys a correctly-signed credential for a target of the
   presenter's choosing.
4. **It refuses to widen.** Scopes not held by the subject are denied; a
   narrowing mechanism that can widen is not a control. `may_act` in the user's
   token, if present, constrains which actors may act for them, checked here
   rather than at use time.
5. **It mints an agent token**: `aud` is the one server, `scope` is what this
   task needs, `act` names the agent, `exp` is minutes away.

Then, at the server, five checks on the token and five on the call. The token
checks — signature, trusted issuer, expiry, `aud` names this server, `scope`
covers this tool — run per request, because a stateless protocol has no
session on which to have decided them earlier. The call checks follow:

6. **Scope**, first, because it is the cheapest and most absolute. A caller
   with no grant should never reach argument validation — to avoid the work,
   and to avoid schema errors describing a tool it is not entitled to know
   exists.
7. **Schema validation**, before quota, so a malformed call cannot consume a
   well-behaved caller's budget. Inverting these lets an attacker exhaust a
   victim's allowance with garbage.
8. **Quota**, per caller and per tool.
9. **Approval**, last, because it is the only stage that blocks on a human and
   there is no point paying that latency for a call a cheaper check would have
   rejected.
10. **The handler runs**, and **every outcome above — allowed or denied —
    reaches the audit log.**

Step 6's ordering claim has a leak worth knowing about, because it is easy to
reproduce and easy to miss: if the registry lookup runs ahead of the scope
check, an unknown tool and an ungranted tool return different errors, and the
information the ordering was designed to withhold leaks through the status code
instead of through the schema message.

## What a narrowed credential actually buys

The identity-broker lab measures the comparative claim rather than asserting
it: `blast_radius.measure()` walks one token against every tool on every server
in a fleet and counts what opens.

| Credential | Tools opened, out of 6 |
| --- | --- |
| Agent-scoped: one audience, one scope | 1 |
| Audience narrowed, scope not narrowed | 2 — both tools on that server, refund included |
| The raw user token, forwarded | 0 — no server accepts it |

Measurement conditions matter here. The fleet is a fixture — three servers, six
tools, one destructive — with a deliberately broad five-scope "support
engineer" grant, all defined in the lab's `demo.py`. These are counts over that
fixture, not a production inventory.

Two readings. The middle row is the one to sit with: narrowing the audience
without narrowing the scope gets you half the protection and reads as compliant
in a design review. The bottom row is the unflattering one — a forwarded user
token opens *nothing*, because its audience names the identity provider.
Passthrough is not dangerous for what it opens directly; it is dangerous for
what it hands to whoever receives it.

## Scaling

- **Quota state is the coordination point.** In-process token buckets multiply
  a caller's effective limit by the replica count. A shared atomic limiter is
  what makes the limit mean one thing.
- **Approval is a stateful island in a stateless service.** Pending approvals
  must outlive the replica that accepted them, or a deploy silently drops every
  in-flight request awaiting a human.
- **Audit write volume grows with attempts, not successes**, and refusal storms
  are exactly when the log matters most — so the audit path must not be the
  thing that fails under attack.
- **Registry reads are hot and change rarely**, which makes them cacheable, and
  makes cache invalidation the mechanism by which a revoked grant actually
  takes effect.
- **Schema validation cost scales with payload size**, so a large-argument tool
  deserves a size cap before the validator, not after it.
- **Scope definitions are the real limit on the identity side.** Each new tool
  needs a scope and each new agent a defensible minimum set; without a naming
  convention this becomes unauditable sprawl faster than the tool count
  suggests.
- **The authorization server becomes a critical dependency**, since exchange
  sits on the path to first use of every resource. Local validation against
  cached keys is what keeps it off the path for *every* call.

## Security

Most of this domain's security advice is the generic kind. Four things here are
specific enough to change a diff:

- **Verify caller identity from a signed token or mTLS-derived principal**, and
  enforce audience inside the decoder's configuration — a `verify_aud: False`
  plus a manual comparison is how the check disappears and stays gone.
- **Never accept or transit a token minted for someone else**, even to be
  helpful; passing it on is what makes you the deputy. Keep tokens out of
  URLs — they land in access logs, proxy logs, and browser history.
- **Return opaque failures.** `401`/`403` with no detail; which of the checks
  failed goes to the audit log only, because telling the caller turns the
  endpoint into an oracle for probing what a stolen token is missing.
- **Make the audit log append-only and separately access-controlled**, and
  record refused arguments subject to redaction — a refusal without its input
  is not investigable.

## Cost

- **Approval latency is the dominant cost** for gated tools, and it is
  human-scale. Anything routed through approval should be genuinely
  consequential, or the gate trains operators to rubber-stamp — at which point
  it costs latency and buys nothing.
- **Audit storage grows with attempt volume**, refusals during an attack
  included: the worst time to be rate-limited by your own logging bill.
- **Validation is cheap relative to what it prevents**, but a large-payload
  tool can make it measurable. Cap sizes rather than skip checks.
- **Per-tool quotas are a spend control**, not only an abuse control, once
  tools call paid APIs.
- **The exchange is a round trip on the critical path** the first time an agent
  touches a resource. Cache the result for its short lifetime, keyed by
  audience *and* scope set — keyed by user alone it hands back a token for the
  wrong server.

## Observability

- **Refusals by reason, per caller, per tool.** Scope denial, schema failure,
  quota exhaustion, approval denial, and approval timeout are five different
  operational problems that look identical in an aggregate error rate.
- **Approval queue depth and wait-time distribution, with the timeout marked.**
  A p95 wait near the timeout means the gate is about to start denying
  legitimate work.
- **Quota exhaustion rate per tool**, which distinguishes a caller hitting a
  fair limit from a limit set wrong.
- **Schema failure rate by tool**, a leading indicator that a tool's schema and
  its handler have drifted apart.
- **Audit write failures, alerted on.** An enforcement layer that stops
  recording is worse than one that stops enforcing, because it fails silently.
- **Token rejections split by which invariant broke.** Audience, expiry, and
  issuer failures have entirely different causes — a spike in audience
  rejections is somebody pointing a credential at the wrong server or replaying
  a stolen one; a spike in expiry rejections is a task running past its token.

## Trade-offs

**Fail-closed vs. fail-open when the policy store is unavailable.** Failing
closed protects the capability surface and turns a policy-store outage into a
full agent outage. Failing open preserves function and means an outage silently
disables authorization. For tools with irreversible effects, closed is the only
defensible default; for read-only tools, open with loud alerting is a
legitimate choice. Deciding per tool rather than globally is what makes the
trade honest — a single global answer is the sign of a policy nobody designed.

**Approval timeout: deny or escalate.** Denying is safe and turns operator
unavailability into user-visible failure. Escalating keeps the request alive
and extends the wait, which is only useful if the escalation target is
genuinely more available. The wrong answer is no timeout at all, which converts
a policy decision into an unbounded hang.

**Per-tool grants vs. role-based grants.** Per-tool grants are precise and
audit cleanly, and grow unmanageable as tools multiply. Roles compress the
grant matrix and introduce the classic problem of a role accumulating
capabilities nobody intended. Roles composed of explicit tool grants — rather
than roles as opaque labels — keep auditability while bounding the growth.

**Enforcing in the runtime vs. at the protocol boundary.** Enforcing inside the
tool runtime means the checks apply however the call arrives — MCP, HTTP, or an
in-process interface — which is why this architecture is deliberately
protocol-independent. Enforcing at a protocol gateway is easier to deploy in
front of servers you do not control, and gets bypassed by any path that does
not traverse it. The protocol-independence is not theoretical: MCP's
`2026-07-28` revision removed the `initialize` handshake and protocol-level
sessions and deprecated the HTTP+SSE transport, and none of it touches a
pipeline whose checks were never protocol concerns.

**Agent-scoped tokens vs. on-behalf-of everywhere.** Exchanging per server and
per task bounds the blast radius, makes actions attributable to the agent, and
allows revoking an agent without disabling a person. It costs a round trip on
first use of each resource, requires an authorization server that supports RFC
8693, and forces you to decide what the minimum scope actually is — real design
work, not configuration. On-behalf-of remains right where the chain is short,
inside your trust boundary, and not chosen at runtime by a model; all three
stop being true of agents, which is why the default inverts.

**Source:** [Architecture: Policy-Gated Tool Execution](https://handbook.vinodspattar.in/architecture/systems/policy-gated-tool-execution/), [Lab: Policy-Gated Tool Runtime](https://handbook.vinodspattar.in/build/labs/policy-gated-tool-runtime/) (the enforcement-pipeline diagram, which supplied the check ordering and the audit fan-in), [Lab: Agent Identity Broker](https://handbook.vinodspattar.in/build/labs/agent-identity-broker/) (the exchange-path diagram, which supplied the broker-side guards and the five server-side checks), [Module 15: Agent Identity and Access](https://handbook.vinodspattar.in/learn/modules/15-agent-identity/) (including its token-exchange diagram, which supplied the passthrough branch), [`labs/agent-identity-broker`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/agent-identity-broker) (`blast_radius.py` and the `demo.py` fixture the counts are measured over)
