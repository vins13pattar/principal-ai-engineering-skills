# Failure modes

Symptom first, because that is what you have when someone reports it. Note how
few of these present as an error: five of the six below are visible only if you
built an instrument for them.

## Permission filtering applied after retrieval

**Presents as:** nothing, usually — the user sees only documents they may read,
so the bug survives review and demo. What is observable, if you look: result
counts that vary with the amount of restricted content matching the query, and
latency that tracks corpus-wide work rather than the asker's slice. Authorized
users quietly get *worse* results as the restricted corpus grows.

**Cause:** retrieval treated as a search problem and authorization as an
application-layer concern, so the filter lands on the result list rather than in
the query.

**Do:** filter inside the index query — a metadata predicate, a namespace, or a
per-tenant index. Make the scope a **required parameter** of the search
function, so omitting it fails a type check rather than leaking; an optional
`filters=` keyword is the shape this bug hides in. Write a test that seeds two
tenants with deliberately similar content and asserts that tenant B's chunks
never appear for tenant A regardless of similarity score. Re-check permissions
at answer time too: a long session can outlive a revocation.

## Embedding model drift between the two pipelines

**Presents as:** relevance collapsing toward random, with no error anywhere. It
reads as "the model got worse" and sends people to tune prompts, because the
retrieval code did not change and nothing throws.

**Cause:** the query side and the index side embedded with different models or
versions. Vectors from different models occupy different spaces, so similarity
between them is meaningless. Nothing structurally enforces the contract — the
same applies to a changed tokenizer, splitter, or normalization step.

**Do:** record the embedding model and version *in the index*, compare at query
time, and refuse the mismatch rather than serving it. Share one code path
between the two pipelines, or one versioned contract that both assert against.
Any embedding change is a full reindex with a dual-index cutover, not an
incremental update — treat that as the cost of the decision, up front.

## Chunking that splits the answer

**Presents as:** plausible-looking neighbours retrieved instead of the answer.
Half of a procedure's steps come back, or a table's header without its rows.
Retrieval "works" on every query you thought to try.

**Cause:** fixed-size chunking, indifferent to structure, cutting mid-sentence,
mid-table, mid-list. The chunk holding the question's keywords and the chunk
holding its answer become different chunks, and no retrieval tuning recovers
what chunking destroyed.

**Do:** cut where the document already cuts — headings, paragraphs — and split a
paragraph only when it alone exceeds the budget, on sentence boundaries. Carry
overlap across chunk boundaries within a section, not across a section change,
where the overlap is only noise. Then confirm it with the eval set: chunking
changes are exactly what the labelled set exists to score, and re-chunking later
means re-embedding the whole corpus.

## Score averaging across incommensurable retrievers

**Presents as:** a fusion that works on the queries used to tune it and behaves
unpredictably elsewhere. Typically one retriever's results dominate the merged
list, and which one changes with query length.

**Cause:** normalizing BM25 and cosine scores and averaging. The two are
different kinds of quantity — an unbounded IDF-weighted sum and a bounded
similarity — and their distributions shift independently with query and corpus,
so a normalization fitted on one query is wrong on the next.

**Do:** fuse by rank. Reciprocal Rank Fusion adds `1 / (k + rank)` per list, so
only position counts. If one retriever deserves more trust, weight its *term* in
the fusion; do not go back to comparing scores. If you need magnitude, the place
to spend it is the rerank stage, where a single scorer produces all the numbers
being compared.

## Stale index presented as current

**Presents as:** a confident answer quoting content that changed or was deleted
at the source, with a citation that looks perfect. Identical from the outside to
a generation failure, which is where the investigation usually goes first.

**Cause:** no stated freshness requirement, so the reindexing strategy was
whichever was easiest to build. Deletes are the forgotten half: a document
removed at the source but not from the index keeps being retrieved.

**Do:** state a freshness bound per corpus and pick the strategy that meets it —
reindex-on-change for near-real-time, periodic full reindex for bounded
staleness — then measure the age distribution of indexed content against the
source and alert on the bound. Propagate deletion to source, chunk store, both
indexes, and every cache, and verify it end to end; for a compliance deletion
this is not a quality concern but the whole requirement. Chunk-level provenance
is what makes the deletion traceable.

## Quality regression with no detector

**Presents as:** users trusting answers less, months after a change nobody
connects to it. "Retrieval got worse" cannot be confirmed or denied.

**Cause:** no labelled set, so retrieval quality is an impression. Every other
failure on this page is silent by default, which makes this one the multiplier
on all of them.

**Do:** build a labelled query-to-relevant-chunk set and run precision@k,
recall@k, and MRR in CI with thresholds that fail a build. Build it from real
failures — a set of questions the system already answers well measures
nothing — and grow it every time retrieval surprises you. Run it with the real
permission filters applied, since a filter over an approximate index changes
recall. Groundedness rate and zero-result rate are useful secondary detectors
that need no labels at all.

**Source:** [Architecture: Enterprise RAG Platform](https://handbook.vinodspattar.in/architecture/systems/enterprise-rag-platform/), [Module 8: RAG](https://handbook.vinodspattar.in/learn/modules/08-rag/), [RAG lookup](https://handbook.vinodspattar.in/reference/lookups/rag/)
