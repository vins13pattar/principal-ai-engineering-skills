# Failure modes

Symptom first, because that is what you have when someone reports it. Ordered
by what the failure costs rather than by where it sits in the lifecycle — the
first three all present as an application bug and are all configuration or
policy, which is why they get investigated in the wrong place.

## Idempotent submission mistaken for idempotent execution

**Presents as:** duplicate side effects — a customer charged twice, an email
sent twice, a row written twice — under load, after a deploy, or during a
dependency wobble. Never in testing, because it needs a delivery to happen
twice, and nothing in a happy-path test does that.

**Cause:** the idempotency key was shipped and the problem declared solved. The
key deduplicates *submissions* into one task. At-least-once delivery guarantees
that one task still executes more than once, and the two concerns have no
relationship beyond sharing a word. A team that conflates them has built a
system that double-charges under exactly the conditions that matter.

**Do:** give the handler its own idempotency, derived from something stable
across deliveries — the task ID plus an operation name — and never from the
attempt number, which changes on every redelivery and so defeats the whole
mechanism. Push the check into the system holding the effect, so the duplicate
is rejected where the state lives rather than where the code hopes. Then prove
it: run the handler twice on one task and assert one effect. Both mechanisms
are required and neither substitutes for the other.

Watch the submission side too. A store that returns the existing task on a key
hit without comparing payloads will hand back the *first* task when a client
reuses a key with different content — silently the wrong answer rather than a
duplicate. Fingerprint the payload beside the key and reject the conflict.

## The zombie worker

**Presents as:** a task marked `Succeeded` that was never finished, or progress
that goes backwards — a checkpoint at step nine replaced by one at step three.
Whatever ran second is the version that survives, which makes the resulting
state look arbitrary rather than wrong.

**Cause:** a worker paused past its lease — a long GC pause, a suspended VM, a
blocked syscall — wakes still believing it owns work that has been reissued and
possibly completed. Its late ack or checkpoint lands on a task somebody else
owns. Fencing is what makes at-least-once safe rather than merely tolerable.

**Do:** issue a token with the lease and require it on every lease-scoped
write — ack, fail, renewal, and *checkpoint*, which is the one usually
forgotten and the one that corrupts progress rather than merely duplicating it.
Compare the deadline in the same predicate: `WHERE id = ? AND lease_token = ?
AND leased_until > now()`. A guard testing only the token makes fencing
conditional on some other worker having polled and reclaimed the row first —
until that happens, a lease hours past its deadline still accepts writes, and
the exposure is unbounded on a quiet queue.

## The crash-looping poison task

**Presents as:** workers dying in rotation, a queue that never drains, and a
task that has been "retrying" for days. Each new worker picks it up and dies,
so the failure looks like a capacity problem or a bad deploy.

**Cause:** a retry budget spent on reported failures. A handler whose process
is killed never reports anything — the lease simply expires, the task returns
to the pending pool with its budget untouched, and it is redelivered forever.

**Do:** spend the budget at the claim. Then crash-driven redelivery is bounded
by exactly the same limit as explicit failure, the task dead-letters, and an
operator sees it. Apply backoff to the reclaim path as well: an expiry that
makes the task immediately visible again lets it cycle at polling speed and
consume its whole budget in seconds, killing one worker per cycle on the way.
The explicit-failure path almost always has backoff; the crash path almost
never does, and the crash path is the one that runs during an incident.

## Lease shorter than the work

**Presents as:** duplicate side effects that correlate with load, and a lease
expiry rate that rises without any worker actually crashing. It reads as an
application bug because the code did not change — the *work* got slower.

**Cause:** a visibility timeout tuned for a fast task meeting a slower one. The
lease lapses mid-execution, the task is reissued while the original worker is
still running it, and two workers race.

**Do:** size the lease against p99 handler duration with headroom, and renew as
the work proceeds. Renew from a task that the work cannot block: renewal called
from inside the handler stops firing exactly when the handler is slowest, which
is precisely when the lease is about to lapse — a blocking call, a CPU-bound
stretch, or a model call without a timeout all starve it. When renewal fails,
cancel the work rather than letting it run on: the task now belongs to someone
else, and everything the original does from here is duplicate spend at best.

## Deploys that manufacture the crash

**Presents as:** a burst of redelivery and duplicate execution on every
release, reliably, in a system whose recovery machinery is otherwise idle.

**Cause:** a rolling deploy that kills workers holding leases. Recovery is
designed for unplanned death; using it for planned death pays the redelivery
and duplicate-execution cost on a schedule you control and could have avoided.

**Do:** handle `SIGTERM` by stopping the claim loop, awaiting in-flight
handlers, then exiting — and check the drain's outcome rather than discarding
it, since a drain that timed out and a drain that completed need different
responses. Set the termination grace period above the observed p99 drain, with
headroom, and track drain duration as a metric: the day it approaches the grace
period is the day deploys start killing work, and it arrives gradually.

## A dead-letter queue nobody reads

**Presents as:** nothing at all. Work was accepted, acknowledged to the caller,
and quietly abandoned. It surfaces weeks later as a customer asking why
something never happened.

**Cause:** dead-lettering treated as the end of the story rather than a handoff.
It is only a safety mechanism if a human sees it; unmonitored, it converts a
loud failure into a silent one.

**Do:** alert on dead-letter *arrival rate*, not depth — depth is a stock and
says nothing about whether anything arrived today. Give the queue an owner and
a written triage path, and keep the exit manual: a timer that requeues dead
letters rebuilds the infinite loop the budget existed to terminate, and does it
on the payloads most likely to be poison. Requeue is a decision about a
dependency being fixed or a human overriding a verdict, not another blind
retry.

**Source:** [Architecture: Durable Agent Execution](https://handbook.vinodspattar.in/architecture/systems/durable-agent-execution/), [Lab: Durable Agent Task Engine](https://handbook.vinodspattar.in/build/labs/durable-agent-task-engine/), [Module 5: Agent Engineering](https://handbook.vinodspattar.in/learn/modules/05-agent-engineering/)
