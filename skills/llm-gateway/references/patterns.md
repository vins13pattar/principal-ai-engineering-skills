# Patterns

Excerpts adapted from the lab, trimmed to the load-bearing lines.

## Async token bucket (per-replica)

Serves Rule 3 by being the version the rule warns about: correct in one process,
silently wrong across replicas.

```python
class AsyncTokenBucket:
    def __init__(self, *, capacity: int, refill_per_second: float) -> None:
        self._capacity = float(capacity)
        self._tokens = float(capacity)
        self._refill_per_second = refill_per_second
        self._updated_at = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._updated_at
            self._tokens = min(
                self._capacity,
                self._tokens + elapsed * self._refill_per_second,
            )
            self._updated_at = now
            if self._tokens < 1:
                raise RateLimitExceededError("Gateway rate limit exceeded")
            self._tokens -= 1
```

Two details carry the correctness. **`time.monotonic()`, never
`time.time()`** — a wall-clock adjustment (NTP step, leap second, VM
resume) either grants a burst of free tokens or freezes the bucket, and it
happens rarely enough that nobody connects the incident to the clock.
**The lock spans read, refill, and decrement as one unit**; without it two
coroutines that both awaken between the read and the write each see the same
token count and both proceed. There is no `await` inside the critical section
other than acquiring the lock itself, so it stays cheap.

Deliberately omitted: any coordination between processes. Per tenant, wrap this
in a dict of buckets keyed by tenant — and note that lazily creating that
bucket must itself be under a lock, or two concurrent first-requests for a new
tenant create two buckets and one is discarded with its state.

## Redis Lua token bucket (shared)

Serves Rule 3 for more than one replica: the whole check-and-decrement is one
atomic script, so no round trip sits between reading the token count and writing
it back.

```lua
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local current = redis.call('HMGET', key, 'tokens', 'updated')
local tokens = tonumber(current[1]) or capacity
local updated = tonumber(current[2]) or now
local elapsed = math.max(0, now - updated)
tokens = math.min(capacity, tokens + elapsed * refill)
if tokens < 1 then
  redis.call('HMSET', key, 'tokens', tokens, 'updated', now)
  redis.call('EXPIRE', key, math.ceil(capacity / refill) * 2)
  return 0
end
tokens = tokens - 1
redis.call('HMSET', key, 'tokens', tokens, 'updated', now)
redis.call('EXPIRE', key, math.ceil(capacity / refill) * 2)
return 1
```

```python
class RedisTenantQuota:
    async def acquire(self, tenant_id: str) -> None:
        allowed = await self._client.eval(
            REDIS_TOKEN_BUCKET, 1, f"ai-gateway:quota:{tenant_id}",
            self._capacity, self._refill, time.time(),
        )
        if int(allowed) != 1:
            raise RateLimitExceededError(f"Tenant rate limit exceeded: {tenant_id}")
```

Three things are easy to get wrong here. `now` is passed **in** rather than read
inside the script, and the consequence is that every replica's clock now feeds a
shared bucket — so they must be NTP-synced, and a skewed replica grants or
withholds tokens for everyone. (Historically this was forced: under command
replication scripts had to be deterministic. Since Redis 5, effect replication
is the default and a script may read `TIME` — but passing the timestamp in
remains the better choice, because it keeps the clock an explicit input you can
stub in a test.)

Note this inverts the rule from the previous section. In-process, `time.time()`
is a bug and `time.monotonic()` is the fix; here `time.time()` is correct.
Monotonic clocks are per-process — the origin is arbitrary and differs between
replicas and across restarts — so a monotonic reading is meaningless as shared
state. Shared buckets need a shared epoch, which means wall clock plus the NTP
discipline to make it trustworthy.

The `EXPIRE` on **both** branches is what stops the keyspace growing one
entry per tenant forever; a TTL of roughly twice the full-refill time is long
enough that an active tenant's state is never dropped mid-window. And the state
is written on the rejected path too, so a rejected request still advances
`updated` rather than leaving a stale timestamp to refill against later.

Deliberately omitted: Rule 4's timeout and degraded path. This call is on the
request path and this excerpt has neither — the caller must add both.

## Admission control with a bounded queue wait

Serves Rules 1 and 7: quota before slot, and a wait that ends in a rejection
rather than an unbounded queue.

