# Patterns

Four excerpts from `labs/dynamic-batching-inference`, each named with the file
it came from. All four were verified by binding them back over the lab's own
modules and running its suite: 27/27 before and 27/27 after, on Python 3.14.5 —
a baseline I established on this machine before patching anything, not a figure
from the lab.

**One condition applies to every number below, and it is load-bearing.** The
lab's model call is a fixed-cost `asyncio.sleep`, so batch cost does not grow
with the batch's contents. Real inference cost grows with the *padded* sequence
length of the batch, which is what makes the throughput curve bend and optimal
batch size a property of the traffic's length distribution rather than its
rate. Nothing here measures inference hardware. `max_batch_size = 8` and
`max_wait_seconds = 0.02` are the lab's defaults, chosen to make the mechanism
observable in a test suite; they are not a recommendation, and any throughput
this lab reports is a property of a sleep.

## The race, and the failure path that keeps the loop alive

From `src/inference/batcher.py`. Serves "race a size trigger against a timeout,
and give the race to one background loop" and "on a handler exception, complete
every pending future with it".

```python
class DynamicBatcher:
    async def submit(self, payload: Any) -> Any:
        if self._stopping:
            raise BatcherClosedError()
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        async with self._lock:
            self._pending.append(_Pending(payload, future))
            if len(self._pending) >= self._max_batch_size:
                self._batch_full.set()
        return await future

    async def run(self) -> None:
        while not self._stopping:
            try:
                async with asyncio.timeout(self._max_wait_seconds):
                    await self._batch_full.wait()
            except TimeoutError:
                pass
            await self._flush()

    async def _flush(self) -> None:
        async with self._lock:
            batch = self._pending
            self._pending = []
            self._batch_full.clear()
        if not batch:
            return

        self.batches_processed += 1
        payloads = [item.payload for item in batch]
        try:
            outputs = await self._handler(payloads)
        except Exception as exc:  # noqa: BLE001 - every waiter must hear about it, not just crash the loop
            for item in batch:
                if not item.future.done():
                    item.future.set_exception(exc)
            return

        for item, output in zip(batch, outputs, strict=True):
            if not item.future.done():
                item.future.set_result(output)
```

`__init__`, omitted, sets `_pending` to a list, `_lock` to an `asyncio.Lock`,
and `_batch_full` to an `asyncio.Event`. The race is `asyncio.timeout` wrapped
around `self._batch_full.wait()`, and both outcomes fall through to the same
`_flush()`. Size wins, or the timer wins; either way a batch closes and no
request waits longer than `max_wait_seconds` plus the handler. Note
`except TimeoutError: pass` — during a lull the timeout is the *normal* path.

`submit` never flushes. It appends, may set the event, and awaits its own
future; one background task owns closing. Move the flush into `submit` and two
concurrent callers form two batches, which is the whole mechanism inverted.

The `_flush` swap is the concurrency-sensitive part. Taking the lock, rebinding
`self._pending` to a fresh list, and clearing the event happen together, so a
`submit` racing the flush lands in the next batch rather than one already being
dispatched. Clearing the event *after* the swap stops a stale set flag from
closing the next batch instantly.

The broad `except` around the handler is the rule this excerpt exists for. Let
the exception escape and the `run` loop exits; from then on every queued
request and every later arrival awaits a future nothing will ever resolve, and
the server hangs rather than errors. Setting the exception on each waiter turns
one bad batch into N failed requests and leaves the loop running.

The `if not item.future.done()` guards cover a waiter that was already
cancelled — a disconnected client, a caller whose own deadline fired — since
setting a result on a done future raises, and that exception would escape
mid-loop and strand the rest. `zip(..., strict=True)` enforces the handler's
contract of one output per payload, in order, instead of resolving requests
with each other's answers.

Deliberately omitted: the imports; `__init__`, described above; the `_Pending`
dataclass (a `payload` and a `future`); the two `DEFAULT_*` module constants
(`8` and `0.02`, quoted above); the class docstring and `run`'s docstring
(`submit` and `_flush` have none); and `shutdown()`, which sets `_stopping`,
sets the event, and flushes once. The block compiles as printed but will not
import standalone. No comment in this excerpt is mine — the `# noqa` line is
the lab's.

