---
name: llm-gateway
description: You MUST load this before writing, reviewing, or discussing any code that calls an LLM provider over a network — retries, backoff, timeouts, deadlines, rate limits, quota, provider fallback, circuit breakers, streaming, or per-tenant isolation. Load it ALONGSIDE any provider-SDK skill: SDK retry settings like max_retries do not bound total elapsed time, which is the bug this prevents. Applies to design questions with no code present.
---

# LLM Gateway

## Use this when

The code under your hands sends a request to a model provider you do not
operate. That includes a single `client.messages.create` call wrapped in a
retry, and it includes a multi-tenant gateway.

## Rules

1. **Order the request path: identity, then quota, then admission, then route.**
   An unauthenticated caller must not spend a tenant's quota; a
   quota-rejected request must not occupy a concurrency slot. The order is
   the design, not an implementation detail.
2. **One deadline wraps the whole retry loop.** A caller's timeout is a
   budget for the operation, retries included. Per-attempt timeouts with an
   unbounded attempt count are an unbounded call.
3. **An in-process rate limiter multiplies the quota by the replica count.**
   With N replicas each tenant gets N x their limit, silently. Beyond one
   replica, enforcement moves to a shared store.
4. **Every shared dependency needs a written degraded mode.** When the quota
   store is unreachable, fail closed or fail open onto a tighter local
   limit — decide which, in code, with a timeout on the call. Crashing and
   hanging are the failure modes to design against.
5. **Route on latency, not only on errors.** A provider that stays up and
   gets slower is the harder case; error-rate-only health checks route into
   it until it times out.
6. **Never silently reroute an explicitly requested provider.** Automatic
   fallback applies when the caller expressed no preference. An explicit
   request is an intent — for cost, compliance, or data residency — that
   outranks availability optimisation.
7. **Autoscale on saturation, not CPU.** Queue-wait time and slot saturation
   lead; an I/O-bound gateway's CPU stays flat until it falls over.
8. **Take tenant identity from a verified token.** A client-supplied header
   is a claim, not an identity.
9. **Drain on SIGTERM.** Stop accepting, let in-flight requests finish inside
   a bounded window, then exit. Otherwise every deploy drops requests.
10. **Measure queue-wait separately from provider time.** Summed together, a
    system starved of slots is indistinguishable from a slow provider.

## Deciding

| Situation | Do this | Because |
| --- | --- | --- |
| One replica, one tenant | In-process token bucket | A shared store buys nothing yet |
| More than one replica | Shared store, with a local fallback limit | Rule 3 |
| Caller named a provider | Honour it; fail rather than reroute | Rule 6 |
| Caller named none | Health-aware selection with fallback | Rule 5 |
| Provider failing repeatedly | Circuit breaker; every blocked call is an unbilled failure | Cost |
| Client disconnects mid-stream | Stop pulling tokens | You are billed for tokens nobody reads |

## Going deeper

| Read | When |
| --- | --- |
| [references/architecture.md](references/architecture.md) | Designing a gateway, or placing a component in the request path |
| [references/failure-modes.md](references/failure-modes.md) | Something is broken, or you are writing the degraded path |
| [references/patterns.md](references/patterns.md) | You need the shape of a token bucket, breaker, or deadline |
| [references/review-checklist.md](references/review-checklist.md) | Reviewing someone's gateway or provider-calling code |
