# Patterns

Excerpts trimmed to the load-bearing lines, each named with where it came from.
Four are trimmed from the lab's `task_queue/` package and were verified by
binding them over the originals and running the lab's own suite. The fourth is
an adaptation, labelled as one, because the behaviour it shows is the change
being argued for and the lab does not have it.

One condition applies to all of them: the lab's store is in-memory and
single-process. That is deliberate — it is written as a specification for what
a durable backend must guarantee atomically, so the *transitions* below
transfer directly while `self._lock` stands in for row-level locking or an
atomic script. Nothing here is a durability measurement.

## Idempotent submission — and its exact boundary

From `store.py`. Serves the rule this skill exists for by showing how little
the key actually buys.

```python
async def submit(
    self, queue: str, idempotency_key: str, payload: dict[str, Any],
    *, max_attempts: int = 5,
) -> Task:
    async with self._lock:
        index_key = (queue, idempotency_key)
        existing_id = self._idempotency_index.get(index_key)
        if existing_id is not None:
            return self._tasks[existing_id]

        task = Task(
            id=new_id(), queue=queue, idempotency_key=idempotency_key,
            payload=payload, max_attempts=max_attempts,
        )
        self._tasks[task.id] = task
        self._idempotency_index[index_key] = task.id
        return task
```

This collapses retried *submissions* into one task and does nothing else. The
handler that task eventually runs can still execute twice, and no line here
changes that — which is the whole distinction, visible as an absence.

Two properties of the index key are worth reading as decisions. It is
`(queue, idempotency_key)`, so keys are namespaced by queue and **not** by
tenant: put a tenant in that tuple, or one tenant's key collides with another's
and returns its task. And the early return ignores the new `payload` and
`max_attempts` entirely, so a client reusing a key with different content
receives the first task and the first result — silently the wrong answer rather
than a duplicate. Store a payload fingerprint beside the key and reject the
conflict.

Deliberately omitted: the class body and the declarations of `_lock`, `_tasks`,
and `_idempotency_index`, without which this does not run as printed. The
signature is reflowed onto fewer lines; the parameters are unchanged.

## The atomic claim, spending the budget on delivery

From `store.py`. Serves "decrement the retry budget when the task is handed
out" — the policy that makes a crash-looping task terminate.

```python
async def lease(self, queue: str, *, lease_seconds: float) -> Lease | None:
    now = time.monotonic()                      # the STORE's clock, not a worker's
    async with self._lock:
        self._reclaim_expired_locked(queue, now)

        candidates = sorted(
            (t for t in self._tasks.values()
             if t.queue == queue and t.status is TaskStatus.PENDING and t.available_at <= now),
            key=lambda t: t.available_at,
        )
        for task in candidates:
            task.attempts += 1                  # spent on DELIVERY, before the handler runs
            if task.attempts > task.max_attempts:
                task.status = TaskStatus.DEAD_LETTER
                task.last_error = task.last_error or "max delivery attempts exceeded"
                task.touch()
                continue                        # dead-letter it and keep looking

            task.status = TaskStatus.LEASED
            task.lease_token = new_lease_token()
            task.leased_until = now + lease_seconds
            task.touch()
            return Lease(
                task_id=task.id, token=task.lease_token, queue=task.queue,
                attempt=task.attempts, payload=task.payload, checkpoint=task.checkpoint,
            )
        return None
```

`task.attempts += 1` sitting here rather than in the failure path is the entire
policy. A handler that kills its worker never reports a failure, so a budget
decremented on failure never moves and the task is redelivered forever; spent
at the claim, crash-driven redelivery is bounded by the same limit as explicit
failure. The cost is fairness — a redelivery caused by infrastructure trouble
burns budget the task did not deserve to lose.

Everything inside `async with self._lock` must be one atomic round trip in a
real store: `SELECT ... FOR UPDATE SKIP LOCKED` and the `UPDATE` together, or a
Lua script. `SKIP LOCKED` is doing specific work — it lets contending pollers
step over locked rows instead of queueing behind them, which is what stops the
claim serializing under worker count.

`now` comes from the store and is used for both the eligibility test and
`leased_until`. A worker that computes its own deadline and sends it makes lease
ownership a function of clock skew between workers.

Deliberately omitted: as above, the class body and its attribute declarations.

## Fencing, and the reclaim that has no backoff

From `store.py`. Serves "guard every lease-scoped write with the token and the
deadline" — every one of `ack`, `fail`, `checkpoint`, and `heartbeat` routes
through `_require_leased`.

```python
def _reclaim_expired_locked(self, queue: str, now: float) -> None:
    for task in self._tasks.values():
        if (task.queue == queue and task.status is TaskStatus.LEASED
                and task.leased_until is not None and task.leased_until <= now):
            task.status = TaskStatus.PENDING
            task.available_at = now              # visible again IMMEDIATELY — no backoff
            task.lease_token = None              # the fence: the old token now matches nothing
            task.leased_until = None
            task.touch()
            # The checkpoint survives, so the next worker resumes rather than restarts.

def _require_leased(self, task_id: str, lease_token: str) -> Task:
    task = self._tasks.get(task_id)
    if task is None:
        raise TaskNotFoundError(task_id)
    if task.status is not TaskStatus.LEASED or task.lease_token != lease_token:
        raise LeaseExpiredError(task_id)
    return task
```