## Metrics keyed by version, counted on both paths

From `src/inference/router.py`. Serves the rule this skill exists for: a
blended number cannot fail a canary.

```python
class CanaryRouter:
    def __init__(self) -> None:
        self._versions: dict[str, ModelVersion] = {}
        self._batchers: dict[str, DynamicBatcher] = {}
        self._metrics: dict[str, VersionMetrics] = {}

    async def infer(
        self, payload: Any, *, version: str | None = None, rng: random.Random | None = None
    ) -> InferenceResult:
        target = version or self.choose_version(rng=rng)
        if target not in self._versions:
            raise UnknownVersionError(target)

        metrics = self._metrics[target]
        started = time.monotonic()
        try:
            output = await self._batchers[target].submit(payload)
        except Exception:
            metrics.request_count += 1
            metrics.error_count += 1
            raise

        latency_ms = (time.monotonic() - started) * 1000
        metrics.request_count += 1
        metrics.total_latency_ms += latency_ms
        return InferenceResult(version=target, output=output, latency_ms=latency_ms)
```

Three dicts keyed by version, and that shape *is* the rule. A batcher per
version keeps the queues and therefore the latency distributions apart; a
metrics record per version keeps the error rate from being averaged into a
majority that is behaving fine.

The `except` block is the half that gets skipped. It increments
`request_count` as well as `error_count`, so `error_rate` stays a rate rather
than becoming errors over successes — which would understate exactly when
things are worst. Every exit path from `infer` counts a request; there is no
branch on which a request happens silently.

`time.monotonic()` around `submit()` includes the batch wait, not just the
handler — the number the user experiences, and also why the aggregate needs
splitting into queue wait and model time before it can be diagnosed.

Deliberately omitted: imports; the class docstring (`__init__` and `infer` have
none); `register()`, `batchers()`, and `choose_version()`, which sit between
`__init__` and `infer` in the file; and everything after `infer` — `metrics()`,
`list_versions()`, `promote()`, `rollback()`, `_set_weight()`. `register` is
the only place a batcher and a metrics record are created for a version. No
comment in this excerpt is mine.

## Rollback as a weight change — and what a weight of zero does not stop

Composed from `src/inference/router.py`: three methods of `CanaryRouter` that
are not adjacent in the file — `choose_version` sits before `infer`, and
`promote` and `rollback` after `list_versions`. Each is verbatim; only their
neighbours are gone. Serves "make rollback a routing-weight change" and "a
weight-zero version still serves an explicit version request".

```python
    def choose_version(self, *, rng: random.Random | None = None) -> str:
        servable = [v for v in self._versions.values() if v.weight > 0]
        if not servable:
            raise NoServableVersionError()

        chooser = rng or random
        total_weight = sum(v.weight for v in servable)
        pick = chooser.uniform(0, total_weight)
        cumulative = 0.0
        for candidate in servable:
            cumulative += candidate.weight
            if pick <= cumulative:
                return candidate.version
        return servable[-1].version  # floating-point rounding fallback

    def promote(self, version: str) -> None:
        if version not in self._versions:
            raise UnknownVersionError(version)
        for existing in list(self._versions.values()):
            self._set_weight(existing.version, 1.0 if existing.version == version else 0.0)

    def rollback(self, version: str) -> None:
        if version not in self._versions:
            raise UnknownVersionError(version)
        self._set_weight(version, 0.0)
```

`promote` and `rollback` do nothing but move numbers. No process restarts, no
weights reload, no build runs — which is what makes rollback fast enough to use
while an incident is in progress. The cost is the same property seen from the
other side: every version stays registered and loaded, so rollback headroom is
memory you pay for continuously. `rollback` zeroes one weight and leaves the
rest, keeping their relative shares; `promote` rewrites every weight, which
makes it the destructive one, since weights are the only record of the split.

