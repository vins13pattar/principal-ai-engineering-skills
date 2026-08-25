# Review checklist

Ordered by what it costs to fix later, not by where it appears in the file.
Hardest-to-reverse decisions first; cost and observability last but always.
Stop and comment at the first failing answer — the ones below it are usually
downstream of it.

## The four that find the most

1. **Is there a total deadline across all retries, or only a per-attempt
   timeout?** *Failing answer:* a per-attempt timeout with a retry loop around
   it. That is a call whose worst case is attempts x timeout plus backoff, and
   nobody has computed that number. Look for the timeout *outside* the loop.

2. **Is the rate limiter in process memory while more than one replica runs?**
   *Failing answer:* an in-process bucket plus a `replicas: 3` anywhere in the
   deployment config. Each tenant is getting three times their limit and the
   dashboards will never show it. This one is worth blocking on: the fix is a
   new dependency and a new failure mode, so discovering it after launch means
   redesigning the quota path under pressure.

3. **Does the quota-store call have a timeout, and is there a written degraded
   mode?** *Failing answer:* a bare `await redis.eval(...)` with no timeout and
   no `except`. Ask which way it fails and why that way; "we'd fix it" is not a
   mode. Check that startup degrades too — construction failing should fall back
   to a local limiter, not abort the process.

4. **Is tenant identity verified, or asserted by the caller?** *Failing
   answer:* a tenant id read from a request header, or a JWT decoded with
   `verify=False` / no audience check. Then follow it: is the tier from the same
   token used for the policy decision, or is a header trusted for that too?

## Then, in reversibility order

5. **Is an explicitly requested provider ever rerouted on failure?** *Failing
   answer:* one retry path that re-selects a provider regardless of whether the
   caller named one. Silently satisfying a compliance-motivated request from
   another vendor is a contract breach that no metric reports.

6. **Does health selection consider latency, or only errors?** *Failing
   answer:* a selector keyed on a success/failure counter alone. A provider that
   stays up and slows down is the common case and this cannot see it.

7. **Is the concurrency wait bounded?** *Failing answer:* `await
   semaphore.acquire()` with no `wait_for`. Under overload every caller queues
   and then times out, having produced nothing and paid for the wait.

8. **Is the order identity → quota → admission?** *Failing answer:* admission
   control as outer middleware with auth inside it, so unauthenticated traffic
   consumes slots. This is cheap to fix in a router and expensive to notice.

9. **Is SIGTERM handled, and does readiness fail while liveness keeps passing?**
   *Failing answer:* no signal handler, or one that fails liveness — which gets
   the pod killed rather than drained. Also check the orchestrator's termination
   grace period is longer than the drain timeout; the code is frequently right
   and the manifest wrong.

10. **Is retry backoff jittered, and is the retry predicate narrow?** *Failing
    answer:* fixed or unjittered backoff, or a bare `except Exception` that
    retries 400s and non-idempotent failures. Full jitter (`uniform(0, cap)`),
    and retry only on transport errors, 429, and 5xx.

11. **Is there one long-lived HTTP client per provider, with explicit pool
    limits?** *Failing answer:* a client constructed per request. It defeats
    keep-alive and walks into port exhaustion under fan-out, presenting as
    intermittent connection errors that get blamed on the provider.

12. **Do streaming responses detect client disconnect?** *Failing answer:* a
    generator that iterates the provider to completion with no disconnect check.
    Every abandoned stream is billed in full.

## Cost — last but always

13. **Is there a circuit breaker, and does half-open admit one probe?**
    *Failing answer:* no breaker (you are paying for calls to a provider you
    already know is failing), or a breaker that lets the whole backlog through
    on recovery and re-breaks it.

14. **If a model router is in scope, is capability filtered before cost, and is
    escalation justified by marginal cost per rescued answer?** *Failing
    answer:* sorting the fleet by price and taking the head — that picks the
    cheapest model, which is also the one that cannot do the task. And any
    escalation policy defended with "cost per correct answer": that metric moves
    the wrong way by construction here.

## Observability — last but always

15. **Are queue-wait and provider time separate series?** *Failing answer:* one
    `request_duration` histogram. Slot starvation and a slow provider then look
    identical, and they have opposite fixes.

16. **Are RED metrics labelled by provider and tenant?** *Failing answer:*
    global aggregates only. During an incident the first question is which
    tenant or provider, and an aggregate cannot answer it.

17. **Does streaming have its own instruments?** *Failing answer:*
    request-level metrics only. Time-to-first-token, stream duration, and a
    disconnect counter distinct from the completion counter — otherwise a stream
    that died at token three counts as a success.

18. **Do logs exclude prompt and response content, and carry request and trace
    IDs?** *Failing answer:* prompts logged for debugging. Log storage is
    rarely governed like a datastore, and this is the cheapest thing on this
    list to fix now and the most expensive to fix after retention.

**Source:** [Architecture: Async AI Gateway](https://handbook.vinodspattar.in/architecture/systems/async-ai-gateway/), [Cheat Sheet: Design Review](https://handbook.vinodspattar.in/cheatsheets/sheets/design-review/)
