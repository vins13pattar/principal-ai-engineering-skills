# Verification trials

A skill that never triggers is worth nothing, and a skill that triggers but changes nothing is worth
less than nothing — it spent context to restate what the model already knew. So triggering and
effect are both tested properties here, not assumed ones.

## The standard

Each trial runs **twice**: once in a project with the skills installed, once in a project without
them. Same prompt, fresh session each time, and **the skill's name is never mentioned**.

**Pass** requires both:

1. The expected skill loaded **unprompted**, and
2. The two outputs **differ in the direction the skill's rules specify**.

An identical pair is a **fail** even if both outputs are good. It means the skill restated what the
model already produced, and those rules need sharpening. Record it as a fail and fix the rules —
do not adjust the trial to fit the result.

## Setup

Two scratch projects, so the control cannot see the skills:

```bash
mkdir -p /tmp/trial-with /tmp/trial-without
cd /tmp/trial-with && git init -q
npx --yes skills add vins13pattar/principal-ai-engineering-skills
```

Leave `/tmp/trial-without` empty. Confirm the install:

```bash
ls /tmp/trial-with/.agents/skills   # expect 8 directories
ls /tmp/trial-without               # expect nothing
```

Start a **fresh session** for each of the six runs. A session that has already seen one trial has
been primed by it.

---

## Trial 1 — Review

**Expect:** `llm-gateway` loads unprompted.

Copy the gateway file in first, so the prompt carries no vocabulary of its own:

```bash
cp /path/to/principal-ai-engineer-handbook/labs/async-ai-gateway/src/ai_gateway/gateway.py .
```

**Prompt, verbatim:**

> Review gateway.py and tell me what's wrong with it.

**What the skill's rules predict.** With `llm-gateway` loaded, the review should reach the ordering
and deadline claims — that the retry loop needs one deadline across all attempts rather than per
attempt, that an in-process rate limiter multiplies each tenant's quota by the replica count, and
that queue-wait must be measured separately from provider time. Without it, expect competent but
generic review: naming conventions, error handling, type hints, maybe a note that retries need
backoff.

---

## Trial 2 — Design

**Expect:** `mcp-servers` loads unprompted, and `ai-system-design` is reachable through it.

**Prompt, verbatim:**

> Design a multi-tenant MCP server for an enterprise. What are the hard parts?

**What the skill's rules predict.** With the skills loaded, the answer should reach the claims a
model does not produce unaided: that filtering a tool listing is not authorization, because a tool
absent from a listing is still callable by name; that `cacheScope: public` on a tenant-filtered
listing serves one tenant's tools to another; that a refusal distinguishing "not found" from
"forbidden" is an enumeration oracle. Without them, expect the standard shape — tenancy, auth,
rate limiting, observability — without those three.

---

## Trial 3 — Implement

**Expect:** `llm-gateway` loads unprompted, and the resulting code bounds the **total** deadline
across retries rather than only the attempt count.

Create a bare call with no surrounding context:

```python
# call.py
import anthropic

client = anthropic.Anthropic()

def ask(prompt: str) -> str:
    message = client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}],
    )
    return message.content[0].text
```

**Prompt, verbatim:**

> Add retry logic to this call.

**What the skill's rules predict.** This is the sharpest trial, because the failure is specific and
easy to check by reading the diff. With `llm-gateway` loaded, the retry should be wrapped in a
single overall deadline — the caller's timeout is a budget for the whole operation, retries
included. Without it, expect the near-universal default: a bounded attempt count with exponential
backoff and jitter, each attempt possibly timed out individually, and **no bound on total elapsed
time**. Three attempts against a provider that hangs for 60s each is a three-minute call from a
function that looks like it has a timeout.

---

## Recording

Fill in [`RESULTS.md`](RESULTS.md) as you go — the prompt verbatim, which skills loaded, a short
diff of the two outputs, and a verdict per trial. Record failures as failures; the point of the
standard is that it can come back negative.
