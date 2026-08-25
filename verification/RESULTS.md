# Verification results

Run 2026-08-25. Trials defined in [`TRIALS.md`](TRIALS.md).

## What was and was not tested

The trials have two pass conditions. Only one of them was testable with the harness available.

**Rules-effect — does loading the skill change the output? TESTED, and it passes on all three
trials.** Each prompt was run twice against identical files: once in a project with the skills
installed and the agent told they existed, once in a project without them. The differences are
large and traceable to specific numbered rules.

**Triggering — does the agent load the skill unprompted, from the `description` alone? NOT TESTED.**
The runs were performed by subagents, and project skills under `.agents/skills/` are not registered
with a subagent's `Skill` tool — one run found `llm-gateway` only by reading it as a plain file and
said so. A clean run of Trial 3 with no hint confirmed the gap: the agent reached for a built-in
skill, never opened `llm-gateway`, and produced control-grade output. **That is a limitation of the
test harness, not evidence about the descriptions.** Testing it needs a real session where the
skills are registered.

So the honest summary: **the rules work. Whether the descriptions fire is still unverified.**

| Trial | Skill | Loaded unprompted? | Outputs differ as predicted? | Verdict |
| --- | --- | --- | --- | --- |
| 1 — Review `gateway.py` | `llm-gateway` | not testable | yes — 5 rule-traceable findings the control missed, and one verdict reversed | **rules pass** |
| 2 — Design an MCP server | `mcp-servers` (+ `agent-authorization`) | not testable | yes — 3 of 3 predicted claims present vs 0 of 3 | **rules pass** |
| 3 — Add retry logic | `llm-gateway` | **no** (harness limitation) | yes — bounded total deadline vs attempt count only | **rules pass** |

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

Triggering. Run the three prompts in a real session with the skills installed and no mention of
them, and record whether the expected skill loads on its own. If it does not, the `description`
fields need sharpening — not the rules, which these runs show are doing their job.
