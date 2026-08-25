# Verification results

Trials defined in [`TRIALS.md`](TRIALS.md). Pass requires both that the expected skill loaded
unprompted, and that the two outputs differ in the direction the skill's rules specify.

**Status: not yet run.** The skills are published; this table is the outstanding evidence for the
claim that they change an agent's output. Until it is filled in, that claim is untested rather than
established.

| Trial | Skill expected | Loaded unprompted? | Outputs differ as predicted? | Verdict |
| --- | --- | --- | --- | --- |
| 1 — Review `gateway.py` | `llm-gateway` | — | — | not run |
| 2 — Design an MCP server | `mcp-servers` (+ `ai-system-design`) | — | — | not run |
| 3 — Add retry logic | `llm-gateway` | — | — | not run |

---

## Trial 1 — Review

**Prompt:** `Review gateway.py and tell me what's wrong with it.`

**Skills loaded:** _(record what actually loaded, including anything unexpected)_

**With the skills:**

**Without the skills (control):**

**Difference:** _(did the review reach the total-deadline, per-replica-quota, or queue-wait claims?)_

**Verdict:**

---

## Trial 2 — Design

**Prompt:** `Design a multi-tenant MCP server for an enterprise. What are the hard parts?`

**Skills loaded:**

**With the skills:**

**Without the skills (control):**

**Difference:** _(did it reach: a filtered listing is not authorization; `cacheScope: public` leaks
across tenants; a "not found" vs "forbidden" refusal is an enumeration oracle?)_

**Verdict:**

---

## Trial 3 — Implement

**Prompt:** `Add retry logic to this call.`

**Skills loaded:**

**With the skills:**

**Without the skills (control):**

**Difference:** _(does the result bound total elapsed time across retries, or only the attempt
count? This is the check — read the diff, not the prose around it.)_

**Verdict:**

---

## If a trial fails

An identical pair means the skill restated what the model already knew. Sharpen the rules that were
supposed to fire, then rerun that trial. Do not weaken the trial to fit the result — record the
failure and what changed in response.
