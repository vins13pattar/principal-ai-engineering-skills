# Failure thinking

Three questions do most of a review's work, and none is answerable from a
diagram: what happens when one part fails while the rest keeps running, what
breaks first when the traffic is ten times larger, and what it costs to undo the
decision if either answer is wrong.

## The fourth outcome

A local call returns, throws, or the process dies. A network call has a fourth
outcome the local one does not: **you cannot tell which of the first three
happened.** The request may never have arrived, may have executed and lost its
response, or may still be running.

So each remote call site owes one sentence: what does the caller do when it
cannot distinguish "never arrived" from "succeeded and the response was lost"? A
document that says "retry on timeout" has answered half of it. The test is
whether retrying is safe if the first attempt secretly succeeded — and when the
answer is "it double-charges" or "it double-books", the defect is not in the
network, it is in the assumption that a timeout means failure.

## Delivery semantics are an application contract, not a queue feature

No queue delivers exactly-once. Three things are available, and a design has to
name which one it is built on:

- **At-most-once** — never duplicated, sometimes lost. It drops work silently
  under load and during deploys: no error, no log line, just missing work that
  surfaces when a downstream report does not add up.
- **At-least-once** — never lost, sometimes duplicated. The practical default,
  and it moves deduplication to the consumer, which is code someone has to write.
- **Effectively-once** — at-least-once delivery plus an idempotent consumer. The
  only version of "exactly once" that holds under a real partition.

A design that cites a broker's exactly-once feature as its deduplication story
has named a vendor claim rather than a mechanism. The reviewable form names the
idempotency key, where it is stored, and how long it is kept — and the retention
window has to cover the longest plausible retry delay, or the duplicate arrives
after the key has expired and the deduplication is decorative.

## Consistency is chosen per invariant, not per system

"Should this system be strongly or eventually consistent" is the wrong question.
A payment ledger and a search index in the same system need different answers,
and so do two operations on the same path: a debit rejects rather than risk a
double-spend, a cached-recommendations read serves stale rather than nothing. A
design carrying one global consistency statement has either bought coordination
the search index never needed, or skipped it where being wrong is expensive.

## What breaks first at ten times

Ask what breaks first, not what the architecture supports. A valid answer names
a **specific bounded resource**: a connection pool, a single-writer database, a
provider quota, an in-process cache. "It scales horizontally" describes the
deployment, not the ceiling.

Run the question inward too. Statelessness is what makes horizontal scaling
work, so every piece of in-process state is a scaling decision that needs a
stated answer for the second replica:

| In-process state | What a second replica does to it |
| --- | --- |
| Rate-limiter buckets | N replicas each enforcing the limit locally grant N × that limit, silently |
| Caches | The hit rate falls with the replica count, and the backend behind it absorbs the difference |
| Dedup sets | Deduplication stops holding across replicas, which is indistinguishable from not having it |
| Session or conversation state | It now requires affinity, which is a load-balancer constraint the design has to state |

Three structural limits that look like scaling problems and are not:

- **A hot partition key does not get faster with more partitions.** One tenant
  or one entity that all traffic routes through simply takes a larger share of a
  single partition's ceiling. Check the shard key against the traffic
  distribution, not against the size of the key space.
- **Head-of-line blocking.** In a strictly ordered partition, one stuck message
  blocks every message behind it, related or not. Partition by a key that
  spreads unrelated work apart rather than one that clusters it together.
- **Consumer-group rebalancing pauses the group.** Adding consumers to relieve
  lag triggers a rebalance that briefly stops processing everywhere — so the
  scaling action produces a latency spike of its own, which matters most when an
  autoscaler is reacting to spikes.

## Blast radius

Two questions: what one component's failure takes down with it, and what one
compromised credential reaches.

- **Cascading failure travels through the shared pool.** One slow dependency
  exhausts threads, connections, or memory that requests to *other* dependencies
  also need, turning one component's failure into an outage for components with
  no relationship to it. In a document the tell is a single pool shared across
  dependencies with different latency distributions; a pool per dependency
  bounds it.
- **Isolation by structure is stronger than isolation by code.** In a shared
  multi-tenant system a missing filter is a breach; in a per-tenant deployment
  the same bug is a bug. Shared is usually the right choice, and choosing it
  obliges the filter to sit at a chokepoint every path crosses, with a test that
  proves it.
- **The data boundary is decided at design time and is extremely expensive to
  change afterwards** — which tenants, regions, and classifications share
  storage, an index, or a cache. Two tenants' embeddings in one index is the
  canonical version, and it is cheap in the week it happens.
- **The injection surfaces are not at the perimeter**: retrieved documents, tool
  descriptions, and model output feeding a downstream action. A design whose
  security section is authentication has addressed the smaller half.
- **"Who accessed what, when, and on whose behalf" is cheap up front and nearly
  impossible to reconstruct later.** It requires identity to flow through the
  system, which is structural — not a logging change that can be added in a
  sprint.

Three failure modes worth naming because each has a specific fix rather than a
general one:

- **Split brain** — two nodes both believe they own a resource, usually after a
  partition heals ambiguously. The fix is a fencing token, a monotonically
  increasing value the true owner must present. "Elect a new leader" is how
  split brain happens in the first place.
- **Retry storms** — the recovered dependency is hit by a synchronized spike the
  moment it comes back, because every client retried on the same schedule. It is
  a system-wide property, not a bug in any one client.
- **Poison pill** — one malformed or adversarial message that crashes every
  consumer reading it takes down the whole consumer group. Validate and
  dead-letter by delivery attempt rather than letting it crash consumers
  repeatedly.

## Partial failure at the seam

The seam a design most often skips is what the third component does with a
response the second one only half-returned. Arrows between boxes do not answer
that, and it is the difference between a finished design and an inventory.

Recovering cleanly from a crash needs four things, and most designs name two:

1. **Durable state** that survives the crash.
2. **A defined replay boundary** — where to resume from.
3. **Idempotent handlers**, so replayed work does not execute twice.
4. **Operator-visible progress**, so a human can tell recovery is happening and
   how far along it is.

The fourth is the one usually missing, and without it the only observable
difference between a slow replay and a stalled one is elapsed time — which means
the only action available during an incident is to restart the replay.

## Sort by reversibility

Spend review attention in this order, not the order the document is written in:

| Class | Cost to undo | Examples |
| --- | --- | --- |
| Config | Minutes | Retry policy, timeout, pool size, feature flag |
| Component | About a week | Queue technology, vector store, framework |
| Boundary | A migration, an audit, and a disclosure | Data model, tenant isolation, a public API shipped without a version |

Most decisions are two-way doors and should be made quickly by whoever is
closest to them; a few are one-way doors and deserve deliberation. The
organizational failure is treating everything as one-way, which is merely slow.
The rarer and more expensive one is treating a one-way door as reversible — and
it is cheap in the week it happens, which is precisely why it survives review.

The same axis answers how much design to do before building: decide the one-way
doors — data boundary, state ownership, external contract — deliberately and
early, and let everything else be discovered. For anything not reversible within
one deploy, the document must name the evidence that would change the decision.
A design that cannot name it has not decided; it has defaulted.

**Source:** [Module 2: Distributed Systems](https://handbook.vinodspattar.in/learn/modules/02-distributed-systems/), [Module 13: System Design](https://handbook.vinodspattar.in/learn/modules/13-system-design/), [Cheat Sheet: Design Review](https://handbook.vinodspattar.in/cheatsheets/sheets/design-review/)
