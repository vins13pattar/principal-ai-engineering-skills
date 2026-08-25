# Verification results

Run 2026-08-25. Trials defined in [`TRIALS.md`](TRIALS.md).

## Summary: the rules work; the descriptions do not fire

The trials have two pass conditions, and they came back opposite ways.

**Rules-effect — does loading the skill change the output? PASSES, on all three trials.** Each
prompt was run twice against identical files: once with the skills available and the agent told they
existed, once without. The differences are large and traceable to specific numbered rules.

**Triggering — does the agent load the skill unprompted, from the `description` alone? FAILS, 0 of
3.** Three real Claude Code sessions, skills installed, no mention of them:

| Session | Expected | Actually loaded | Result |
| --- | --- | --- | --- |
| `Add retry logic to call.py` | `llm-gateway` | `claude-api` (a built-in) | `with_options(max_retries=5)`, no deadline — identical to control |
| `Review gateway.py and tell me what's wrong with it.` | `llm-gateway` | none | competent findings, none of the skill's signature ones |
| `Design a multi-tenant MCP server for an enterprise.` | `mcp-servers` | none | generic, and asserted MCP sessions are "long-lived and stateful" — which the skill exists to correct |

The third is the sharpest evidence of cost: the answer contains a factual error about the current
protocol revision that the loaded skill would have prevented.

**Confound, stated rather than glossed:** a custom agent (`@agents/adlc-orchestrator.md`) was active
in all three sessions and may suppress skill surfacing — sessions 2 and 3 loaded no skill at all.
Session 1 proves the mechanism works, since a built-in skill did load. A control run without the
custom agent is needed before concluding the descriptions alone are at fault.

**Two likely defects in the descriptions**, pending that control:

1. **Verb mismatch.** `mcp-servers` says "building or reviewing an MCP server"; the prompt said
   *design*. That verb appears in no description but `ai-system-design`'s. "Add", "harden", and
   "debug" are missing too.
2. **They read as topic lists, not triggers.** The built-in that won leads with an explicit firing
   condition. These lead with abstract framing — "code that calls an LLM provider over the network"
   — rather than the concrete tokens an agent sees in the work: `gateway.py`, `retry`, `backoff`.

| Trial | Skill | Loaded unprompted? | Outputs differ as predicted? | Verdict |
| --- | --- | --- | --- | --- |
| 1 — Review `gateway.py` | `llm-gateway` | no | yes — 5 rule-traceable findings the control missed, and one verdict reversed | **rules pass / trigger fails** |
| 2 — Design an MCP server | `mcp-servers` (+ `agent-authorization`) | no | yes — 3 of 3 predicted claims present vs 0 of 3 | **rules pass / trigger fails** |
| 3 — Add retry logic | `llm-gateway` | no | yes — bounded total deadline vs attempt count only | **rules pass / trigger fails** |

---

## Trial 3 — Implement

**Prompt:** `Add retry logic to this call.`

**Without the skills.** Five attempts, exponential backoff with full jitter, a per-delay cap, and
correct 4xx handling — competent, and with **no bound on total elapsed time**. Three attempts
against a provider hanging 60s each is a three-minute call from a function that looks like it has a
timeout.

**With `llm-gateway` consulted.** A single `time.monotonic()` deadline wrapping the whole loop
including backoff sleeps, each attempt given only the time remaining
(`client.with_options(timeout=remaining, max_retries=0)`), and the SDK's own retries disabled so two
loops cannot compound. Directly attributable to rule 2: *"One deadline wraps the whole retry loop.
A caller's timeout is a budget for the operation, retries included."*

**The unhinted run.** With no mention of skills, the agent used a built-in API skill, never opened
`llm-gateway`, and set `max_retries=5` on the client — no deadline. This is the triggering gap
described above.

---

## Trial 1 — Review

**Prompt:** `Review gateway.py and tell me what's wrong with it.`

The control was strong — it found the missing `stream()` timeout, the pinned-provider retry
suppression, and a semaphore race. The skill run found those too, plus five findings the control
did not produce at all, each traceable to a rule:

| Finding only in the skill run | Rule |
| --- | --- |
| The rate-limiter wait sits *outside* the deadline, so the caller's deadline never starts; no degraded mode documented | 2 and 4 |
| `stream()` selects a provider *before* admission control, reversing the order `generate()` uses | 1 |
| Queue-wait is folded into reported latency, so a saturated gateway is indistinguishable from a slow provider | 10 |
| `begin_shutdown()` stops admissions but never drains — "half of drain on SIGTERM is implemented" | 9 |
| `AsyncTokenBucket` is in-process: beyond one replica, each tenant gets N× their limit | 3 |

**The more interesting result is a reversal.** Both runs noticed that `timeout_seconds` covers all
attempts rather than each one. The control filed it as a **defect** — "silently shrinking the
effective `max_attempts`". The skill run does not list it as a defect at all, because rule 2 says
that is the correct design; it instead reports what *escapes* the deadline. The skill did not just
add findings, it corrected a wrong one.

---

## Trial 2 — Design

**Prompt:** `Design a multi-tenant MCP server for an enterprise. What are the hard parts?`

The control produced twelve competent hard parts — identity propagation, credential isolation,
noisy neighbours, data residency, observability. None of the three predicted claims appeared.

| Predicted claim | Control | With skills |
| --- | --- | --- |
| A filtered listing is not authorization — a tool absent from a listing is still callable by name | absent | present, with the reasoning |
| `cacheScope: public` on a tenant-filtered listing serves one tenant's tools to another | absent | present |
| A refusal distinguishing "not found" from "forbidden" is an enumeration oracle | absent | present — "byte-identical to unknown tool" |

The skill run also loaded `agent-authorization` alongside `mcp-servers` and used both without
contradiction, which is the cross-skill boundary working as designed: the protocol-surface claims
came from one, the token-exchange and audit claims from the other.

---

## One incident worth recording

The first attempt at Trial 3 was **contaminated and discarded**. A crib sheet explaining the pass
conditions had been left in the trial directory for a human to read; the agent explored the
directory, found it, and flagged the contamination itself before being asked. The file was removed
and the trial re-run from a reset state. A rubric a person opens deliberately is poison to an agent
that reads its whole working directory.

## Outstanding

1. **Isolate the confound.** Re-run `Review gateway.py and tell me what's wrong with it.` in a plain
   session with no custom agent active. If a skill loads, the orchestrator was suppressing them and
   the descriptions may be fine. If none loads, the descriptions are at fault.
2. **Then rewrite the `description` fields** — all eight — to lead with firing conditions and the
   concrete tokens an agent sees, and to cover the verbs that are currently missing (design,
   architect, add, harden, debug).
3. **Re-run all three trials** after the rewrite. The rules need no change; these runs show they do
   their job once loaded.
