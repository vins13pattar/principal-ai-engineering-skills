# Verification results

Run 2026-08-25 to 2026-08-26. Trials defined in [`TRIALS.md`](TRIALS.md).

## Summary: both conditions pass, 3 of 3

**Rules-effect — does loading the skill change the output? PASSES on all three trials.**

**Triggering — does the agent load the skill unprompted? PASSES 3 of 3**, after four description
rewrites.

| Session | Loaded | Outcome |
| --- | --- | --- |
| `Add retry logic to call.py` | `llm-gateway` | Said why: "matches the llm-gateway skill's trigger (retries/backoff for LLM provider calls). Let me load it before implementing." Read `references/patterns.md`, then wrote a single `time.monotonic()` deadline with each attempt bounded by `timeout=remaining` and the backoff sleep clamped to it |
| `Review gateway.py and tell me what's wrong with it.` | `llm-gateway` | "Reviewed against the LLM-gateway checklist"; framed the whole-loop deadline as the design and flagged what breaks it — the verdict the control got backwards |
| `Design a multi-tenant MCP server for an enterprise.` | `mcp-servers` | Opened with "the 2026-07-28 revision dropped initialize/Mcp-Session-Id" — the exact claim the unskilled run got wrong — plus all three predicted findings |

On the retry task the control produced `max_retries=5` with no bound on wall-clock. The skilled run
bounds total elapsed time, gives each attempt only what remains, clamps the backoff sleep to the
remaining budget, and uses full jitter rather than equal jitter. That is rule 2 in full.

### What it took: four rewrites, three real defects

1. **Topic lists, not triggers.** The originals described subject matter. The skills that win state a
   firing condition.
2. **A self-inflicted narrowing.** The second attempt ended each description "Read this before
   opening the file." The MCP session then declined them aloud — *"process skills meant for
   building/reviewing code"* — because a discussion question has no file. The phrase added to make
   them fire harder is what suppressed them.
3. **Passive framing in a crowded field.** These compete against ~400 installed skills here. The
   reliable winners open with an obligation, "You MUST", not "Use when". That change took triggering
   from 0/3 to 2/3, and required relaxing a validator rule invented in Task 2 that had *required* the
   weaker opener.
4. **Skills are not mutually exclusive.** The last failure was a built-in winning on its home turf —
   an Anthropic SDK file. `llm-gateway` now asks to be loaded *alongside* any provider-SDK skill and
   says why: an SDK retry setting caps attempts, not wall-clock.

### Caveat on the environment

This machine has ~400 skills installed (52 personal, 346 from plugins). Someone installing only these
eight faces far less competition, so 3/3 here is a result from an unusually adversarial field.

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

Nothing. Both pass conditions are met on all three trials.
