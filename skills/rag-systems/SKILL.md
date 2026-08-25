---
name: rag-systems
description: You MUST load this before writing, reviewing, or discussing retrieval — chunking, embeddings, vector or hybrid search, BM25, reranking, rank fusion, grounding, citations, index freshness, or filtering results by tenant or user permission — and before answering any question about designing a RAG pipeline. Applies to design and architecture questions with no code present.
---

# RAG Systems

## Use this when

The code under your hands puts retrieved text in front of a model, or
prepares text to be retrieved later. That includes a single
`index.search(...)` call, and it includes an ingestion job nobody has looked
at since it was written.

## Rules

1. **Put the permission filter inside the index query, never on the
   results.** Post-filtering leaks through side channels even when no
   unauthorized text is returned: result counts reveal how many restricted
   documents matched, and latency tracks corpus-wide work. It also degrades
   quality, because the top-k budget is spent on documents that are then
   discarded — so an authorized user gets worse results the more restricted
   content exists.
2. **Make the permission scope a required parameter of the search
   function.** Then "forgot to filter" is a signature mismatch a type checker
   catches, not a data leak a reviewer has to spot on every call site.
3. **Record the embedding model and its version in the index, and refuse a
   mismatch at query time.** Vectors from two models are not comparable.
   Nothing throws; relevance collapses toward random and reads as "the model
   got worse".
4. **Fuse rankings by position, not by normalized score.** BM25 is an
   unbounded IDF-weighted sum, cosine is bounded in `[-1, 1]`, and their
   distributions shift independently with query length and corpus
   statistics — so a normalization is only valid for the query it was fitted
   on.
5. **Chunk on the document's own boundaries.** Never split a paragraph unless
   that paragraph alone exceeds the budget, and carry overlap only within a
   section. What chunking destroys, no retrieval tuning recovers.
6. **Rerank the fused candidate set, never the corpus.** A cross-encoder
   costs a model call per candidate; run corpus-wide it is just a slow
   retriever. Candidate-set size is the dial, not whether to rerank.
7. **Treat top-k as a recall ceiling, not a quality knob.** Fetch wide,
   return narrow. If the answer is not in the candidates, reranking and
   prompting cannot put it there.
8. **Measure recall with the real permission filter applied.** A restrictive
   filter over an approximate index returns fewer than k results, or worse
   ones, because the filter and the ANN traversal interact. Unfiltered
   benchmark numbers do not transfer to the filtered path.
9. **Ship a labelled evaluation set with the retrieval code and fail CI on a
   regression.** Every failure on this page is silent by default; this is the
   only detector for most of them.
10. **Check every citation against the IDs actually retrieved.** A set
    difference, no model required, and it catches the answer that cites a
    chunk the retriever never returned.
11. **Propagate deletion to source, chunks, both indexes, and every cache,
    and test it end to end.** A deleted document still in a vector index is
    still retrievable and still citable — a compliance breach, not a quality
    dip.
12. **Delimit retrieved chunks in the prompt and label them with their
    provenance.** Text interpolated straight into a system prompt is
    indistinguishable from the instructions you wrote, so a corpus anyone can
    write to becomes an instruction channel.

## Deciding

| Situation | Do this | Because |
| --- | --- | --- |
| Combining lexical and vector results | Reciprocal rank fusion | "Fuse by position" — the two score scales are incommensurable |
| A cross-tenant leak would not be survivable | Separate index per tenant | A metadata filter is one missing predicate away from a breach; separate indexes are not |
| Tenancy is a label on a shared corpus | Metadata filter, passed as a required argument | Cheaper to operate, and "required argument" is what keeps it honest |
| Query is an error code, SKU, or function name | Keep the lexical path in the mix | Semantic search cannot find an exact identifier. Wrong index, not a tuning problem |
| Changing the embedding model, chunk size, or splitter | Full reindex — and for a model change, a dual-index cutover | A model change makes old and new vectors incomparable, so the spaces cannot be mixed even briefly. A chunking change re-embeds into the *same* space, but renumbers every chunk and moves the vector count the bill tracks |
| End-to-end answers are poor | Score retrieval separately before touching the prompt | Strong recall with bad answers and weak recall with bad answers have opposite fixes |

## Going deeper

| Read | When |
| --- | --- |
| [references/architecture.md](references/architecture.md) | Designing a retrieval platform, or placing access control and evaluation in it |
| [references/failure-modes.md](references/failure-modes.md) | Retrieval got worse, or you are writing the detector |
| [references/patterns.md](references/patterns.md) | You need the shape of a scoped query, rank fusion, a groundedness check, or the metrics |
| [references/review-checklist.md](references/review-checklist.md) | Reviewing someone's chunking, retrieval, or ingestion code |
