---
name: agent-systems
description: Use when writing or reviewing agent execution code — agent loops, tool-calling loops, task queues, workers, leases, retries, checkpointing, resumption after crash, dead-letter handling, or LangGraph graphs.
---

# Agent Systems

## Use this when

Work outlives the request that asked for it. That covers a worker polling a
queue, a graph node that resumes from a checkpoint, and the
`asyncio.create_task(...)` somebody reached for so an HTTP handler could
return early.

At-least-once is the ceiling. Every rule below is a consequence of accepting
that a handler will occasionally run twice.

## Rules

1. **Give the handler its own idempotency, separate from the submission
   key.** A deduplicated submission is not an idempotent execution: the key
   collapses retried *submissions* into one task and says nothing about how
   many times that task's side effects run. Derive the effect's key from
   something stable across deliveries — the task ID and an operation name,
   never the attempt number — and have the downstream system reject the
   repeat. Test it by invoking the handler twice on one task and asserting
   one effect, not by asserting it in a comment.
2. **Decrement the retry budget when the task is handed out, not when a
   handler reports failure.** A handler that kills its worker never reports
   anything, so a failure-counted budget never decrements and the task is
   redelivered forever, taking a worker with it each time. The diff is
   whether `attempts += 1` sits in the claim or in the failure path.
3. **Guard every lease-scoped write with the token *and* the deadline.**
   `WHERE id = ? AND lease_token = ? AND leased_until > now()`, evaluated on
   the store's clock. Drop the deadline predicate and fencing becomes a side
   effect of some other worker happening to poll: until that poll, a lease
   hours past expiry still accepts acks and checkpoints. Apply the guard to
   checkpoint and renewal too, not just ack — a zombie's late checkpoint
   overwrites newer progress.
4. **Renew the lease from a task the work cannot block.** Renewal called from
   inside the handler stops firing exactly when the handler is slowest, which
   is the moment it was needed. Put it on a separate task whose only job is
   the clock, at a fraction of the lease so one lost renewal is survivable —
   and cancel the work when renewal fails, because the task is now owned by
   someone else.
5. **Apply backoff on the crash path, not only the failure path.** Expiry
   usually makes a task visible immediately, so a handler that reliably kills
   its worker is redelivered at polling speed and burns its whole budget in
   seconds. Set the redelivery time forward when reclaiming, the way the
   explicit-failure path already does.
6. **Reclaim expired leases on a path that does not depend on a worker
   polling that queue, and count leased-past-deadline rows as backlog.** A
   reclaim scan that only runs inside the claim means a queue whose workers
   have all died recovers nothing. Such a task is not `Pending`, so
   queue-depth and oldest-pending-age both report an empty queue while the
   work sits stranded.
7. **Scope idempotency keys per tenant, and store a payload fingerprint
   beside the key.** A key reused with different content otherwise returns
   the first task and its first result — silently the wrong answer, not a
   duplicate. Compare the fingerprint and reject the conflict; a global key
   namespace additionally lets one tenant read another's result.
8. **Keep the checkpoint a resumption cursor: IDs, offsets, counts.** It is
   sized by what the store will write cheaply on every step, not by what is
   convenient to stash. Write one where redoing the work costs more than the
   write — after a model call, not after a cheap transform — and remember a
   merge-based checkpoint can never *remove* a key, only overwrite it.
9. **Never move a task out of the dead-letter queue automatically.**
   Requeue is an operator action. A timer that retries dead letters rebuilds
   the infinite loop the budget existed to terminate, and it does it on the
   payloads most likely to be poison.
10. **Drain deliberately on `SIGTERM`: stop claiming, await in-flight, then
    exit** — and check the drain's result rather than discarding it. Set the
    termination grace period above the observed p99 drain, or every deploy
    manufactures the crash recovery is for, on a schedule you control.
11. **Treat a graph node as the retry and timeout unit.** A retry re-runs the
    whole node, so a node holding two side effects runs the first one twice;
    put the side effect last and make it idempotent. And a per-node timeout
    is not a run timeout — ten nodes at thirty seconds is a five-minute worst
    case, so bound the run in wall-clock as well as in steps.
12. **Declare a reducer on every state key that accumulates.** Without one an
    update overwrites, so message history, tool results, and citations are
    silently replaced by the last node to touch them. A single-pass test
    never exercises it; the bug needs a second loop iteration to appear.

## Deciding

| Situation | Do this | Because |
| --- | --- | --- |
| Choosing how a dead worker's task comes back | Visibility timeout, no supervisor | Absence of renewal is already the failure signal. A heartbeat service separates "slow" from "dead" more sharply and is one more component that can partition or lie |
| Setting the retry budget's meaning | Count deliveries | "Budget spent on delivery" — the only policy that terminates a crash-looper. It costs fairness: infrastructure trouble can burn an innocent task's budget |
| Handler duration is long or varies widely | Renew from a supervising task; size the lease to p99 plus renewal headroom | "Renew from a path the work cannot block" — a lease tuned to the fast case reissues live work, and duplicate side effects read as an application bug |
| Deciding where to checkpoint | At boundaries where redo costs more than the write | Frequent checkpoints trade store write load for rework. Expensive model calls earn one; cheap transforms do not, and a thousand-step task checkpointing every step makes the store the bottleneck |
| Under a few thousand tasks/second, and enqueue accompanies a business write | Queue in the relational store | Transactional enqueue commits the task and the row that justifies it together, removing a dual-write class of inconsistency a broker makes you solve separately |
| The loop needs to pause for a human, or survive a restart | A checkpointed state graph | Resume-after-crash and resume-after-approval become one mechanism. Without either need, the framework is cost with no return |

## Going deeper

| Read | When |
| --- | --- |
| [references/architecture.md](references/architecture.md) | Designing durable execution, or placing recovery, cost, and observability in it |
| [references/failure-modes.md](references/failure-modes.md) | Work vanished, ran twice, or retried forever — and you are writing the detector |
| [references/patterns.md](references/patterns.md) | You need the shape of an atomic claim, a fence, lease renewal, or backoff |
| [references/review-checklist.md](references/review-checklist.md) | Reviewing someone's worker, store, handler, or graph |
