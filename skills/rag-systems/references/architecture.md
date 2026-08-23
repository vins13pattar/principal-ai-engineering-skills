# Retrieval architecture

## The problem the platform exists to solve

RAG systems fail quietly. Retrieval gets slightly worse after a chunking
change, answers get slightly less grounded, and nothing errors — no exception,
no failed health check, no alert. The system that was demoed working and the
system now returning subtly wrong answers are indistinguishable from outside.

Two things make that harder at organisational scale. The corpus is
permissioned, so a retrieval layer that ignores document ACLs will ground an
answer in a document the asker may not read, and the model will paraphrase it
convincingly. And ingestion and query are *two pipelines that must agree* — on
tokenization, on embedding model, on chunk boundaries — with nothing
structurally preventing them from drifting apart.

The design below treats retrieval quality as a measured property rather than an
assumed one, and access control as a retrieval-time concern rather than an
application-layer one.

## Requirements worth writing down

- **Permission-aware retrieval.** A document the asker cannot read is never a
  candidate, at any stage.
- **Pipeline symmetry.** Query-time processing matches index-time processing,
  and drift is *detected* rather than discovered.
- **Hybrid retrieval.** Lexical and semantic signals combined, because each
  fails where the other works.
- **Reranking over a bounded candidate set**, so a more expensive scorer stays
  affordable.
- **Groundedness checking.** An answer citing something never retrieved is
  detectable.
- **Continuous evaluation.** A labelled set and metrics, so a change produces a
  number that moved.
- **Freshness.** Index staleness is bounded and observable.

## Constraints that decide the design

- **Access control cannot be a post-filter.** Retrieving then discarding
  unauthorized documents leaks through result counts, latency, and any
  relevance score computed over the full corpus — and wastes the retrieval
  budget on documents that will be thrown away.
- **The two pipelines share a contract nothing enforces.** Change the embedding
  model on one side only and retrieval degrades to noise, silently.
- **Scores from different retrievers are incommensurable.** BM25 is an
  unbounded IDF-weighted sum; cosine similarity is bounded in `[-1, 1]`. Their
  distributions shift independently with query and corpus, so no fixed
  normalization makes them comparable across queries.
- **Re-embedding the corpus is expensive**, which makes the embedding model an
  unusually sticky choice for something that looks like a config line.
- **Chunk boundaries are a retrieval decision.** They determine what can ever
  be retrieved as a unit, and they are fixed at ingestion time.

## Request flow

Ingestion, ahead of time:

1. **Chunk with structure awareness.** Respect headings; never split a
   paragraph unless it alone exceeds the size budget; carry overlap across
   chunk boundaries only *within* a section.
2. **Index each chunk into both indexes** — a lexical index with IDF computed
   over the actual corpus, and a vector index — recording the embedding model
   and version alongside the vectors.

Query, per request:

3. **Apply the same processing to the query** that ingestion applied to the
   chunk: same tokenizer, same embedding model, same normalization.
4. **Search both indexes within the asker's permission scope**, as part of each
   index query rather than after it.
5. **Fuse the two rankings by position**, not by score.
6. **Rerank the fused candidates — and only those.** Cost is linear in
   candidate count, which is the whole reason the stage before it exists.
7. **Return the top-k**, and feed the same result set to two places: the answer
   path, and the evaluation harness.
8. **Check the answer's citations against the IDs actually retrieved**, so a
   fabricated reference is caught at the retrieval boundary.

**The scoping in step 4 is the architecture.** Moving it after step 6 produces
a system that behaves correctly in a demo and leaks in production: the results
handed to the user are filtered, but the ranking, the counts, and the latency
were all computed over documents the asker cannot read. Steps 3 and 1 being the
*same* processing is the second load-bearing property, and the one with no
runtime symptom when it breaks.

## Scaling

- **Permission-scoped retrieval constrains the index design.** Pre-filtering by
  ACL requires the index to support it efficiently — metadata filters,
  per-tenant partitions, or separate indexes — and that is expensive to change
  later.
- **Reranking cost is bounded by candidate-set size, not corpus size.** That is
  the entire reason a two-stage architecture exists.
- **Ingestion and query scale independently and spikily.** A bulk re-index is a
  throughput problem with no latency requirement; query is the opposite.
  Sharing a pool couples them badly.
