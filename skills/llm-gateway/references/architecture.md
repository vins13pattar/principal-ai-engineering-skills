# Gateway architecture

## The problem the gateway exists to solve

An application calling a provider directly inherits every one of that
provider's failure modes and adds none of its own protection: a slow provider
makes every caller slow, an outage is a full outage, and one caller's burst
consumes the shared upstream quota everyone else depends on. A gateway is
worth its complexity only if it protects itself, protects the providers behind
it, and gives each tenant an isolated share — and stops there. A gateway that
is harder to operate than the problem it replaced is a net loss.

## Requirements worth writing down

Functional:

- Route to a named provider (explicit selection) **or** choose the healthiest
  available one (automatic selection). These are two different code paths with
  different correctness rules; see the trade-off below.
- Both request/response completions and token-by-token streaming. Streaming is
  not "the same call with a flag" — it has its own cancellation, telemetry, and
  billing behaviour.
- Tenant identity resolved from verified credentials.

Non-functional, stated as the properties that actually drive design:

- **Bounded p99 under load.** A fast, honest rejection beats an unboundedly
  slow success. This is what makes a bounded queue wait correct rather than
  rude.
- **Bounded blast radius.** One bad provider or one noisy tenant must not
  degrade everyone.
- **Horizontally scalable with no replica as a bottleneck.**
- **Safe to redeploy at any moment.** In-flight requests drain rather than die.

## Constraints that decide the design

- Multiple stateless replicas behind a load balancer. Nothing that must be
  correct across all of them can live in one replica's memory.
- Every provider is a third-party HTTP API with its own rate limits, no uptime
  SLA you control, and latency you can only route around — never influence.
- No supporting dependency (Redis, say) may be a hard dependency whose outage
  is a full outage. Each needs an explicit degraded mode.
- Tenant identity comes from a verified JWT — issuer, audience, expiry, and key
  rotation via JWKS. A header is acceptable only on a demo path.

## Request flow

1. **Verify identity.** Decode and verify the bearer token; extract tenant and
   tier. Invalid → 401, before any shared resource is touched.
2. **Check tenant quota.** Token bucket keyed by tenant, in the shared store
   when there is more than one replica. Exceeded → 429.
3. **Admission control.** Acquire a concurrency slot with a *bounded* wait.
   Saturated past that wait → 503.
4. **Start request telemetry.** Request ID, RED metrics, trace span — from here
   on, so the span covers work the gateway actually performed.
5. **Enter the deadline.** One timeout wrapping everything below, including all
   retries and all backoff sleeps.
6. **Select a provider.** Honour an explicit request; otherwise pick by health,
   scored on latency and success rate together.
7. **Call the provider; retry transient failures** inside the deadline from
   step 5, re-selecting between attempts only when the caller named no provider.
8. **Return the response or stream**, releasing the slot in a `finally`.

**The ordering is the architecture.** Identity precedes quota because an
unauthenticated caller must not be able to burn a tenant's budget — the pre-auth
path is the one an attacker controls. Quota precedes admission because a request
that will be rejected for quota must not first sit in the concurrency queue,
which would let a rate-limited tenant occupy the slots that paying traffic
needs. Admission precedes the deadline because time spent waiting for a slot is
queue time, not provider time, and the two are diagnosed differently. And the
deadline wraps the retry loop rather than each attempt, because the caller gave
you a budget for *the operation*: three attempts at a 15-second per-attempt
timeout is a 45-second call, and nobody asked for one.

A reviewer who can recite the components but not this ordering has not
understood the design.

## Scaling

- **Stateless replicas scale trivially; the question is what is not actually
  stateless.** The in-process rate limiter is the canonical example — it
  silently multiplies every tenant's effective quota by the replica count.
- **Outbound connections hit ephemeral-port and connection-pool ceilings
  before they hit anything that reports as capacity**, especially at high
  fan-out behind NAT. It surfaces as intermittent connection errors under load,
  not a clean saturation signal. Set explicit pool limits (`max_connections`,
  `max_keepalive_connections`) and a separate, short connect timeout, so the
  ceiling is one you chose.
- **Autoscale on saturation, not CPU.** Queue-wait time and slot saturation
  lead. An I/O-bound gateway's CPU is flat right up until it falls over, so a
  CPU-triggered policy scales after the incident.

