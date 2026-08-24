# Model serving platform architecture

## The problem the design exists to solve

The accelerator is expensive and idle unless it is processing many requests at
once. Batching is what keeps it busy — and every request in a batch waits for
that batch to form. Optimising either objective alone produces a system that
fails on the other: a batch-size-only tuning gives excellent utilisation and
unusable tail latency, and a latency-only tuning gives an accelerator running
at a fraction of what it cost.

Two further properties separate this from ordinary service capacity planning.
**Cold start is measured in minutes**, because weights have to be loaded, so
reactive autoscaling adds capacity after the spike that triggered it has
passed. And **a new model version can be worse without being broken** — faster,
well-formed, and wrong. No health check detects that.

Underneath, one request is two workloads with opposite characteristics.
*Prefill* processes the whole prompt in one forward pass: all tokens are known
up front, so it parallelises and saturates compute. *Decode* emits one token at
a time, each depending on the last, and each step reads the entire weight set
and the growing KV cache out of memory to produce a single token — so decode is
bounded by memory bandwidth, and most of the device's compute sits idle during
it. A device serving one request at a time is not compute-bound; it is
bandwidth-bound. That single fact is why batching decode steps together is the
highest-leverage change available before anything else is worth trying.

## Requirements worth writing down

- **Bounded added latency.** Batching must not let any request wait longer than
  a stated bound.
- **High accelerator utilisation**, since idle capacity is the dominant cost.
- **Safe version rollout.** A new model reaches a small traffic slice first,
  with its own metrics.
- **Fast rollback**, without a deploy.
- **Tail-latency visibility.** p95 and p99, because the mean hides the failure
  batching introduces.
- **Cold-start-aware scaling**, driven by a signal that leads demand rather
  than trailing it.
- **Workload isolation**, so one model or tenant cannot starve another on
  shared hardware.

## Constraints that decide the design

- **The throughput/latency trade cannot be optimised away, only positioned.**
  There is no configuration that wins on both; there is only one matched to the
  actual traffic and SLO.
- **Cold start bounds how reactive scaling can be.** If a replica takes minutes
  to serve traffic, any signal with less lead time than that is too late by
  construction — not merely suboptimal.
- **Batch cost is not linear in batch size.** It grows with the padded sequence
  length of the batch, so one long sequence makes every short one in that batch
  pay for its length.
- **Accelerator memory caps concurrency, and the KV cache is usually what
  actually caps it** — not the weights alone. The cache grows linearly with
  sequence length and with concurrent sequences, and competes with the weights
  for the same finite memory.
- **Quality regressions are invisible to infrastructure.** Liveness, readiness,
  and error rate all stay green while output quality falls.

## Request flow

As transitions rather than a diagram:

1. **The router picks a version** for the request — weighted across the
   registered versions, or the one the caller named explicitly.
2. **The request joins the pending queue for that version** and awaits its own
   future. Each version owns its own queue; nothing is shared between them.
3. **A background loop races two closing conditions.** It waits on a
   batch-full event under a timeout: the batch closes when the size limit is
   reached **or** when the wait timer expires, whichever fires first.
4. **The loop takes the pending list, swaps in an empty one, and clears the
   event** — under the same lock the submitting side takes, so a request
   arriving mid-flush lands in the next batch rather than a closing one.
5. **One handler call runs the whole batch**: `handler(payloads) → outputs`.
   This is the amortisation the whole mechanism exists for.
6. **Every pending future is resolved** — with its output on success, and with
   the raised exception on failure, one per waiter, so the loop survives to
   form the next batch.
7. **Per-version metrics record the outcome** — request count, error count,
   latency — against the version that served it, never against an aggregate.
8. **Promote and rollback adjust weights**, which changes step 1 for subsequent
   requests and nothing else. No deploy, no reload, no restart.

**Steps 3 and 7 are where the design lives.** The race in step 3 is what lets
one configuration serve both a lull and a burst; it is also two coupled
parameters that must be tuned together against a real traffic distribution
rather than independently. The per-version split in step 7 is what makes step 8
a control rather than a gesture: blended into an aggregate, a canary at a small
traffic share cannot move the number enough to trip anything.

Note what step 1 does *not* do. An explicit version request bypasses the
weighting entirely, so a version dropped to zero weight still serves any caller
who names it.

## Scaling

- **Scale on queue depth and wait time, not utilisation.** Both lead demand;
  utilisation trails it, and with minutes of cold start a trailing signal
  produces capacity that arrives after the spike and is scaled back before the
  next one — oscillation, paid for continuously.
- **Keep warm headroom rather than scaling to zero**, unless the traffic
  pattern is genuinely scheduled. The idle cost of a warm replica is usually
  smaller than the tail-latency cost of a cold start on the critical path.
- **Batch size and replica count are alternative capacity levers** with
  different latency consequences: a larger batch adds queueing delay, another
  replica adds cost. Which to reach for depends on which side of the SLO is
  under pressure.
- **Length-aware batching beats naive batching at scale**, because grouping
  similar-length sequences reduces the padding waste that makes large batches
  stop paying for themselves.
- **Continuous batching is the admission-control form of the same idea.**
  Rather than holding a fixed batch to completion, re-evaluate composition at
  every decode step: evict a finished sequence immediately, free its cache
  pages, and prefill a queued request into the slot. Static batching leaves the
  slot idle until the slowest member of the batch finishes.
