# Failure modes

Symptom first, because that is what you have when someone reports it. The first
two are how an unauthorized call happens; the middle two are how a control
turns into an outage; the last two are how you fail to find out. Ordered by
what the failure costs.

## Trusting the schema the model was given

**Presents as:** a handler that received arguments it was never written to
accept — a refund of an amount nobody could enter through the product, a field
the handler reads as a string arriving as an object, an extra key riding along
into a `**kwargs`. It surfaces as a handler crash if you are lucky, and as a
completed action if you are not.

**Cause:** "the model was given the schema" treated as a guarantee. The schema
in a tool listing shapes what a well-behaved model emits and constrains nothing
about what arrives. One hallucinated argument, or one client that is not the
model at all, is the whole distance between those two statements. The subtler
version validates — against the schema that came in with the call, or against a
copy fetched from the same place the model's listing came from, which is the
same trust boundary wearing a validator.

**Do:** validate at the runtime, against the runtime's own copy, before any
handler runs. Then put the real constraints in that copy rather than in the
handler: `maximum` on a money amount, `minLength` on an identifier,
`additionalProperties: false` so an unexpected key is a rejection rather than a
silent pass-through. Two consequences follow from where that check sits. A
value bound in the schema is refused before quota is spent and before an
operator's attention is spent, so an out-of-range refund never reaches a human.
And the model's copy of a tool's metadata is then free to be a simplification
of the runtime's, because only one of them is the contract.

## Tool poisoning through descriptions

**Presents as:** an agent doing something plausible-looking and wrong across
many sessions, with no bad user input anywhere in the transcript. Every input
filter passed, because nothing arrived through the user's message.

**Cause:** a tool description is part of the model's context. A hostile or
compromised tool source writes one crafted to steer behaviour well beyond what
the tool does, and it arrives as trusted metadata rather than as a prompt. The
registry makes this easy to overlook by storing description and schema in the
same record: one of them is enforcement material and the other is text
injected into a model, and nothing in the type distinguishes them.

**Do:** treat provenance as a property you record, not an assumption. Hash a
description at registration, and make a change to it fail closed — the same
review a code change gets, rather than propagating on the next listing refresh.
For any tool whose description you did not write, that pin is the only thing
standing between a supplier's edit and your agent's behaviour. A registration
path that accepts a third-party description and immediately serves it is a
remote-write into your prompt.

Then bound what a poisoned description can achieve, which is the part that
actually holds. A description can only change what the model *asks for*; it
cannot grant anything. So the review question is whether any control is
description-derived: a scope granted by tool name, a schema held by the
registry, and a risk level declared with the tool are all immune to a supplier
editing prose. A gate that reads "requires approval" out of the description, or
a scope inferred from what a tool says it does, hands the attacker the control
along with the text.

## Approval with no timeout

**Presents as:** a backend outage. Requests accumulate holding connections and
context, latency climbs, and nothing in the dashboards says "policy" — the
system degrades exactly as it would under a slow dependency, which sends the
investigation to the wrong place first.

**Cause:** an approval wait bounded only by human availability. `await` on an
event with no timeout around it is the whole bug, and it never fires in testing
because a test always decides. The first genuinely unavailable operator is the
first execution of that path.

**Do:** bound the wait, and make the timeout's outcome a per-tool decision
recorded with the tool — deny, or escalate to a target you can defend as
actually more available. Then treat approval as the stateful thing it is: a
pending record living in one replica's memory dies with that replica and takes
an in-flight request with it, so a deploy silently drops every call awaiting a
human. Track wait-time distribution against the timeout, because the day p95
approaches it is the day the gate starts denying legitimate work, and it
arrives gradually.

## Shared quota across tools of different consequence

**Presents as:** either an irreversible tool being callable far more often than
anyone intended, or a read-heavy agent starving a colleague's ability to do
anything at all. Which one you see depends on which way the budget was sized.

