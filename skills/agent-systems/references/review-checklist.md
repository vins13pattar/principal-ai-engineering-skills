# Review checklist

Ordered by what the failure costs, not by where it appears in the file. The
first four all produce duplicate or abandoned work in production and all pass
review easily, because each looks like a solved problem. Stop and comment at the
first failing answer in that section — the rest are usually downstream of it.
The last two sections are grouped by topic rather than ranked, and every one of
them is worth asking regardless of what failed above.

## The four that find the most

1. **Is the handler idempotent, separately from the submission key?** *Failing
   answer:* an `Idempotency-Key` on submit and a handler that charges, sends, or
   writes unconditionally — the key deduplicates submissions, not executions.
   Also failing: an effect key derived from the attempt number, which changes on
   every redelivery and so deduplicates nothing. Look for a key built from the
   task ID and an operation name, a rejection enforced where the state lives,
   and a test that runs the handler twice on one task and asserts one effect.

2. **Where does the retry budget decrement — at the claim, or at the reported
   failure?** *Failing answer:* `attempts += 1` inside the failure path. A
   handler that kills its worker never reports a failure, so the budget never
   moves and the task is redelivered until someone notices. Then check the
   crash path has backoff too: an expiry that makes the task immediately
   visible burns the whole budget at polling speed.

3. **Does the fencing guard test the deadline as well as the token?** *Failing
   answer:* `WHERE id = ? AND lease_token = ?`. That makes fencing conditional
   on another worker having polled and reclaimed the row first; until then a
   lease long past its deadline still accepts writes. Check the guard covers
   `checkpoint` and renewal, not only `ack` — a stale checkpoint overwrites
   newer progress, which is worse than a duplicate.

4. **Is the claim one atomic round trip, on the store's clock?** *Failing
   answer:* a `SELECT` of pending rows followed by a separate `UPDATE ... SET
   status = 'leased'`, however carefully written — that is the race the lease
   exists to remove. Also failing: a deadline computed by the worker and sent
   to the store, which makes ownership a function of clock skew. Look for
   `FOR UPDATE SKIP LOCKED` or an atomic script, and `now()` evaluated in the
   store.

## Then, in reversibility order

5. **How is the lease renewed, and from where?** *Failing answer:* renewal
   called from inside the handler body. It stops firing exactly when the
   handler is slowest, which is when the lease was about to lapse. Check the
   lease is sized against p99 handler duration, and that a failed renewal
   cancels the work rather than letting it run on unowned.

6. **What runs the reclaim, and does the backlog metric see stranded tasks?**
   *Failing answer:* a reclaim scan that only executes inside the claim, so a
   queue whose workers have all died recovers nothing — and the task is not
   `Pending`, so queue depth and oldest-pending age both report empty.

7. **Are idempotency keys tenant-scoped, and is the payload fingerprinted?**
   *Failing answer:* a global or queue-only key namespace, and an early return
   that hands back the existing task without comparing payloads. A client
   reusing a key with different content then receives the first result —
   silently wrong rather than duplicated.

8. **What is in the checkpoint?** *Failing answer:* full documents, model
   responses, or accumulated tool output. It is a resumption cursor — IDs,
   offsets, counts — and it is re-serialized on every write. Then ask where
   checkpoints are written: after work whose redo costs more than the write,
   not after every cheap step, which makes the store the bottleneck.

9. **Can a task leave the dead-letter queue without a human?** *Failing
   answer:* a timer or job that requeues dead letters automatically. That
   rebuilds the infinite loop the budget existed to terminate, on the payloads
   most likely to be poison.

10. **Does `SIGTERM` drain, and is the grace period above the observed p99
    drain?** *Failing answer:* no signal handler, or one whose drain result is
    discarded — a drain that timed out and a drain that completed need
    different responses. Without both halves, every deploy manufactures the
    crash recovery exists for.

11. **Is retry bounded in wall-clock as well as in attempts?** *Failing
    answer:* an attempt cap with no deadline on the task's total life, so a
    task accepted on Monday is still being retried on Thursday against a caller
    that gave up immediately.

12. **In a graph: does every accumulating state key declare a reducer, and is
    each node safe to re-run whole?** *Failing answer:* `messages: list[str]`
    with no reducer, which silently overwrites instead of appending and needs a
    second loop iteration to show up. And any node holding two side effects,
    since a retry re-runs the node from the top — put the effect last and make
    it idempotent. Check the run has its own wall-clock budget: ten nodes at
    thirty seconds each is a five-minute worst case that no per-node timeout
    catches.

## Cost — last but always

13. **What does a duplicate execution cost here?** *Failing answer:* nobody
    knows. With model calls in the handler, redelivered work is a line item, so
    lease sizing and checkpoint placement are spend decisions. An unbounded
    retry against a paid dependency is an unbounded bill; the budget is what
    makes the worst case finite.

14. **What does the queue cost when it is empty?** *Failing answer:* an
    aggressive poll interval multiplied by a large worker count, paid
    continuously. At low utilization that can exceed the cost of the work.

## Observability — last but always

15. **Does dead-letter arrival rate page someone?** *Failing answer:* a
    dashboard panel showing dead-letter *depth*. Depth is a stock and says
    nothing about whether anything arrived today. Arrival means accepted,
    acknowledged work is being abandoned, and it is the one metric that must
    page — to an owner, with a written triage path.

16. **Is lease expiry rate tracked, and can a rise be attributed?** *Failing
    answer:* no such metric, or one that cannot distinguish workers dying from
    leases being too short for current work. Those two have opposite fixes.

17. **Are delivery attempts recorded as a distribution?** *Failing answer:* a
    mean, or nothing. A rising tail is the earliest visible sign of a poison
    task or a degrading dependency, and the mean hides it.

18. **Is attempt two linkable to attempt one, and is drain duration a metric?**
    *Failing answer:* a fresh trace per delivery, so debugging a retried task
    means reconstructing it from timestamps — and no drain metric, so the day
    drain time crosses the termination grace period passes unnoticed.

**Source:** [Architecture: Durable Agent Execution](https://handbook.vinodspattar.in/architecture/systems/durable-agent-execution/), [Module 5: Agent Engineering](https://handbook.vinodspattar.in/learn/modules/05-agent-engineering/), [LangGraph lookup](https://handbook.vinodspattar.in/reference/lookups/langgraph/), [Cheat Sheet: Design Review](https://handbook.vinodspattar.in/cheatsheets/sheets/design-review/)
