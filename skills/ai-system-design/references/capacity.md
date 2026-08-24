# Capacity

The part of design most often waved at, and the part that is straightforwardly
executable before any code exists. Most capacity surprises are this arithmetic
not having been done.

## Little's Law is the whole of the first pass

```
concurrency = arrival_rate × average_latency
```

At 200 requests per second with an average latency of 2 seconds, 400 requests
are in flight at any moment. That single number determines connection pool
sizes, semaphore bounds, memory, and replica count — and it is derivable from
the constraints alone, in a meeting, before anyone opens an editor.

Use peak, not average. A system serving a batch job at 09:00 and a system
serving even traffic at the same daily total have different capacity needs, and
only the arrival shape distinguishes them.

## Headroom is a decision with a cost

```
usable_slots_per_replica = concurrency_limit × (1 − headroom)
replicas                 = ceil(in_flight / usable_slots_per_replica)
```

Size for peak plus about 30 % headroom, because a replica running at its
concurrency limit is a replica whose queue-wait time is about to become the
latency. Dropping headroom from 0.3 to 0.1 cuts the replica count by roughly a
fifth and moves the system much closer to the point where queue wait dominates.

Worked from the formula above: at 400 in flight and a per-replica concurrency
limit of 50, 30 % headroom leaves 35 usable slots and needs 12 replicas; 10 %
headroom leaves 45 and needs 9. Those two counts are arithmetic, not
measurements — the handbook states only the 400.

## When the numbers disagree with the configuration

If the model says 400 concurrent requests and the connection pool is configured
for 100, that is a bug found before it was written. Disagreement by more than a
factor of two is a finding in either direction, and in most running systems at
least one of computed concurrency versus configured pool, or computed cost per
day versus the invoice, disagrees by at least that much.

Do not resolve it by raising the configured number. Exactly one of four inputs
is wrong, and which one changes the fix:

- **The rate.** Average was used where peak belongs, or the peak came from a
  dashboard that averages over five minutes and has already smoothed the burst.
- **The latency.** Measured client-side, it includes queue wait, and feeding
  queue wait back into Little's Law inflates the concurrency estimate in exactly
  the situation where the system is already starved.
- **The per-replica limit.** Frequently a framework default nobody chose, and
  frequently not the binding constraint — the provider's concurrency quota or
  the accelerator's memory is.
- **The configuration.** Which is the interesting case, and the one worth
  blocking on when the gap is a factor of four.

## Run the model twice

Once with the constraints as given, once at ten times the request rate. The
second run tells you which component breaks first, which is the single most
useful thing to know about a design — and what a valid answer to that looks like
is in [failure-thinking.md](failure-thinking.md).

## The latency budget is a sum, not a target

Allocate the p99 across the path — admission, retrieval, model call,
post-processing — and the component with no room left becomes obvious before it
is built. Three properties of that sum:

- **Design against the tail.** Mean latency is a property of the system nobody
  experiences. Fan-out makes it arithmetic: a request touching ten backends sees
  roughly the p99 of one of them as its typical case.
- **Measure queue wait separately from execution.** A system starved of
  concurrency slots and a system that is genuinely slow look identical on an
  end-to-end latency chart and need opposite fixes. One series cannot be split
  after the fact.
- **Know which resource saturates first.** For AI systems it is usually provider
  concurrency or accelerator memory, not CPU — which is why autoscaling on CPU
  is the wrong signal for most of these systems.

## Cost per request is part of the arithmetic

```
cost_per_request = (input_tokens / 1000) × input_price
                 + (output_tokens / 1000) × output_price
cost_per_day     = cost_per_request × peak_rps × 86_400
```

Count the retrieval hops and the retries in those token totals; they are where
the number moves. `cost_per_day` computed at peak is deliberately pessimistic —
it applies the busiest second to all 86,400 of them. The honest version needs
the arrival shape, and discovering that nobody can supply the arrival shape is
itself a finding.

Two AI-specific properties make this a design constraint rather than a
capacity-planning footnote. Request cost varies by an order of magnitude with
context length, so an average is nearly useless without the distribution behind
it. And cost scales with traffic instead of being absorbed by fixed capacity:
ten times the traffic is roughly ten times the model spend, which makes cost per
request the thing that decides how far the design goes before it must change
shape.

## What the replica count does not tell you

Two structural choices sit underneath the replica arithmetic and cannot be fixed
by raising it. Scale the components independently: request handling, embedding
generation, and batch inference have unrelated scaling curves and should not
share a deployment unit, because the one that scales fastest then sets the cost
of the two that did not need to. And shard along the isolation boundary already
chosen — if tenancy is the data boundary it is usually also the right partition
key, and two different boundaries double the coordination.

## When the consumer cannot keep up

There are exactly four options: block the producer, shed load, buffer within a
bounded limit, or degrade service quality. An unbounded queue is not a fifth
option — it is a deferred version of the same failure, arriving later as an
out-of-memory crash instead of a clean, immediate rejection.

Queue depth and consumer lag are the leading indicators. By the time end-to-end
latency visibly degrades, the queue has usually been growing for a while. And
batching amortizes per-message overhead at the direct cost of per-message
latency: the first message in a batch waits for the batch to fill or its timeout
to fire, so a batch size chosen for throughput is a latency budget spent.

**Source:** [Module 13: System Design](https://handbook.vinodspattar.in/learn/modules/13-system-design/), [Module 2: Distributed Systems](https://handbook.vinodspattar.in/learn/modules/02-distributed-systems/), [Cheat Sheet: Design Round](https://handbook.vinodspattar.in/cheatsheets/sheets/design-round/)