- **Version count multiplies memory pressure**, since each live version holds
  its own weights and KV cache. Canarying is not free in capacity terms, and
  that is what bounds how many versions can be live at once.
- **A load balancer in front of replicas needs cache-occupancy awareness.**
  Round-robin can route a large request to a replica already near its KV cache
  ceiling while another sits half-empty.

## Security

- **A shared batch is a shared failure domain.** A crash while processing a
  batch affects every request in it, so batch composition must not cross a
  tenant isolation boundary that matters — and one tenant's burst of huge
  prompts otherwise consumes another's latency budget on the same device.
- **Prompts and completions are user data**, frequently sensitive, and pass
  through queues, batchers, logs, and traces. Every one of those is a place
  they can be retained by accident. Redact before logging, not after: sampled
  request logging is the standard way prompt content escapes into systems with
  different retention rules.
- **Model weights are assets.** Access to the serving host is access to the
  weights — a supply-chain and IP concern distinct from data protection.
- **Version pinning must be enforceable.** A caller entitled to a specific
  version for compliance or reproducibility must not be silently served another
  by a routing change.
- **A quantized or distilled model needs its safety evaluation re-run.** It can
  regress on safety-relevant behaviour that a pure accuracy benchmark will not
  catch, so treat the precision change as a model swap.

## Cost

- **Idle accelerator time is the dominant line item**, which is what makes
  batching a cost mechanism before it is a performance one.
- **Padding waste is real spend.** Batching mixed-length sequences means paying
  for the padding, so length-aware batching is a cost optimisation as much as a
  latency one.
- **Decode throughput usually dominates cost per token** for chat-shaped
  workloads, because output tokens outnumber the input processed per decode
  step — which is why continuous batching, which specifically improves decode
  utilisation, has an outsized effect on the bill.
- **Every live version costs memory** whether or not it serves traffic, so
  canary and rollback headroom is a standing cost, not an incident-time one.
- **Warm headroom is bought deliberately** as insurance against cold-start
  latency, and should be sized from the traffic pattern rather than left at
  whatever the default was.
- **Quantization buys concurrency with accuracy.** Lower precision cuts memory
  footprint and bandwidth pressure roughly in proportion, speeding the
  bandwidth-bound decode phase and fitting more cache in the same memory. How
  much accuracy loss is acceptable is a product decision measured against an
  evaluation harness, never assumed from a vendor benchmark.
- **Tokens are the unit that scales with traffic**, so context growth upstream
  — in retrieval, in agent loops — lands here as a serving bill.

## Observability

- **p50, p95, and p99 latency**, split into queue wait and model time. Mean
  latency is actively misleading for a batching system.
- **Time-to-first-token and time-per-output-token as separate series.** They
  are bounded by prefill and decode respectively, with different bottlenecks;
  conflated into one "latency" they hide which phase needs the work.
- **Per-version everything** — error rate, latency, throughput, and a quality
  signal — never blended, or the canary mechanism cannot function.
- **Batch size distribution and time-to-fill.** Batches consistently closing on
  timeout rather than size mean the size limit is not the binding constraint
  and the wait is pure added latency.
- **Queue depth and wait time as the scaling signal**, exported at a resolution
  useful to a controller rather than to a dashboard.
- **Accelerator utilisation and memory headroom**, with KV cache occupancy
  separated from weights, since that is what actually caps concurrency.
- **A quality metric on the serving path**, however crude — refusal rate,
  output length distribution, downstream acceptance. Infrastructure health
  cannot substitute for it.

## Trade-offs

**Racing a size trigger against a timeout.** A size-only trigger maximises
throughput and lets a lone request wait indefinitely at low traffic. A
timeout-only trigger caps latency and wastes capacity under load. Racing both
takes the better half of each, at the cost of two coupled parameters that must
be tuned together against a real traffic distribution rather than
independently.

**Canary by traffic split vs. shadow evaluation.** A traffic split exposes real
users to a candidate version and yields real quality signal. Shadow evaluation
runs the candidate on mirrored traffic with output discarded, exposing nobody —
and costing double compute while proving nothing about user-visible behaviour.
Shadow first for correctness, canary for quality, is the usual sequence.

**Dedicated accelerators vs. multi-model packing.** Dedicated capacity gives
predictable latency and leaves expensive hardware idle between spikes. Packing
raises utilisation and couples the latency of unrelated models. The deciding
question is whether the models share an availability tier — packing a
latency-sensitive model with a batch workload is the specific mistake.

**Rollback by routing weight vs. by redeploy.** Weight-based rollback is
seconds and needs no build, which is what makes it usable during an incident.
It requires the previous version to still be loaded, consuming memory that
bounds how many versions can be live. Redeploy-based rollback frees that memory
and is far too slow when it matters.

**Source:** [Architecture: Model Serving Platform](https://handbook.vinodspattar.in/architecture/systems/model-serving-platform/), [Module 9: Model Serving](https://handbook.vinodspattar.in/learn/modules/09-model-serving/), [Lab: Dynamic Batching Inference](https://handbook.vinodspattar.in/build/labs/dynamic-batching-inference/) (its batch-formation diagram, which supplied the request flow)