Read the two together and the dependency appears: `_require_leased` never looks
at `leased_until`, so a stale worker is fenced only once
`_reclaim_expired_locked` has nulled its token — and that runs solely inside
`lease()`. Verified by running it: a task leased for 0.05s still accepted a
heartbeat *and* a checkpoint 0.20s later, and began raising only after a
competing `lease()` reclaimed it. Add `AND leased_until > now()` to the guard
and the dependency is gone.

Stranding is the other half. A task whose workers have all died stays `LEASED`,
never `PENDING`, so neither queue depth nor oldest-pending age counts it and
the backlog reads empty. Run reclaim off a path that needs no live poller.

`available_at = now` is the third thing: the crash path makes the task visible
instantly where `fail()` pushes it forward by backoff, so a handler that kills
its worker cycles at polling speed.

Deliberately omitted: the class body, and the `errors` and `models` imports that
`TaskNotFoundError`, `LeaseExpiredError`, and `TaskStatus` come from.

## Lease renewal, off the work's own execution path

**Adapted, not transcribed.** The lab has no renewal supervisor: `worker.py`'s
`TaskContext.heartbeat()` is cooperative, meant to be called by the handler
itself. That is the shape being argued against, so this composes the lab's
`TaskContext` and store into the shape being argued for.

```python
async def run_with_lease_renewal(
    store: InMemoryTaskStore, lease: Lease, handler: TaskHandler,
    *, lease_seconds: float,
) -> None:
    ctx = TaskContext(store, lease, lease_seconds=lease_seconds)
    stop = asyncio.Event()

    async def renew() -> None:
        while True:                     # a third of the lease: lose one renewal, not the lease
            try:
                await asyncio.wait_for(stop.wait(), timeout=lease_seconds / 3)
                return
            except TimeoutError:
                await ctx.heartbeat()   # raises LeaseExpiredError once fenced out

    renewer = asyncio.create_task(renew())
    work = asyncio.create_task(handler(lease.payload, ctx))
    try:
        done, _ = await asyncio.wait({work, renewer}, return_when=asyncio.FIRST_COMPLETED)
        if renewer in done:             # renewal failed: the task is someone else's now
            work.cancel()               # stop paying for a result nobody will accept
            renewer.result()            # re-raise whatever ended the renewer
        work.result()                   # never swallow the handler's own exception
    finally:
        stop.set()
        await asyncio.gather(work, renewer, return_exceptions=True)
```

The separate task is the point. `await ctx.heartbeat()` written inside a handler
runs only when the handler yields, so a blocking call, a CPU-bound stretch, or a
model call without a timeout starves renewal exactly when the work is slowest —
which is the one moment the lease was going to lapse. Verified against the lab:
this held a 0.30s lease across a 0.9s handler.

`renewer in done` is the second decision. A renewer that finished before the
work did means renewal failed, which means the task now belongs to another
worker; cancelling the handler stops it spending money on a result nobody will
accept, and re-raising surfaces the loss instead of letting the caller ack a
task it no longer owns.

The bare `work.result()` is not decoration, and dropping it is the mistake this
shape invites: `gather(..., return_exceptions=True)` in the `finally` retires
the handler's exception, so without that line a failing task returns cleanly
and every failure looks like a success. Whatever supervises this needs the
exception to choose between ack and fail.

Deliberately omitted: `asyncio` and the `task_queue` imports; and the ack/fail
that follows, which must itself tolerate `LeaseExpiredError`.

## Backoff, and the width of its jitter

From `backoff.py`. Serves the retry path: this is what pushes a failed task's
visibility timestamp forward.

```python
def exponential_backoff_seconds(
    attempt: int, *, base_seconds: float = 1.0,
    max_seconds: float = 60.0, jitter_ratio: float = 0.2,
) -> float:
    """Full-jitter exponential backoff for the given (1-indexed) attempt.

    Jitter avoids synchronized retry storms across many tasks that failed
    at the same time (e.g. a downstream dependency blip).
    """
    if attempt < 1:
        raise ValueError("attempt must be >= 1")
    capped = min(max_seconds, base_seconds * (2.0 ** (attempt - 1)))
    jitter = capped * jitter_ratio
    return float(capped - jitter + random.random() * (2 * jitter))
```

The docstring names the goal; the last two lines decide whether it is met. The
result is uniform over `[0.8 × capped, 1.2 × capped]` — a ±20% *band*, where
full jitter is uniform over `[0, capped]`. A band that narrow barely
decorrelates a cohort, so the thousand tasks failed by one blip still retry as
a wave, just a slightly blurred one.

The obvious fix is wrong: `jitter_ratio=1.0` gives uniform `[0, 2 × capped]`,
breaking the `max_seconds` cap — measured at attempt 9, half the samples
exceeded 60s, reaching 120s. Full jitter is `random.random() * capped`, a
different expression rather than a parameter value.

Deliberately omitted: `import random`.

**Source:** [Lab: Durable Agent Task Engine](https://handbook.vinodspattar.in/build/labs/durable-agent-task-engine/), [Architecture: Durable Agent Execution](https://handbook.vinodspattar.in/architecture/systems/durable-agent-execution/), [`labs/durable-agent-task-engine`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/durable-agent-task-engine)