## Security

- Tenant identity from a verified JWT, never a client header alone.
- **Tier-scoped provider and model policy enforced at the routing layer**, not
  left to the caller's honesty. The same policy object is the natural place to
  cap the caller-supplied timeout — otherwise a client can hold a concurrency
  slot for as long as it likes by asking for a long deadline.
- Secrets (signing keys, Redis credentials, provider API keys) injected at
  runtime from a secrets manager. Rotate on a schedule.
- Redis authenticated and encrypted in transit. It holds quota state and
  credentials, which makes it part of the security boundary, not a cache.
- Emit audit events for policy denials and privileged provider selection, so
  "who was denied what, and why" is answerable after the fact.

## Cost

- **Provider tokens dominate; gateway compute does not.** Decisions that
  eliminate wasted provider calls have far more leverage than any gateway-side
  optimisation, so spend the design effort there.
- **A circuit breaker is a cost control as much as a stability one.** Every
  call it blocks is a call that would have been billed and still failed.
- **Detect client disconnects on streams.** A closed connection while the
  gateway keeps pulling tokens is pure waste, and it is invisible in
  completion-rate metrics.
- **Cost per correct answer is a trap metric for routing decisions.** Measured
  on a fixed workload, escalating from a cheap model to an expensive one when
  the cheap one looks unsure raised accuracy 19% and made cost per correct
  answer 11x *worse* — and the relationship held at 75x, 10x, 5x, and 2x price
  ratios. The arithmetic is the cause: a cheap model already right most of the
  time contributes many cheap correct answers, so the average can only move up.
  The number that actually decides is the **marginal cost per rescued answer**,
  `(escalated_cost - baseline_cost) / (escalated_correct - baseline_correct)`,
  weighed against what a wrong answer costs you — a product question the router
  must not pretend to answer.
- **Filter on capability before sorting on cost.** A router that sorts by price
  first picks the cheapest model in the fleet, which is also the one that cannot
  do the task. Cheap, fast, and wrong.
- Redis and observability are real but secondary. Optimise them last.

## Observability

- **RED metrics per provider and per tenant**, not only globally. One aggregate
  latency number hides which tenant or provider is degraded, which is the only
  fact you need during an incident.
- **Queue-wait time as its own series, separate from provider execution time.**
  Summed, a gateway starved of slots looks exactly like a slow provider, and
  the two have opposite fixes.
- **Traces spanning identity, quota, routing, retries, and the outbound call**
  — enough to answer where one slow request spent its time without guessing.
- **Streaming needs its own instruments:** time-to-first-token and total stream
  duration as separate percentile distributions, and a disconnect counter
  distinct from the completion counter. A stream that dies at token 3 and one
  that completes both "succeeded" in a request-level metric.
- **Structured logs correlated by request and trace ID, excluding prompt and
  response content.** Log storage is rarely governed like a datastore.

## Trade-offs

**A demo entry point vs. a hardened one.** Keeping an unauthenticated demo path
separate from the JWT-and-policy path keeps the reliability patterns legible
without every example threading through an identity provider. It is a teaching
split, not a deployment topology: a real deployment is one app with the security
layer always on. Two entry points in production means two code paths to keep in
sync, and the unauthenticated one is the one that gets forgotten.

**In-process vs. distributed rate limiting.** In-process is simpler and has no
external dependency, and is wrong the moment there is a second replica.
Distributed is correct across replicas at the cost of a new dependency and a new
question you must answer in code: what enforcement does when that dependency is
down.

**Automatic fallback vs. an explicit provider request.** Automatic fallback
maximises availability. But a caller who named a provider named it for a reason
— cost, compliance, data residency — and silently rerouting them substitutes
your availability preference for their requirement. Auto-fall-back only when no
provider was requested; when one was, fail.

**Health routing is not model routing.** Routing between interchangeable
providers by observed health, and routing between models of different capability
and price by what the task needs, are different problems that share almost no
logic. Keep them in separate components; a single "router" that does both ends
up making capability decisions from latency data.

**Source:** [Architecture: Async AI Gateway](https://handbook.vinodspattar.in/architecture/systems/async-ai-gateway/), [Model Router](https://handbook.vinodspattar.in/build/labs/model-router/)
