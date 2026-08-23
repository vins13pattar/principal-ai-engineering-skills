# Review checklist

Ordered by what the failure costs, not by where it appears in the file. The
first four decide whether the enforcement layer is a control or a decoration,
and all four pass a casual read because each looks like a solved problem. Stop
and comment at the first failing answer in that section. The later sections are
grouped by topic and every question in them is worth asking regardless.

## The four that decide whether any of it is real

1. **Where does the caller identity come from?** *Failing answer:* a header, a
   query parameter, or a field in the request body. Every control below is
   scoped by caller, so a forgeable identity voids scope, quota, approval
   routing, and audit attribution simultaneously — and it passes every test
   that does not try to forge it. Look for a signed token or an mTLS-derived
   principal.

2. **Is `aud` enforced by the decoder's configuration, or checked after
   decoding?** *Failing answer:* `verify_aud: False` anywhere, or a
   `claims["aud"] == me` comparison following a decode that was told to skip
   audience verification. The manual form keeps working after somebody disables
   the option to unblock a staging session, and there is no runtime symptom —
   the server stays functional and enforces its policy against tokens minted
   for other people. Then ask for the test that fails when the check
   disappears; without one, the protection is an assumption.

3. **Are arguments validated at the runtime, against the runtime's own copy of
   the schema?** *Failing answer:* a handler invoked directly on the decoded
   request body, or a validator handed the schema that arrived with the call.
   The schema in a tool listing shapes what a well-behaved model emits and
   constrains nothing about what arrives. Then read the schema itself: no
   `additionalProperties: false` means an extra key rides into the handler, and
   no bound on a money field means the only limit on a refund is whatever the
   handler happens to check after the approval was already granted.

4. **Does the scope check run before the registry lookup?** *Failing answer:* a
   lookup that raises "not found" ahead of the grant check, so an unknown tool
   and an ungranted tool return different statuses. That is a name-enumeration
   oracle for the tool surface, and the probes land in the log as errors rather
   than as denials. Separately: is anything relying on a filtered tool listing
   as a control? Dispatch takes a name, so a tool omitted from a listing is
   still callable by it.

## Then, in blast-radius order

5. **What is the token's audience, scope, and lifetime — and were all three
   narrowed?** *Failing answer:* the user's token forwarded unchanged, which an
   MCP server must reject outright; or an exchange that requests whatever
   scopes the subject holds because computing the minimum was work. Narrowing
   the audience alone reads as compliant and buys half the protection: on the
   identity lab's six-tool fixture fleet, one audience plus one scope opens one
   tool, and the same audience with the user's full scope set opens two,
   including the refund.

6. **Can the exchange widen?** *Failing answer:* a broker that mints what it is
   asked for. Requesting scopes the subject does not hold must be denied, and
   the broker must verify the presented subject token was addressed to *it*
   before minting anything — without that, any stolen token buys a
   correctly-signed credential for a target of the attacker's choosing. Check
   `may_act` too, and note that a user token issued without that claim permits
   any actor at all.

7. **Is every approval wait bounded, and what happens when the bound fires?**
   *Failing answer:* an `await` on an operator decision with no timeout around
   it — a policy control that turns into an unbounded hang and presents as a
   backend outage. Also failing: a timeout whose outcome is the same for a
   read-only tool and an irreversible one. Deny or escalate is a per-tool
   decision, recorded with the tool.

8. **How does a tool end up requiring approval?** *Failing answer:* a risk or
   `requires_approval` field that defaults to the permissive value, so a tool
   registered by someone who never considered the question is ungated, and the
   omission is indistinguishable from a deliberate choice. Make it required.

9. **Where does a pending approval live?** *Failing answer:* in the memory of
   the replica handling the request. A deploy then silently drops every
   in-flight call awaiting a human. Ask about the notification path too —
   approvals nobody is told about are approvals that time out.

10. **What key does the rate limiter use, and where does the bucket live?**
    *Failing answer:* a budget shared across tools, so read traffic can exhaust
    the allowance protecting an irreversible call and raising the limit for
    reads raises it for refunds. Also failing quietly: a scope checked on the
    agent against a bucket keyed on the tenant, which throttles one agent for
    its sibling's behaviour. And an in-process bucket multiplies every
    configured limit by the replica count.

11. **Does the policy store's unavailability have a per-tool answer?**
    *Failing answer:* one global setting, either way. Irreversible tools fail
    closed; read-only tools may fail open with loud alerting. A single answer
    for both is the sign of a policy nobody designed.

12. **Where do tool descriptions come from, and what happens when one
    changes?** *Failing answer:* a third-party description served straight into
    the model's context, refreshed silently. It is prompt injection arriving
    through metadata, past every filter aimed at the user's message. Look for a
    hash pinned at registration and a change that requires the same review a
    code change gets.

## Audit — last but always

13. **Is an entry written on every branch, including the one that fails before
    any policy ran?** *Failing answer:* denials logged only where policy
    rejected, so probing for tool names records as a generic error or not at
    all — and that is the activity most worth counting. Check that the reason
    is a distinct outcome value, not a string inside an error field: scope
    denial, schema failure, quota exhaustion, approval denial, and approval
    timeout are five different operational problems.

14. **What arguments does a denial carry?** *Failing answer:* none, which makes
    a refusal uninvestigable — or, on the validation branch, an interpolated
    validator message carrying the offending value verbatim and unredacted. The
    default is usually both at once. Decide what is recorded rather than
    inheriting it from exception text.

15. **Is the log actually append-only?** *Failing answer:* a reader that
    returns the internal collection by reference, so any caller can edit the
    record of its own refusals. Also: is it separately access-controlled, and
    does a write failure alert? An enforcement layer that stops recording is
    worse than one that stops enforcing, because it fails silently.

16. **Can the log distinguish the agent from the human?** *Failing answer:* an
    entry naming only the user. Then nothing separates a person clicking a
    button from an agent deciding to act on their behalf at 3am, which is the
    difference between an incident you can explain and one you cannot.

## Cost and operability — last but always

17. **Is what goes through the approval gate genuinely consequential?**
    *Failing answer:* a gate on so many tools that operators approve by reflex.
    Approval latency is human-scale, and a rubber-stamped gate costs the
    latency and buys nothing.

18. **Can an agent be revoked without disabling a person?** *Failing answer:*
    "we disable the user account." Already-issued tokens stay valid until
    expiry, and an agent with its own client credentials can still mint more.
    Revocation needs an agent-level identity to act on, and short lifetimes are
    what make it tractable without a distributed revocation list.

19. **What happens when a token expires mid-task?** *Failing answer:* a
    lifetime extended to cover the longest task — the change that undoes the
    control. Look for refresh ahead of expiry, and a retry after a mid-call
    `401` that is safe to make.

**Source:** [Architecture: Policy-Gated Tool Execution](https://handbook.vinodspattar.in/architecture/systems/policy-gated-tool-execution/), [Module 15: Agent Identity and Access](https://handbook.vinodspattar.in/learn/modules/15-agent-identity/), [Lab: Policy-Gated Tool Runtime](https://handbook.vinodspattar.in/build/labs/policy-gated-tool-runtime/), [Lab: Agent Identity Broker](https://handbook.vinodspattar.in/build/labs/agent-identity-broker/)
