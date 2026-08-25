---
name: agent-authorization
description: You MUST load this before writing, reviewing, or discussing anything that lets an agent or model invoke a tool with real consequences — tool schemas and argument validation, scopes, grants, policy checks, human approval, delegated or on-behalf-of identity, token exchange, and audit trails. Applies to design and architecture questions with no code present.
---

# Agent Authorization

## Use this when

A model deciding to call a tool is a *request*, not an authorization. This
covers the code between the two: the dispatch table someone wired the model's
output into, the scope check in front of it, the approval that blocks on a
human, and the token the call carries.

One premise runs through every rule. **The model is not a trust boundary.**
Everything it was shown — the tool list, the descriptions, the schemas — is
input that shaped its output and constrains nothing about what arrives. The
runtime holds the contract, or nothing does.

## Rules

1. **Validate arguments at the runtime, against the runtime's own copy of the
   schema.** The schema in a tool listing is a prompt. It shapes what a
   well-behaved model emits; a hallucinating model or a client that is not the
   model at all sends whatever it likes. The diff is a `handler(arguments)`
   with nothing between it and the transport, or — subtler — a validator handed
   the schema that arrived with the call rather than the one the registry
   holds. Put the real bounds in that schema: `maximum` on a refund amount,
   `additionalProperties: false` so an extra argument cannot ride along. A
   bound enforced there is enforced before quota and before an operator's
   attention is spent.
2. **Run the scope check before the registry lookup**, so "does this tool
   exist" is not the difference between a 403 and a 404. A caller with no
   grants that can tell those two apart enumerates your tool surface by
   guessing names, and every probe lands in the audit log as an error rather
   than as a denial.
3. **Never treat a filtered listing as authorization.** Dispatch takes a name.
   A tool omitted from a caller's listing is still callable by that name unless
   a scope check says otherwise — the listing decides what the model knows
   about, the scope check decides what runs. Two different questions, two
   different code paths, and only one of them is a control.
4. **Validate before spending quota, and make the limiter's key include the
   tool and the principal whose scopes you checked.** Inverting the first lets
   a malformed call burn a well-behaved caller's budget. Dropping the tool from
   the key is the loud failure — a cheap read and an irreversible write on one
   budget means read traffic exhausts the allowance protecting the dangerous
   call, and raising the limit for reads quietly raises it for refunds. The
   principal is additive, not a substitution: a tenant in the key is doing real
   work, stopping one tenant drawing on another's bucket, but `(tenant, tool)`
   alone while scope is checked on `agent_id` means one agent's usage
   rate-limits its sibling and the agent you throttled is not the one that
   misbehaved. `(tenant, agent, tool)` buys both; keeping the tenant tier alone
   is defensible if you have decided that agents inside a tenant should
   contend, and indefensible if nobody noticed the two keys differ.
5. **Bound every approval wait and name the timeout's outcome per tool.**
   `await event.wait()` with no timeout around it is an availability bug
   wearing a security hat: the wait becomes bounded by human presence, and the
   first unavailable operator produces something that reads as a backend
   outage. Approval is also state — a pending approval that dies with its
   replica takes an in-flight request with it.
6. **Make risk a required field on the tool spec, with no default.** A
   `risk: RiskLevel = RiskLevel.LOW` means a tool registered by someone who
   never considered approval is ungated by omission, and the omission looks
   exactly like a complete registration.
7. **Write the audit entry before the raise, on every branch** — including the
   branch that fails before any policy ran. The question an audit answers is
   what was *attempted*, and the attempts worth seeing are the refused ones: an
   agent repeatedly reaching for a capability it was never granted is the
   clearest signal available that a grant is wrong or a caller is compromised.
8. **Record the refused arguments, redacted — and read what your error strings
   already carry.** Interpolating a validator's message into the audit detail
   ships the offending value verbatim, so the denials you never wanted stored
   contain the payload while scope and quota denials store nothing and cannot
   be investigated at all. Decide what is recorded rather than inheriting it
   from exception text.
9. **Return audit entries as a copy.** `return self._entries` hands the caller
   the log itself; append-only asserted in a docstring is not append-only.
10. **Derive the caller from a verified token, and enforce `aud` in the
    decoder's configuration rather than after it.** A header the client sets
    makes scope, quota, approval routing, and audit attribution decorative
    simultaneously. And a `verify_aud: False` followed by a hand-rolled
    `claims["aud"] == me` is how audience verification gets removed during
    debugging and never restored — it has no runtime symptom, so only a test
    that fails when the check disappears holds it in place.
11. **Narrow scope at the exchange, not only audience, and deny widening.**
    Requesting the subject token's whole scope set because computing the
    minimum is work leaves the narrowing machinery present and the narrowing
    absent, and it audits as compliant. Check `may_act` too, and note that a
    subject token issued without that claim permits *any* actor to act for that
    user.
12. **Pin the provenance of a tool description you did not write.** It enters
    the model's context, which makes a hostile tool source a prompt-injection
    vector arriving through metadata, past every filter aimed at the user's
    message. Hash the description at registration and treat a change as a code
    change, not a cache refresh.

## Deciding

| Situation | Do this | Because |
| --- | --- | --- |
| The policy store is unavailable | Decide per tool: irreversible tools fail closed, read-only tools may fail open with loud alerting | A single global answer is the sign of a policy nobody designed. Closed turns a store outage into an agent outage; open turns it into a silent authorization bypass, which is only survivable where the blast radius is a read |
| An approval times out | Deny, unless the escalation target is genuinely more available | Denial is safe and makes operator unavailability visible to the user. Escalation keeps the request alive and extends the wait, so it buys nothing against a rota that is asleep. The wrong answer is no timeout, which converts a policy decision into a hang |
| Grants are multiplying past what per-tool entries can carry | Roles composed of explicit tool grants | Keeps "which tools does this role open" answerable by reading it, which is what opaque role labels lose — and that is exactly the question an audit asks. Per-tool grants stay more precise and stop scaling |
| Calls can arrive by more than one path | Enforce inside the tool runtime, not at a protocol gateway | A gateway is easier to deploy in front of servers you do not own, and is bypassed by any path that does not traverse it. Runtime enforcement also survives a protocol revision, which MCP has already spent — none of these checks was ever a protocol concern |
| An agent needs several services on a user's behalf | One exchanged token per service, audience-bound and scope-narrowed, minutes long | "Narrow scope at the exchange, not only audience" — measured on the identity lab's six-tool fixture fleet, one audience plus one scope opens 1 tool; the same audience with the user's full scope set opens 2, the refund among them. Forwarding the user's token is free, and prohibited outright toward an MCP server |
| A long task outlives its token | Refresh ahead of expiry and make mid-task expiry a handled path | Extending the lifetime to cover the task is the change that undoes the control. Discovering expiry through a `401` mid-call costs a failed call plus a retry, and that retry has to be safe to make |

## Going deeper

| Read | When |
| --- | --- |
| [references/architecture.md](references/architecture.md) | Designing the enforcement layer, or placing identity, cost, and observability in it |
| [references/failure-modes.md](references/failure-modes.md) | A call ran that should not have, or a refusal cannot be explained |
| [references/patterns.md](references/patterns.md) | You need the shape of the check pipeline, a token exchange, or server-side token validation |
| [references/review-checklist.md](references/review-checklist.md) | Reviewing someone's tool gateway, registry, approval flow, or token handling |
