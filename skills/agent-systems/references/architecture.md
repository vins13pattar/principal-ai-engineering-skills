# Durable execution architecture

## The problem the design exists to solve

Agent work is long, expensive, and interrupted constantly. A run that dies on
step seven should not restart at step one; a submission retried by an impatient
client should not create a second run; and a worker killed mid-task must not
leave that task invisible forever.

Running the work inside the request that asked for it fails all three: the
request's lifetime becomes the work's lifetime, so a deploy, a timeout, or an
OOM kill destroys progress that cost real money. The usual first fix — a
background task, a fire-and-forget thread — removes the symptom and keeps the
disease. Nothing durable records that the work exists, so nothing can recover it.

What is needed is a delivery guarantee, and the honest one is
**at-least-once**. Exactly-once *delivery* is not available; exactly-once
*effect* is reachable only by making handlers idempotent. Every decision below
follows from accepting that rather than designing around it.

## Requirements worth writing down

- **Durable submission.** Work survives the process that accepted it.
- **Idempotent submission.** A client-supplied key collapses retried
  submissions into one task.
- **Automatic recovery.** A worker that dies releases its work without operator
  action and without a separate supervisor.
- **Bounded retries.** A task that cannot succeed stops being retried and
  becomes visible to a human.
- **Resumable progress.** A long task continues from its last checkpoint.
- **Safe concurrency.** Two workers never both believe they own the same task.
- **Graceful shutdown.** A deploy drains in-flight work instead of
  manufacturing the exact crash the rest of the system exists to survive.

## Constraints that decide the design

- **At-least-once is the ceiling**, so any handler with side effects must be
  idempotent and nothing downstream may assume otherwise.
- **The store defines the guarantee, not the application.** Correctness rests
  on a single-round-trip atomic claim. A check-then-update in application code
  reintroduces the race however carefully it is written.
- **Clock skew is real.** Lease expiry compares timestamps produced somewhere;
  if that somewhere is each worker, two workers with skewed clocks disagree
  about who owns a task.
- **Expiry is not an event.** No timer fires when a lease lapses — expiry is
  *noticed*, by whatever code next looks at the row. What that code is, and
  what runs it, is a design decision rather than a detail.
- **Checkpoint size is bounded by the store.** Checkpointing stays cheap only
  while the checkpoint stays small: it is a resumption cursor, not a place to
  stash intermediate results.

## Request flow

The lifecycle, as transitions rather than a diagram:

1. **Submit with an idempotency key** and persist as `Pending`. A repeat of the
   key returns the existing task instead of creating a second one.
2. **A worker claims a `Pending` task whose visibility timestamp has passed**,
   in one atomic round trip, receiving a fencing token and a deadline computed
   on the store's clock. The task is `Leased` — invisible to other workers only
   while the lease holds.
3. **The claim spends one unit of the retry budget.** A task with none left
   goes to `DeadLetter` at this point, without running.
4. **The handler runs**, with the last checkpoint handed to it, and records
   progress as it goes.
5. **Work that outlives the lease renews the deadline**, presenting its token.
6. **On success the worker acks with its token** and the task is `Succeeded`.
7. **On failure it fails with its token** and returns to `Pending` with the
   visibility timestamp pushed forward by backoff — or `DeadLetter` if the
   budget is now spent.
8. **If the worker dies, nobody renews.** The deadline passes, a reclaim
   returns the task to `Pending` with its checkpoint intact, and its token is
   invalidated so the original worker can no longer act on it.
9. **`DeadLetter` leaves only by operator requeue**, never automatically.

**Step 3 is the architecture.** Spending the budget at the claim rather than at
a reported failure is what makes step 8 terminate: a handler that kills its
worker never reaches step 7, so a budget decremented only there never moves and
step 8 loops forever. Step 8 is the second load-bearing property, and the
subtle part is *who runs it*. Reclaim folded into step 2 means a queue whose
workers have all died recovers nothing, and the stranded task is not `Pending`,
so a backlog metric reports the queue as empty.

## Scaling

- **The claim is the bottleneck, not throughput.** Every worker polling
  contends on the same rows. `SELECT ... FOR UPDATE SKIP LOCKED` exists so
  contending readers step over locked rows instead of queueing behind them.
- **Poll interval trades latency against load.** Aggressive polling buys low
  pickup latency and grows load faster than linearly in worker count; long
  polling or a notification channel decouples the two.
- **Partition by queue before partitioning by shard.** Separate queues per
  workload class isolate a slow, high-volume workload from a latency-sensitive
  one, and are far easier to reason about than hash-sharding one queue.
- **Dead-letter growth is a capacity signal.** Growing faster than it drains
  means a dependency is broken and retry traffic is amplifying load rather than
  absorbing it.