The gap is in `choose_version`'s first line. `weight > 0` filters the
*weighted* draw only, while `infer` starts with `target = version or
self.choose_version(...)` — so a caller who names the rolled-back version is
still served by it. Read one way that is version pinning working correctly;
read the other way it is a rollback that did not roll back. Decide which your
system means and enforce it, because the code reads identically either way.

Deliberately omitted: `_set_weight`, which replaces the frozen `ModelVersion`
with a copy carrying the new weight; the imports; and the docstrings on
`promote` and `rollback` — one said it routes all traffic to this version, the
other that it drops this version's weight without affecting others
(`choose_version` has none). Printed at its file indentation with the `class
CanaryRouter:` header dropped, which is what stops this block compiling
standalone. No comment in this excerpt is mine — the
`# floating-point rounding fallback` line is the lab's.

## Percentiles, and a client that bounds its own concurrency

From `src/inference/benchmark.py`. Serves "report p50, p95, and p99 — never the
mean".

```python
def _percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    index = min(len(sorted_values) - 1, round(p * (len(sorted_values) - 1)))
    return sorted_values[index]


async def run_benchmark(
    submit: Callable[[], Awaitable[Any]],
    *,
    num_requests: int,
    concurrency: int,
) -> BenchmarkReport:
    semaphore = asyncio.Semaphore(concurrency)
    latencies_ms: list[float] = []
    errors = 0

    async def run_one() -> None:
        nonlocal errors
        async with semaphore:
            started = time.monotonic()
            try:
                await submit()
            except Exception:  # noqa: BLE001 - a failed request still counts toward the report
                errors += 1
            latencies_ms.append((time.monotonic() - started) * 1000)

    started_at = time.monotonic()
    await asyncio.gather(*(run_one() for _ in range(num_requests)))
    duration = time.monotonic() - started_at

    sorted_latencies = sorted(latencies_ms)
    return BenchmarkReport(
        total_requests=num_requests,
        error_count=errors,
        duration_seconds=duration,
        throughput_rps=num_requests / duration if duration > 0 else 0.0,
        p50_latency_ms=_percentile(sorted_latencies, 0.50),
        p95_latency_ms=_percentile(sorted_latencies, 0.95),
        p99_latency_ms=_percentile(sorted_latencies, 0.99),
        latencies_ms=tuple(sorted_latencies),
    )
```

The semaphore is the part people leave out. Firing `num_requests` coroutines
with no bound measures the load generator and produces percentiles for a
workload nobody sends; a fixed concurrency models a real client with a
connection pool. It matters doubly for a *batching* server: concurrency decides
whether batches close on size or on the timer, so an unbounded run exercises
one regime and reports it as the system's behaviour.

The timer starts inside `run_one`, after the semaphore is acquired, so the
reported latency excludes time queued in the load generator — the right choice,
and also why this harness cannot report queue wait *inside* the server.
Splitting that out is a server-side instrument, not a benchmark one.

The `except` records a latency for the failed request too, so an endpoint that
fails fast cannot flatter its percentiles by dropping failures out of the
distribution. `_percentile` indexes the sorted list by nearest rank and clamps
at the end — exact enough at benchmark sizes, with no interpolation to argue
about. Watch the sample count rather than the method: p99 over a couple of
hundred requests is one or two observations, a direction and not a measurement.

Deliberately omitted: imports, and `run_benchmark`'s docstring, which said that
bounding concurrency models a realistic client and that average latency hides
tail behaviour — the point made in the first paragraph above (`_percentile` has
none). `BenchmarkReport` is a frozen dataclass of exactly the fields
constructed here. No comment in this excerpt is mine — the `# noqa` line is the
lab's.

**Source:** [Lab: Dynamic Batching Inference](https://handbook.vinodspattar.in/build/labs/dynamic-batching-inference/), [Architecture: Model Serving Platform](https://handbook.vinodspattar.in/architecture/systems/model-serving-platform/), [`labs/dynamic-batching-inference`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/dynamic-batching-inference)
