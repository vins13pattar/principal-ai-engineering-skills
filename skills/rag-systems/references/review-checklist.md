# Review checklist

Ordered by what it costs to fix later, not by where it appears in the file.
Chunking and embedding choices head the list because reversing either means
re-processing the whole corpus; cost and observability come last but always.
Stop and comment at the first failing answer in the first two sections — the
checks below it there are usually downstream of it. The last two sections are
grouped by topic rather than ranked, and every one of them is worth asking
regardless of what failed above.

## The four that find the most

1. **Is the permission scope an argument to the index query, or a filter on its
   results?** *Failing answer:* `results = index.search(q, k=50)` followed by
   `[r for r in results if r.tenant_id == tenant]`. Also failing, more subtly: a
   scope passed as an optional keyword, which is the same bug waiting for one
   call site to omit it. Look for the scope in the *signature*, without a
   default, and for a test that seeds two tenants with similar content and
   asserts no cross-tenant result at any similarity.

2. **Does the index record which embedding model and version wrote it, and does
   a query refuse a mismatch?** *Failing answer:* the model name in a config
   file the query side reads and the ingestion side also reads — that is a
   shared constant, not a check. Nothing detects the day one of them is
   deployed ahead of the other. The same question applies to the tokenizer and
   the splitter.

3. **Is there a labelled evaluation set, and does a regression fail CI?**
   *Failing answer:* no labelled set, or one that runs on request. Every failure
   mode in this domain is silent, so a retrieval change without a number that
   moved is a change nobody can review. Ask where the cases came from too: a set
   built from questions the system already answers well measures nothing.

4. **Does chunking respect document structure?** *Failing answer:*
   `text[i:i+800]` in a loop, or any splitter indifferent to headings,
   paragraphs, tables, and lists. This is the most expensive item here to fix
   after the fact — re-chunking means re-embedding and re-indexing everything —
   and the damage is invisible because retrieval still returns plausible
   neighbours.

## Then, in reversibility order

5. **How are the lexical and vector rankings combined?** *Failing answer:*
   min-max or z-score normalization followed by a weighted average. It works on
   the queries it was tuned on. Fuse by rank instead.

6. **Is there a lexical path at all?** *Failing answer:* dense-only retrieval in
   a corpus where users search error codes, SKUs, function names, or version
   strings. Semantic search cannot find an exact identifier — that is the wrong
   index, not a tuning failure.

7. **Does the reranker run over a bounded candidate set?** *Failing answer:* a
   cross-encoder scoring everything the retriever can reach, which is a slow
   retriever with extra latency. Then check the two `k`s are separate numbers:
   fetch wide, return narrow.

8. **Was recall measured with the real permission filters applied?** *Failing
   answer:* benchmark numbers from an unfiltered index. A restrictive filter
   over an approximate index interacts with the traversal and can return fewer
   than k results, or worse ones.

9. **Does deletion propagate everywhere?** *Failing answer:* a delete path that
   updates the source and the chunk store but not both indexes and the cache,
   or one with no end-to-end test. A deleted document still in a vector index is
   still retrievable and still citable, which turns a quality bug into a
   compliance breach.

10. **Is retrieved content treated as untrusted in the prompt path?** *Failing
    answer:* chunks interpolated into the system prompt with no delimitation or
    provenance. A corpus anyone can write to is an injection channel that
    arrives sounding authoritative.

11. **Is chunk-level provenance stored?** *Failing answer:* chunks with text and
    an embedding but no document ID, version, or access decision. Then no answer
    can be traced, no deletion verified, and no retrieval logged usefully.

## Cost — last but always

12. **Would this change multiply chunk count, dimensions, or replicas?**
    *Failing answer:* a smaller chunk size, added overlap, a
    higher-dimensional embedding model, or an added replica shipped without a
    note on index size. Cost tracks those three multiplied together, not
    documents, so tripling chunk count triples the bill with no new content —
    and a model swap can raise the per-vector cost across the whole corpus at
    the same time.

13. **How many chunks reach the model, and was that number chosen?**
    *Failing answer:* `final_k` left at whatever the tutorial used. Retrieved
    context is generation cost on every turn, so ten chunks where three suffice
    is a recurring bill.

## Observability — last but always

14. **Is index staleness measured against a stated bound?** *Failing answer:* a
    reindexing strategy with no freshness requirement behind it — which means it
    was chosen for being easy to build, and the first stale-citation incident
    will be investigated as a generation bug.

15. **Is groundedness rate tracked?** *Failing answer:* citations rendered in
    the UI but never checked against what was retrieved. Unchecked citations are
    decoration, and the check is a set difference.

16. **Is latency split by stage, and are zero-result queries counted?**
    *Failing answer:* one retrieval-duration histogram and no zero-result
    metric. A rerank regression and a vector-index regression need different
    responses, and zero-result rate is the earliest signal of a corpus gap.

17. **Is permission-filter selectivity visible per query?** *Failing answer:*
    no such metric. An ACL change then moves retrieval quality with no change to
    retrieval code, and nothing connects the two.

**Source:** [Architecture: Enterprise RAG Platform](https://handbook.vinodspattar.in/architecture/systems/enterprise-rag-platform/), [Module 8: RAG](https://handbook.vinodspattar.in/learn/modules/08-rag/), [Vector DB](https://handbook.vinodspattar.in/reference/lookups/vector-db/), [Cheat Sheet: Design Review](https://handbook.vinodspattar.in/cheatsheets/sheets/design-review/)
