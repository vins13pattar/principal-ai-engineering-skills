---
name: model-serving
description: You MUST load this before writing, reviewing, or discussing inference you host — dynamic or continuous batching, batch size and timeout triggers, KV cache, GPU or accelerator utilisation, cold starts, replica autoscaling, canary rollout, or tail latency of a model endpoint. Applies to design and architecture questions with no code present.
---

# Model Serving

## Use this when

You operate the thing running the model. That covers the batcher in front of
it, the accelerator under it, the replica it lives on, and the rollout that
replaces it. Calling a provider you do not operate is a different problem with
different rules — retries, fallback, and per-tenant quota belong there, not
here.

Inference is a throughput problem wearing a latency budget. Optimising either
side alone produces a system that fails on the other, and two properties make
this unlike ordinary capacity work: cold start is minutes because weights have
to load, and a new version can be *worse* without being broken.

## Rules

1. **Key every metric by version, and gate the rollout on the canary's own
   numbers.** A canary taking 5 % of traffic and failing outright moves a
   blended error rate by five points — inside normal variance for most
   services, so the rollout mechanism reports healthy at exactly the moment it
   should be firing. The diff is whether the metrics container is keyed by
   version or is one counter, and whether the promote/rollback decision reads
   the per-version entry. Fold them and the canary cannot fail.
2. **Race a size trigger against a timeout, and give the race to one background
   loop.** Size-only lets a lone request wait indefinitely during a lull;
   timeout-only caps latency and wastes throughput under load. Closing on
   whichever fires first bounds the worst-case wait at the timeout, which is
   then a number you can state. `submit` enqueues and awaits its own future; it
   must never flush, or two concurrent submits form two batches.
3. **On a handler exception, complete every pending future with it.** Let the
   exception escape the flush and the background loop dies — after which every
   request already queued, and every one that arrives later, hangs until its
   caller's timeout. That is a total outage presenting as slowness. Catch
   broadly at the flush, set the exception on each waiter, and keep looping.
4. **One batcher per version, never a shared queue.** A shared queue couples the
   canary's batch size and wait time to the stable version's tuning and blends
   both into one latency distribution. Separate queues are what make
   per-version metrics mean anything.
5. **Make rollback a routing-weight change, and keep the previous version
   loaded.** A weight change is seconds and needs no build, which is what makes
   it usable during an incident. The cost is standing memory for every live
   version — count it during capacity planning rather than discovering it when
   the canary will not load.
6. **A weight-zero version still serves an explicit version request.** Dropping
   the weight stops the weighted split; a caller who named that version keeps
   being routed to it. Decide which you mean: if rollback must be total, refuse
   the pin as well, and if pinning is a compliance or reproducibility
   guarantee, then no routing change may silently move a pinned caller.
7. **Admit on the KV cache budget, re-evaluated every decode step — not on a
   fixed request count.** KV cache, not the weights alone, is what actually
   caps concurrency, and it grows with every token generated, so a request that
   fit at admission may not fit ten steps later. A static concurrency limit
   either leaves the device idle or gets preempted mid-generation under a burst
   of long contexts.
8. **Choose the autoscaling signal against a *measured* cold start.** Any
   signal with less lead time than the measured weight-load time is too late by
   construction, which is what rules out utilisation: it trails demand while
   the actuator takes minutes. Scale on queue depth and queue wait, and size
   warm headroom from the measured number rather than an estimate.
9. **Report p50, p95, and p99, split into queue wait and model time — never the
   mean.** Batching makes latency bimodal: a request arriving just after a
   batch closes waits nearly a full timeout longer than one arriving just
   before, and the mean is the average of two humps that describes neither.
   Split time-to-first-token from time-per-output-token too, since prefill and
   decode have different bottlenecks and one blended number hides which needs
   the work.
10. **Date the batch tuning, and re-run it against the traffic's
    sequence-length distribution.** Batch cost grows with the *padded* length
    of the batch, so one long sequence makes every short one in it pay for that
    length — which makes optimal batch size a property of the length
    distribution, not the request rate. Traffic mix drifts continuously and
    nothing signals that a launch-day tuning has gone stale.
11. **Ship a quality signal on the serving path, distinct from the health
    check.** A worse model returns fast, well-formed, wrong answers; liveness,
    readiness, latency, and error rate are all green throughout. Refusal rate,
    output-length distribution, or a downstream acceptance metric — something,
    however crude. A quantization or distillation change is a model change and
    needs the same evaluation, safety included, as swapping the model.
12. **Never let a batch cross a tenant isolation boundary.** Every request in a
    batch shares a failure domain: a crash while processing it fails all of
    them, and their latencies are coupled by construction. The same request
    path carries prompts and completions through a queue, a batcher, logs, and
    traces — redact at the point of logging, not downstream of it.

## Deciding

| Situation | Do this | Because |
| --- | --- | --- |
| Traffic is uneven — lulls and bursts in the same day | Race size against a timeout, and tune the pair together | "Race a size trigger against a timeout." Each trigger alone fails at one end of the range, and the two parameters have opposing effects, so neither is correct independently |
| A candidate version needs proving | Shadow for correctness, then canary for quality | Shadow exposes nobody and costs double compute while proving nothing about user-visible behaviour; a traffic split is the only thing that yields real quality signal. Sequence them, do not choose |
| Rolling back under incident pressure | Change the routing weight | "Make rollback a routing-weight change." A redeploy is minutes at the moment minutes cost most; the previous version staying loaded is the price, and it bounds how many versions can be live |
| Deciding whether to pack models onto one device | Ask whether they share an availability tier | Packing raises utilisation and couples latency, so one model's spike degrades another whose own traffic never changed. Packing a latency-sensitive model with a batch workload is the specific mistake |
| Replica takes minutes to become ready | Warm headroom sized from the measured cold start, plus a leading scale signal | "Choose the autoscaling signal against a measured cold start." Scaling to zero reintroduces the cold start on the critical path; idle warm cost is usually the smaller number |
| Throughput is short of target | Decide between batch size and replica count by which side of the SLO is under pressure | They are alternative capacity levers with opposite costs: a larger batch adds queueing delay, another replica adds spend. Neither is a default |

## Going deeper

| Read | When |
| --- | --- |
| [references/architecture.md](references/architecture.md) | Designing a serving platform, or placing batching, rollout, cost, and observability in it |
| [references/failure-modes.md](references/failure-modes.md) | Latency, a canary, autoscaling, or quality is behaving oddly and you are writing the detector |
| [references/patterns.md](references/patterns.md) | You need the shape of a batch race, per-version metrics, a weight-based rollback, or a percentile harness |
| [references/review-checklist.md](references/review-checklist.md) | Reviewing someone's batcher, router, rollout, or benchmark |