**Cause:** one budget spanning tools of different consequence. A cheap read and
a fund-moving write drawing on the same allowance means read traffic can
exhaust what was protecting the dangerous call — and, worse, raising the limit
to accommodate reads quietly raises it for refunds. There is a quieter version
of the same mistake in the key rather than the capacity: a scope checked on the
agent and a bucket keyed only on the tenant means one agent's usage rate-limits
its sibling. The agent you throttled is not the agent that misbehaved, and the
audit log — keyed on the agent — will not explain why.

**Do:** give each tool its own capacity, declared with the tool, and make the
key include the tool and the principal whose scopes were checked. Additive, not
substitutive: the tenant tier is doing real work — it is what stops one tenant
drawing on another's bucket — so `(tenant, agent, tool)` is the shape that buys
both, and dropping the tenant to add the agent trades one unfairness for
another. Agents inside a tenant contending is a legitimate choice; it is only a
defect when nobody noticed the two keys differ. In more than one replica the
bucket has to be shared atomic state; in-process buckets multiply every limit
by the replica count, which means the number in the config was never the limit.

## An audit log that records only successes

**Presents as:** nothing, until an incident. Then the question is "what did
this agent try to do", and the log answers only what it managed to do — which
excludes every interesting event.

**Cause:** denials treated as rejected requests to discard rather than as the
signal. An agent repeatedly reaching for a capability it was never granted is
the single clearest indication available of either a compromised caller or a
badly scoped grant, and it produces no successful call to record. The partial
version is more common than the total one: the policy stages log their
denials, and the branch that fails *before* any policy runs — an unknown tool
name — logs an error or nothing, so probing for what exists is the one activity
the log does not characterise as an attempt.

**Do:** record before you raise, on every branch, with the reason as a distinct
outcome rather than a string in a generic error field. Then decide what
arguments the entry carries, because the default is worse than either
extreme: scope and quota denials store no arguments and are consequently
uninvestigable, while a validation denial that interpolates the validator's
message stores the offending value verbatim, unredacted. Redact deliberately
and record on purpose. And make the log actually append-only — a `list()` that
returns the internal collection by reference hands every caller the ability to
edit the record of its own refusals.

## Caller identity from an unverified header

**Presents as:** nothing at all, in any test that does not try to forge it. The
system is fully functional and completely unprotected, and every control in it
looks implemented.

**Cause:** identity asserted rather than verified. Every check here is scoped by
caller, so a header any client can set makes scope, quota, approval routing,
and audit attribution decorative simultaneously — one line of configuration
defeating five controls. The version of this that survives review is subtler: a
real signed token, decoded with audience verification switched off during a
staging incident and a hand-rolled `claims["aud"] == me` left in its place. That
comparison keeps working, nothing looks wrong, and the server will now happily
enforce excellent policy against a token minted for somebody else.

**Do:** derive the principal from a signed token or an mTLS-derived identity,
and let the decoder enforce audience, issuer, and expiry from its own
configuration, where absence is visible, rather than from a conditional that
can be quietly inverted. Check scope per invocation rather than per connection;
a stateless protocol has no session to have decided it on. Return `401`/`403`
with no detail and put which invariant broke in the log only, or the endpoint
becomes an oracle for probing what a stolen token is missing. Then write the
test that fails when the check disappears: audience verification has no runtime
symptom, so a test is the only thing holding it in place. In the identity lab,
disabling it makes exactly six tests fail across three files — a number worth
knowing precisely because a security test that has never failed is
indistinguishable from one that cannot.

**Source:** [Architecture: Policy-Gated Tool Execution](https://handbook.vinodspattar.in/architecture/systems/policy-gated-tool-execution/), [Module 15: Agent Identity and Access](https://handbook.vinodspattar.in/learn/modules/15-agent-identity/), [Lab: Policy-Gated Tool Runtime](https://handbook.vinodspattar.in/build/labs/policy-gated-tool-runtime/), [Lab: Agent Identity Broker](https://handbook.vinodspattar.in/build/labs/agent-identity-broker/), [`labs/policy-gated-tool-runtime`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/policy-gated-tool-runtime) (`audit.py`, `rate_limit.py`, and the `ToolSpec` defaults in `models.py`)