- **Re-embedding is a migration**, needing dual-index operation and a cutover,
  because the two vector spaces cannot be mixed.
- **The two indexes grow on different curves** — inverted index size tracks
  vocabulary, vector index tracks chunk count times dimensionality — so they
  hit their limits at different times.
- **Cost and capacity track vectors, not documents.** A chunking change that
  triples chunk count triples the bill with no new content.

## Security

- **Filter by permission at retrieval time, in the index query**, never after.
- **Re-check permissions at answer time**, since a long-running session can
  outlive a revocation.
- **Treat retrieved content as untrusted input.** Documents can carry
  instructions, and grounding a model in a corpus anyone can write to is an
  injection vector with an authoritative tone.
- **Store chunk-level provenance**, so any answer traces to a document, a
  version, and an access decision.
- **Honour deletion through the whole pipeline** — source, chunks, both
  indexes, and any cache. A deleted document still in a vector index is still
  retrievable.
- **Log what was retrieved per query**, subject to redaction: "which documents
  grounded this answer" is the first question of any investigation.

## Cost

- **Embedding cost is paid twice** — once per chunk at ingestion, once per
  query. Ingestion dominates initially; query cost dominates at steady state
  and scales with traffic.
- **Re-embedding the corpus is the largest single cost event** in this
  architecture's lifetime.
- **Reranking cost scales with candidate-set size**, making that number the
  primary quality-per-dollar dial.
- **Retrieved context is generation cost.** Every chunk passed to the model is
  tokens paid for on every turn, so retrieving ten chunks where three suffice
  is a recurring bill, not a one-off.
- **Storing both indexes roughly doubles index storage.** That is the price of
  hybrid retrieval, and it is usually worth it.

## Observability

- **Retrieval metrics on a labelled set** — precision@k, recall@k, MRR — run
  continuously, not once. This is the only detector for most failures here.
- **Groundedness rate**: the proportion of answers whose citations point at
  chunks actually retrieved. A drop means the generation step is inventing
  sources.
- **Index staleness**, as the age distribution of indexed content against the
  source. Bounded staleness is a design choice; unbounded staleness is a defect.
- **Permission-filter selectivity per query.** A sudden change means an ACL bug
  or a permission-model change, and it moves quality without touching retrieval
  code.
- **Latency split by stage** — lexical, vector, fusion, rerank — because a
  rerank regression and a vector-index regression need different responses.
- **Zero-result and low-confidence rate**, the earliest signal of a corpus gap
  or a query-distribution shift.

## Trade-offs

**Rank fusion vs. score fusion.** Reciprocal Rank Fusion discards magnitude and
uses only position, which throws away real information — a document ranked
first by a wide margin scores the same as one that barely won. In exchange it
behaves consistently across queries, which normalized score averaging does not,
because BM25 and cosine distributions shift independently with query length and
corpus statistics. Consistency wins, because the alternative is only valid for
the queries it was tuned on.

**Chunk size.** Small chunks retrieve precisely and lose the context needed to
interpret what was retrieved. Large chunks carry context and dilute the
embedding, so one relevant sentence drowns in surrounding text — and costs more
context-window budget per retrieved item. Structure-aware chunking sidesteps
the worst of the trade by cutting where the document already cuts. There is no
correct default size; it is a parameter tuned against your own eval set.

**Metadata filtering vs. per-tenant indexes.** Filters keep one index, are
cheap to operate, and make cross-tenant isolation a property of query
construction — one missing predicate is a breach. Separate indexes make
isolation structural, and multiply operational cost and the per-tenant capacity
floor. The deciding question is whether a cross-tenant leak is survivable, not
which is more elegant.

**Cross-encoder reranking vs. heuristic reranking.** A cross-encoder scores
query and chunk jointly and is substantially better than any heuristic
combination of retrieval signals. It also costs a model call per candidate,
adding latency proportional to candidate-set size. The two-stage design exists
to make that affordable; the tuning question is candidate-set size, not whether
to rerank.

**Source:** [Architecture: Enterprise RAG Platform](https://handbook.vinodspattar.in/architecture/systems/enterprise-rag-platform/), [Module 8: RAG](https://handbook.vinodspattar.in/learn/modules/08-rag/), [Vector DB](https://handbook.vinodspattar.in/reference/lookups/vector-db/)
