---
name: ai-system-design
description: Use when designing an AI system before writing it, or reviewing someone else's design document, architecture proposal, RFC, or ADR — constraints, capacity estimates, state ownership, failure and blast radius, reversibility, rollout, cost, and observability.
---

# AI System Design

## Use this when

You have a design document and an hour, or a blank page and a system that does
not exist yet. This skill is the method, not the domain: what makes a design
reviewable, and where in it the hour is worth spending. If the design is about
one specific system, the last section routes you to the skill that knows it.

**A design is a set of falsifiable claims, not a diagram.** A diagram says what
the parts are. A design says what the system will do — this many requests per
second, at this p99, for this cost per call, degrading in this specific way
when the retrieval index is stale — and each of those is a claim a measurement
can refute. Anything that cannot be refuted is decoration, however well drawn.

Four things separate this from reviewing a conventional distributed system, and
all four are ways a design can be wrong while reading as complete. The dominant
component degrades without erroring, so quality needs its own signal and its own
regression gate. Cost per request is a first-class constraint, not a
capacity-planning footnote. Latency is dominated by something you neither
control nor can profile. And the system has injection surfaces — retrieved
documents, tool descriptions, model output that feeds an action — that perimeter
authentication does not touch.

## Rules

1. **Read the constraints before the diagram, and treat adjectives as the
   finding.** "High scale", "low latency", "scalable" are not constraints and a
   design built on them cannot be checked. If the constraints section contains
   no number and no named party, stop there and say so — every comment below it
   is unanchored, because you would be reviewing the diagram against your own
   assumptions. Six answers make the rest reviewable: peak rps and arrival
   shape, a p99 target and what happens when it is missed, what "correct" means
   and how a regression would be detected, whose data it is (tenant, region,
   retention), cost per call, and the failure budget.
2. **Test whether the requirements would change the design.** Swap the volume or
   latency target on paper and re-read the architecture. If it is identical, the
   numbers are decoration and the components were chosen before the constraints
   they are supposed to satisfy. This is a two-minute check and it is the fastest
   way to tell a design from a technology list.
3. **Do the capacity arithmetic yourself, then compare it against the
   configured numbers.** `concurrency = arrival_rate × average_latency` — 200 rps
   at 2 s average is 400 in flight, which is the number that sets pool sizes,
   semaphore bounds, and replica count. If the design computes 400 and the pool
   is configured for 100, that is a bug found before it was written. Disagreement
   by more than a factor of two is a finding in either direction; over-provision
   is paid for daily.
4. **Sort review attention by what fixing it would cost, not by document
   order.** Config change (minutes) → component swap (a week) → data model or
   tenant boundary (a migration, an audit, and a disclosure). Ask the author
   which decision is hardest to reverse; if they cannot name one, that is the
   finding worth the hour, and the rest of the review is commentary.
5. **Do not litigate a two-way door.** If it is reversible within one deploy and
   the author owns the code, let it go. The mirror obligation is what makes that
   affordable: for anything *not* reversible in one deploy, require the document
   to name the evidence that would change the decision. A design that cannot
   name it has not decided, it has defaulted.
6. **Trace one request end to end and name the seam nobody described.** Retries,
   partial failure, what holds state, what happens on redeploy. A component
   inventory is not a request path — the test is whether you can say what the
   third component does with a response the second one only half-returned.
7. **Ask what would refute each claim.** Every claim needs a measurement and a
   threshold for acting. "It will scale" and "retrieval quality is sufficient"
   are not reviewable; "recall@10 stays above 0.85 on the labelled set, checked
   on every index rebuild" is, and the difference is that the second one names
   the event that causes the regression rather than a schedule.
8. **Require a quality signal, not only a latency one.** The design that is
   available, fast, and within budget while its answers have been degrading for
   six weeks is the failure this discipline exists to prevent, and no latency
   monitor can see it. Ask for an eval set, a threshold, and an owner. "No
   evaluation story" is the most common gap in otherwise strong designs.
9. **Make "what breaks first at 10×" name a specific bounded resource.** A
   connection pool, a single-writer database, a provider quota, an in-process
   rate-limiter bucket. "It scales horizontally" is not an answer. The same
   question run inward: every piece of in-process state — limiter buckets,
   caches, dedup sets, session data — needs a stated answer for what happens on
   the second replica.