```python
async def _admit(self) -> None:
    if self._closing:
        raise RuntimeError("Gateway is shutting down")
    if self._rate_limiter is not None:
        await self._rate_limiter.acquire()
    try:
        await asyncio.wait_for(
            self._capacity.acquire(), timeout=self._max_queue_wait_seconds
        )
    except TimeoutError as exc:
        raise GatewayOverloadedError("Gateway concurrency limit reached") from exc
```

```python
await self._admit()
try:
    async with asyncio.timeout(timeout_seconds):
        for attempt in range(1, self._max_attempts + 1):
            provider = self._select(provider_name)
            try:
                return await provider.generate(prompt)
            except (ConnectionError, TimeoutError) as exc:
                if provider_name is not None or attempt == self._max_attempts:
                    raise
                exponential = self._base_backoff_seconds * (2 ** (attempt - 1))
                await asyncio.sleep(random.uniform(0, exponential))
finally:
    self._capacity.release()
```

The `asyncio.wait_for` around a semaphore acquire is the whole pattern: an
unbounded `acquire()` turns overload into unbounded latency, where every caller
waits and then times out having produced nothing. A quarter-second cap converts
that into a fast 503 the caller can act on — which is why "bounded p99" is a
requirement and not a nicety. Note the ordering inside `_admit`: the rate limit
is checked *before* the slot, so a rate-limited tenant never occupies capacity.

`asyncio.timeout` wraps the loop, so backoff sleeps and all attempts spend the
same budget — Rule 2 in eight lines. Backoff is `random.uniform(0, exponential)`
(full jitter, not `exponential + jitter`): the point is to decorrelate a fleet
of retrying clients, and sleeping the full interval plus noise leaves them
synchronised. The re-raise when `provider_name is not None` is Rule 6, and read
it precisely: a named provider gets **zero** retries, not retries without
swapping. That is the design decision, and it is worth making deliberately —
re-selection is the only retry mechanism wired in here, so retrying a named
provider would mean hammering the one endpoint you already know just failed. If
you want a named provider retried in place, that is a second, narrower backoff
path you have to write. And `release()` sits in `finally`, outside the timeout,
so a cancelled request returns its slot.

Deliberately omitted: the retry predicate is narrower than production needs —
add HTTP 429 and 5xx, and never retry a 4xx.

## Circuit breaker with a single half-open probe

Serves Rule 5 and the cost table: a blocked call is one you do not pay for.

```python
@property
def state(self) -> CircuitState:
    if self._state is CircuitState.OPEN:
        if time.monotonic() - self._opened_at >= self.recovery_timeout_seconds:
            return CircuitState.HALF_OPEN
    return self._state

async def allow(self) -> None:
    state = self.state
    if state is CircuitState.OPEN:
        raise CircuitOpenError("provider circuit is open")
    if state is CircuitState.HALF_OPEN:
        if self._probe_lock.locked():
            raise CircuitOpenError("provider circuit is probing recovery")
        await self._probe_lock.acquire()
        self._state = CircuitState.HALF_OPEN

def record_success(self) -> None:
    self._failures = 0
    self._state = CircuitState.CLOSED
    if self._probe_lock.locked():
        self._probe_lock.release()

def record_failure(self) -> None:
    self._failures += 1
    if self._failures >= self.failure_threshold or self._state is CircuitState.HALF_OPEN:
        self._state = CircuitState.OPEN
        self._opened_at = time.monotonic()
    if self._probe_lock.locked():
        self._probe_lock.release()
```

The probe lock is the part worth copying. Every caller notices the recovery
timeout at the same instant, so a breaker without it sends the entire backlog at
a provider that has just come back — re-breaking it, and turning recovery into a
sawtooth. `locked()` admits exactly one trial request and rejects the rest as
still-open. Note also that a single failure in half-open reopens the circuit
(the `or` in `record_failure`), rather than counting up to the threshold again:
the probe already told you the answer.

**Both outcome methods must release the probe lock, and that is the line people
drop.** `record_success` is doing three jobs — reset the failure count, close
the circuit, release the lock — and it is easy to read as bookkeeping and omit.
Without it the probe succeeds, the lock is never released, and every subsequent
`allow` raises "probing recovery" forever: a healthy provider blackholed
permanently by its own recovery. Wire both calls into the caller's `try`/`except`
before you trust the breaker.

Deliberately omitted: the state is per-process. Across replicas each opens its
own circuit, which is usually acceptable — every replica learns within its own
threshold — but it means the effective probe rate is one per replica.

**Source:** [Architecture: Async AI Gateway](https://handbook.vinodspattar.in/architecture/systems/async-ai-gateway/), [`labs/async-ai-gateway`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/async-ai-gateway)
