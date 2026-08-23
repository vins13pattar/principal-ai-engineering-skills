# Patterns

Excerpts adapted from the lab, trimmed to the load-bearing lines.

One condition applies to all of them: the lab's embedding function is
deterministic feature hashing, not a model. It exercises the vector path and
keeps every test reproducible, but it has no semantic similarity — a query and a
chunk expressing the same idea in different words score near zero. The *shapes*
below transfer; no retrieval result measured on that stand-in does.

## Scope passed as an argument, not applied afterwards

Serves the rule this skill exists for, and does it in the type system rather
than in a comment.

```python
class VectorIndex(Protocol):
    async def search(
        self, query_vector: list[float], top_k: int, tenant_id: str
    ) -> list[Chunk]:
        """Implementations MUST filter by tenant_id inside the index query
        itself — never fetch candidates first and filter afterward."""
        ...


async def retrieve(
    query: str,
    tenant_id: str,
    embed: Callable[[str], list[float]],
    index: VectorIndex,
    reranker: Reranker,
    candidate_k: int = 50,
    final_k: int = 5,
) -> list[Chunk]:
    query_vector = embed(query)
    candidates = await index.search(query_vector, top_k=candidate_k, tenant_id=tenant_id)
    reranked = await reranker.rerank(query, candidates)
    return reranked[:final_k]
```

`tenant_id` is a **positional, non-defaulted parameter of `search`**, and that
is the entire point: a call site that forgets it is a signature mismatch a type
checker rejects, where an optional `filters=` keyword is a runtime leak nobody
sees. Copy that shape onto per-user ACLs too — pass the principal's readable-set
predicate, not a post-filter callback.

The two `k`s are the second decision. `candidate_k` is the recall ceiling for
everything downstream, `final_k` is what the model pays tokens for, and they are
separate numbers because they answer different questions. Reranking the top 5
cannot rescue a retriever that missed at 5.

Deliberately omitted: the re-check at answer time. A session can outlive a
revocation, so authorization at retrieval is necessary and not sufficient.

## Reciprocal rank fusion

Serves "fuse by position": it never looks at a score, so it cannot be corrupted
by two scales that shift independently.

```python
DEFAULT_RRF_K = 60


def reciprocal_rank_fusion(
    rankings: Sequence[Sequence[str]], *, k: int = DEFAULT_RRF_K
) -> list[tuple[str, float]]:
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, doc_id in enumerate(ranking, start=1):
            scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
```

The signature takes `Sequence[Sequence[str]]` — ID lists — so the scores are
gone before fusion begins and no future edit can reintroduce them. `k` damps the
head of each list: at `k = 60` the gap between rank 1 and rank 2 is small, so a
document both retrievers ranked well beats one that only the strongest retriever
loved. Lower `k` makes each list's top result dominate; that is the knob, and it
is a different knob from per-retriever weight.

Deliberately omitted: weighting. To trust lexical more, multiply that ranking's
`1 / (k + rank)` term — do not go back to comparing raw scores.

## Groundedness as a set difference

Serves "check every citation against the IDs retrieved", and needs no model to
do it.

```python
_CITATION_RE = re.compile(r"\[([\w\-#]+)\]")


def check_groundedness(answer: str, retrieved_chunk_ids: frozenset[str]) -> frozenset[str]:
    """Return the cited chunk IDs that were never actually retrieved."""
    cited = frozenset(_CITATION_RE.findall(answer))
    return cited - retrieved_chunk_ids
```

Two set operations catch the crude failure — a citation pointing at a chunk ID
that was never in context, meaning the model invented the reference outright.
Cheap enough to run on every answer, which is what makes it a usable production
signal rather than an offline check.

Deliberately omitted: whether the cited passage *supports* the claim beside it.
That needs a model or a human; this is the free half.

## Retrieval metrics, per labelled case

Serves "ship a labelled evaluation set": these three lines are the detector for
almost everything in `failure-modes.md`.

```python
hits = [chunk_id for chunk_id in retrieved_ids if chunk_id in relevant]
precision = len(hits) / len(retrieved_ids) if retrieved_ids else 0.0
recall = len(set(hits)) / len(relevant) if relevant else 0.0

reciprocal_rank = 0.0
for rank, chunk_id in enumerate(retrieved_ids, start=1):
    if chunk_id in relevant:
        reciprocal_rank = 1.0 / rank
        break
```

Report all three, because they fail apart. Precision asks how much of what came
back was relevant, recall asks how much of what was relevant came back at all,
and MRR asks how far down the list the first good result sat — a retriever can
be precise and incomplete, or complete and noisy, and one number hides which.

Note the denominator: `precision` divides by results *returned*, not by `k`, so
a retriever that returns two results and gets both right scores 1.0. That is the
right choice for the metric and the wrong number to compare across runs with
different result counts — pin `k` and the filter set before comparing anything.

**Source:** [Lab: Hybrid Retrieval and Evaluation](https://handbook.vinodspattar.in/build/labs/hybrid-retrieval/), [Module 8: RAG](https://handbook.vinodspattar.in/learn/modules/08-rag/), [`labs/hybrid-retrieval`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/hybrid-retrieval)