10. **Comment on cost and observability last, but always.** They are the two
    sections most often missing and the two that predict operability. In AI
    systems cost scales with traffic rather than being absorbed by fixed
    capacity, so 10× traffic is roughly 10× model spend — which makes cost per
    request the constraint that governs how far this design goes before it must
    change shape. A design with no stated cost reads as one whose costs were
    never understood.
11. **Separate blocking from non-blocking findings explicitly, in writing.** A
    review that mixes them is read as all-optional or all-mandatory, and both are
    wrong. Every blocking comment must also say how you would know it was fixed;
    without that it is a preference delivered in a stronger tone.
12. **Do not rewrite the design as the one you would have written** — that is a
    different document, not a review. Each comment names the constraint you are
    reasoning from, the failure you predict concretely, and what would change
    your mind. With all three it is hard to dismiss and easy to act on; with
    none it reads as preference and gets treated as such. And never approve
    because it is well written: prose quality and design quality are
    uncorrelated.

## Deciding

| The section you are reading | Ask | If the answer is missing |
| --- | --- | --- |
| Constraints | Peak rps and arrival shape, p99 target and the behaviour when it is missed, what "correct" means, whose data, cost per call | Stop and comment here. Everything below is unanchored |
| Capacity | Does `arrival_rate × latency` agree with the configured pool, semaphore, and replica counts? | The bounds were chosen by default rather than by arithmetic, and it surfaces at launch |
| State | Who owns it, what a failure loses, what happens on the second replica | Two owners, or in-process state, is a scaling decision made by omission |
| Retries and failure | Bounded attempts *and* one bounded total deadline, jitter, an idempotent handler — then what breaks first at 10×, and the blast radius of full compromise | An unbounded call and an unnamed bounded resource, discovered together during the first incident |
| Data and quality | Is permission filtering inside the query or applied after retrieval? Is there an eval set, a threshold, and an owner, or only latency monitoring? | The two AI-specific failures that no latency dashboard reports |
| Rollout | Reversible in one deploy? If not, what evidence would change the decision? | An irreversible decision made casually, which is cheap this week and expensive for years |

## Going deeper

| Read | When |
| --- | --- |
| [references/review-checklist.md](references/review-checklist.md) | You are reviewing a document and want the sequence, the per-section questions, and the habits that waste the hour |
| [references/capacity.md](references/capacity.md) | Checking or producing the arithmetic — concurrency, replicas, latency budget, cost per request |
| [references/failure-thinking.md](references/failure-thinking.md) | Working out blast radius, what breaks first at 10×, partial failure, or how to sort by reversibility |

## If the design is about something specific

This skill stops at the method. Where a question is domain-specific, the answer
lives in one of these, along with the decision that dominates that system.

| The work involves | The decision that dominates it | Also load |
| --- | --- | --- |
| Calling a model provider — retries, deadlines, quota, fallback, per-tenant isolation | Where quota state lives; per-replica buckets multiply a tenant's limit by the replica count | `llm-gateway` |
| Retrieval — chunking, embeddings, hybrid search, reranking, grounding, citation | Permission filtering inside the index query, never after retrieval | `rag-systems` |
| Work that outlives its request — agent loops, task queues, leases, checkpoints, graphs | At-least-once is the ceiling; exactly-once *effect* comes only from idempotent handlers | `agent-systems` |
| A model invoking a tool with real consequences — scopes, approval, delegated identity, audit | The model is not a trust boundary; validation, scope, quota, and approval run in the runtime in a fixed order | `agent-authorization` |
| The server side of MCP — listings, per-request auth, cache scope, tenant isolation | The credential belongs on the transport, where every request it sends carries it; and a filtered listing is not authorization | `mcp-servers` |
| Inference you operate — batching, KV cache, accelerators, replicas, canary rollout | Cold start is minutes, so any trailing scaling signal is too late by construction | `model-serving` |
| Operating the platform — SLOs, error budgets, burn-rate alerts, evals, incident response | Alerting, scaling, and incident response must read one severity computation | `ai-reliability` |