- **Checkpoint writes scale with progress granularity.** Checkpointing every
  unit of a thousand-step task makes the store, not the handler, the limit.
- **A reclaim scan competes with the claim.** It walks rows on the same table
  under the same contention, so its cost belongs in the poll-interval budget.

## Security

- **Task payloads are stored data**, frequently user content, inheriting
  whatever retention, encryption, and deletion obligations that content
  carries. A queue is not exempt because it is "just infrastructure".
- **Idempotency keys must be scoped per tenant.** A global key namespace lets
  one tenant collide with — and therefore read the result of — another's
  submission.
- **Fencing tokens are capability tokens.** Holding one lets a worker complete
  or modify a task, so they should be unguessable and never logged beside the
  task identifiers they authorize.
- **Dead-letter contents are the most sensitive data here**, being the payloads
  that failed repeatedly and now sit on an operator-facing surface indefinitely.
- **Checkpoints inherit the payload's classification**, and are easy to forget
  when scoping encryption or deletion.
- **Tool output is untrusted input to the next iteration.** A fetched page or
  document can carry instructions that steer the following step, arriving as an
  observation rather than as a prompt, which makes it easy to overlook.

## Cost

- **Redelivered work is paid twice.** With model calls in the handler,
  duplicate execution is a line item, which makes checkpointing and
  correctly-sized leases a spend decision as much as a technical one.
- **Polling has a floor cost** proportional to worker count times poll
  frequency, paid continuously whether or not there is work. At low utilization
  it can exceed the cost of the work.
- **Retry budgets are a cost cap.** Unbounded retry against a failing paid
  dependency is an unbounded bill; the budget is what makes the worst case
  finite.
- **Checkpoint and payload storage grows with retention**, and dead-lettered
  tasks are retained longest by definition.
- **Graph state is re-serialized every step**, so large objects carried in
  state are paid for on every step, not once.

## Observability

- **Queue depth and oldest-pending age.** Depth alone is ambiguous — a deep
  queue draining fast is fine. Age of the oldest pending task is the honest
  latency signal, and it must count leased-past-deadline tasks or it hides
  precisely the stranded ones.
- **Lease expiry rate.** This is the crash rate and it should be near zero. A
  rise means workers are dying *or* leases are too short for current work, and
  those need distinguishing before they can be acted on.
- **Delivery attempts per task, as a distribution.** A rising tail is the
  earliest visible sign of a poison task or a degrading dependency.
- **Dead-letter arrival rate, alerted on.** The one metric that must page: it
  means accepted, acknowledged work is being abandoned.
- **Drain duration on shutdown.** If it approaches the termination grace
  period, deploys are about to start killing in-flight work.
- **Trace continuity across redelivery.** Attempt two must be linkable to
  attempt one, or debugging a retried task means reconstructing it from
  timestamps.

## Trade-offs

**Visibility timeout vs. explicit heartbeat supervision.** A visibility timeout
needs no extra component: absence of renewal *is* the failure signal. The cost
is recovery latency bounded below by the timeout, so a short timeout recovers
fast and risks reissuing work from a merely-slow worker. An explicit heartbeat
service separates "slow" from "dead" more sharply, at the price of another
distributed component that can fail, partition, or lie.

**Counting delivery attempts vs. counting explicit failures.** Counting
deliveries bounds crash-looping tasks, which counting failures cannot. The cost
is that a task can dead-letter after transient infrastructure trouble that was
never its fault — an unlucky task spends its budget on redeliveries it did not
cause. Counting failures is fairer to individual tasks and unsafe in aggregate.

**Checkpoint granularity.** Frequent checkpoints minimize rework after a crash
and maximize store write load; infrequent ones invert both. The granularity is
set by what a unit of work costs to redo, which is why expensive model calls
usually deserve a checkpoint and cheap transformations do not. The failure at
the fine end is not slowness alone: a checkpoint written per step of a long run
can cost more to write and reload than the work it saves.

**Database-backed queue vs. dedicated broker.** A relational store gives
transactional enqueue alongside business writes — the task and the row that
justifies it commit together, eliminating a class of inconsistency outright. A
dedicated broker gives higher throughput and purpose-built semantics, costing a
second system to operate and a dual-write problem at the boundary. Below a few
thousand tasks per second the transactional guarantee is usually worth more
than the throughput.

**Source:** [Architecture: Durable Agent Execution](https://handbook.vinodspattar.in/architecture/systems/durable-agent-execution/), [Lab: Durable Agent Task Engine](https://handbook.vinodspattar.in/build/labs/durable-agent-task-engine/) (the task-lifecycle diagram, which supplied the request flow), [Module 5: Agent Engineering](https://handbook.vinodspattar.in/learn/modules/05-agent-engineering/), [Module 7: LangGraph](https://handbook.vinodspattar.in/learn/modules/07-langgraph/)
