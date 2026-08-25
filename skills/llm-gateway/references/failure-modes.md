# Failure modes

Symptom first: each section starts with what you would see on a graph, because
that is what you have when the page fires.

## A provider degrades without fully failing

**Presents as:** p99 latency climbing while the error rate stays near zero, then
a wave of timeouts at exactly your deadline value. Success rate looks fine until
it collapses all at once. Retries make it worse, not better, because every
attempt goes to the same slow provider.

**Cause:** health checks scored on error rate alone. A provider that returns
correct answers slowly is, to an error-rate check, perfectly healthy — so the
selector keeps routing into it until requests start hitting the deadline, at
which point they are attributed to *your* timeout rather than its latency.

**Do:** score providers on latency as well as success rate. Keep a latency EMA
per provider (alpha around 0.25 is a reasonable start) and sort candidates by
`(-success_rate, latency_ema, consecutive_failures)`, so a slow-but-successful
provider is deprioritised before it becomes a failing one. Eject a provider for
a fixed window after N consecutive failures, and — importantly — fall back to
the full candidate list when everything is ejected, so a global blip does not
leave the selector with nothing to return.

## Redis becomes unavailable

**Presents as:** either the gateway's latency jumping to the TCP connect timeout
on every request (no timeout on the Redis call), or the process dying on an
unhandled connection error, or — worst because it is silent — quota enforcement
quietly vanishing.

**Cause:** the quota store treated as infrastructure rather than as a dependency
with its own failure semantics. There is no correct default here; the failure is
not having chosen.

**Do:** decide fail-closed or fail-open explicitly, and write down why. Anchor
the choice to what the limiter protects: if it protects spend or a hard abuse
limit, **fail closed** — reject rather than let an unmetered flood through. If
it protects a soft fairness quota where availability matters more than perfect
enforcement, **fail open onto a tighter local emergency limit**, not onto no
limit at all. Either way:

- Put a short, explicit timeout on every quota call. It is on the request path,
  so its timeout must be small relative to the request deadline.
- Catch the connection error at startup too. Construction of the shared limiter
  should degrade to the local one, not abort the process.
- Expose which backend is live on the readiness endpoint (`"quota_backend":
  "redis" | "local"`), so "were we enforcing at the time?" is answerable during
  the postmortem rather than inferred.

## One tenant's traffic spike starves another tenant

**Presents as:** 503s and rising queue-wait for tenants whose own traffic did
not change. Per-tenant dashboards show one tenant's rate up sharply; everyone
else's latency up with it.

**Cause:** a single shared concurrency pool and a single shared upstream quota,
with no per-tenant accounting between them. A global rate limiter does not fix
this — it caps the total, which the noisy tenant is happy to consume all of.

**Do:** key the token bucket by tenant, not globally, and enforce it before
admission control so the spike is rejected at the quota gate instead of
occupying slots. Scope limits by tier rather than issuing one number for
everyone. Where isolation must be strong rather than best-effort, per-tenant
concurrency caps below the global pool size are the mechanism; a shared pool
with per-tenant rate limits in front of it is the cheaper approximation, and is
usually enough.

## A rolling deploy kills in-flight requests

**Presents as:** a clean, repeatable error spike whose timing matches your
deploys and nothing else. Streaming clients see truncated responses rather than
errors, which is why this can survive a long time undiagnosed.

**Cause:** SIGTERM handled as immediate exit. Every request the replica was
mid-processing dies, including provider calls that were already billed.

**Do:** implement bounded graceful draining, and wire it into the deploy, which
is the half that gets skipped:

- On SIGTERM, stop accepting new requests and start failing readiness so the
  load balancer removes the replica. Keep liveness passing — a draining replica
  is not a dead one, and failing liveness gets it killed instead of drained.
- Track active requests and wait for zero with a timeout (30s is a common
  budget). Return whether the drain completed, and log it when it did not.
- Set the orchestrator's termination grace period **longer** than your drain
  timeout. A 30-second drain under a 30-second grace period is a race you lose.
- Make the drain window longer than your longest expected stream, or accept
  that streams get cut and say so.

## Ephemeral-port and connection-pool exhaustion under fan-out

**Presents as:** intermittent connection errors and connect-timeout spikes under
load — never a clean capacity signal. Failures scattered across providers rather
than concentrated on one, which misdirects the investigation at the provider.
Often worse from a subset of replicas, or only behind NAT.

**Cause:** each outbound connection consumes an ephemeral port on the source
address, and NAT collapses many replicas onto one. High fan-out plus short-lived
connections exhausts the port range or the client's connection pool. Retries
amplify it precisely when it is already happening.

**Do:** use one long-lived client per provider with keep-alive, never a client
per request — creating a client per call is the single most common cause. Set
pool limits explicitly rather than inheriting a library default, and set a
connect timeout that is much shorter than the read timeout so a port-exhaustion
stall fails fast instead of consuming the whole request deadline. Alert on
connect errors as a separate series from provider errors; merged, this failure
is indistinguishable from a provider outage.

## A client disconnects mid-stream and the gateway keeps paying

**Presents as:** provider spend higher than completed-request volume explains.
Completion-rate metrics look healthy, because the requests that matter here were
never counted as failures. Nothing pages.

**Cause:** the streaming loop pulls from the provider and writes to a socket
nobody is reading. Without an explicit disconnect check, the generator runs to
completion and every token is billed.

**Do:** check for disconnection inside the streaming loop and return early — a
`return` from the generator, so the `finally` releases the concurrency slot and
the provider connection closes. Yield to the event loop each iteration so the
disconnect is actually observable. Count disconnects as their own metric,
separate from completions, and record stream duration for both: a disconnect
rate that climbs after a client-side deploy is a signal you will otherwise miss
entirely.

**Source:** [Architecture: Async AI Gateway](https://handbook.vinodspattar.in/architecture/systems/async-ai-gateway/)
