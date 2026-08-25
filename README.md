# Principal AI Engineering Skills

Eight [Agent Skills](https://www.skills.sh) for building and reviewing production AI systems —
LLM gateways, retrieval, agents, tool authorization, MCP servers, model serving, and reliability.

```bash
npx skills add vins13pattar/principal-ai-engineering-skills
```

Distilled from the [Principal AI Engineer Handbook](https://handbook.vinodspattar.in/), which is
where a person reads. These are the slice an agent can act on: the orderings that are load-bearing,
the failure modes with their symptoms, the numbers, and the checks — about a 6:1 compression of the
handbook's 112,000 words, keeping only the prescriptive half.

## The skills

| Skill | Loads when you are working on |
| --- | --- |
| [`ai-system-design`](skills/ai-system-design/) | Designing an AI system, or reviewing a design document, RFC, or ADR. Routes to the other seven. |
| [`llm-gateway`](skills/llm-gateway/) | Calling a model provider over the network — retries, timeouts, quota, provider fallback, circuit breaking, streaming, tenancy |
| [`rag-systems`](skills/rag-systems/) | Retrieval — chunking, embeddings, hybrid search, reranking, rank fusion, grounding, permission filtering, index freshness |
| [`agent-systems`](skills/agent-systems/) | Agent and tool-calling loops, task queues, workers, leases, checkpointing, resumption after crash, dead-letter handling |
| [`agent-authorization`](skills/agent-authorization/) | Letting an agent invoke a tool with real consequences — schemas, scopes, policy, human approval, delegated identity, audit |
| [`mcp-servers`](skills/mcp-servers/) | Building or hardening an MCP server — listings, the discover response, transports and sessions, cache scope, tenant isolation |
| [`model-serving`](skills/model-serving/) | Self-hosted inference — dynamic batching, KV cache, accelerator utilisation, cold starts, autoscaling, canary rollout, tail latency |
| [`ai-reliability`](skills/ai-reliability/) | SLOs and error budgets, burn-rate alerts, evaluation sets and graders, quality regression, runbook automation, incident response |

Each skill is a `SKILL.md` — rules stated as imperatives, each checkable against a diff — plus
reference files read on demand: the reference architecture, a symptom-first failure-mode catalogue,
copyable code adapted from the handbook's labs, and a review checklist ordered by how much of a
review's value each check finds.

## What these are for

A skill earns its place only if the code that comes out is different. So the editorial rule
throughout is: **if a line could have been written without reading the handbook, it was cut.**

"Use exponential backoff with jitter" is not here — every model writes that unaided. This is:

> Verify identity before checking quota; check quota before admission control; wrap the entire
> retry loop in one deadline rather than each attempt. An unauthenticated caller must not consume a
> tenant's quota, a quota-rejected request must not occupy a concurrency slot, and a caller's
> timeout is a budget for the whole operation, retries included.

Every code excerpt was executed against the lab it came from, not transcribed by eye, and every
number carries the conditions it was measured under. The handbook's labs are production-*shaped*
rather than production — several compute results from seeded hashes with fixture costs — so figures
that could not state their conditions compactly were dropped rather than quoted.

## How this relates to the handbook

The handbook covers each system from four angles — the concepts, a design review, running code, and
the interview round where it comes up — and is written for someone with time to read. These skills
are the prescriptive half only. Every reference file ends with a `**Source:**` line linking the page
it condenses, so an agent that needs the full depth knows where to send you.

Deliberately not here: general engineering the model already handles unaided (production Python,
networking, Kubernetes, cloud), and the handbook's career material (the Principal Engineer mindset,
leadership, the interview tracks). Their absence is what keeps the eight descriptions sharp enough
to trigger on the right work.

## Keeping it current

[`sources.json`](sources.json) maps every skill file to the handbook pages and lab modules it was
written from, pinned to a handbook commit. To see what a handbook change means for the skills:

```bash
node scripts/check-sources.mjs --handbook /path/to/principal-ai-engineer-handbook
```

It reports which skill files have upstream sources that changed since the pin, and fails if a
manifest path no longer exists. It never edits a skill — deciding what a handbook change means for
a 200-line skill is exactly the judgement that should not be automated.

`npm run check` validates the structure the skills.sh indexer depends on: frontmatter, kebab-case
names matching their directories, line budgets, resolvable links, and full provenance coverage.
`npm test` runs the validators' own tests. Neither needs a handbook checkout, and the repository has
no dependencies.

## Licence

[MIT](LICENSE) · **Vinod Pattar** — Principal Engineer, AI Platform & Full-Stack Architecture
