---
name: ai-reliability
description: You MUST load this before writing, reviewing, or discussing how a model-backed service is kept healthy — SLOs and SLIs, error budgets, burn-rate alerts, evaluation sets, graders, quality regression detection, significance of an eval delta, runbook automation, or incident response. Applies to design and architecture questions with no code present.
---

# AI Reliability

## Use this when

You are writing the thing that decides whether the platform is healthy, and
what happens next. That covers the burn-rate rule, the autoscaler's input, the
runbook step, the incident's terminal state, and the evaluation run that
produces a quality number somebody will act on.

One property makes this unlike ordinary SRE work: **availability and latency
SLIs cannot see a model that is up, fast, and wrong.** Every other signal in
this domain describes how a request executed. If quality is not an SLI — with a
grader, a target, a window, and something that reads it — then quality is not
monitored, whatever the dashboard shows.

The second property is that the actuator is slow. A capacity correction takes
minutes because weights must load, so the control loop has dead time longer
than many of the incidents it is correcting.

Two neighbouring problems are not this one. Per-version canary metrics and the
tail-latency instrumentation of one served model belong to whoever operates
that model; per-provider error and latency accounting belongs to whatever calls
the provider. Here is the layer above both — the budget those signals are spent
against, and what the platform does once it is spent.

## Rules

1. **Register a quality SLI with a grader, a target, and a budget window — or
   write down that quality is unmonitored.** Availability and latency come free
   from the serving layer and a confidently wrong answer scores perfectly on
   both. The diff is whether the SLO registry has an entry whose SLI is
   produced by an evaluation run rather than by request outcomes, and whether
   the same burn-rate and severity machinery reads it. A quality number that
   exists only as a dashboard panel has no budget, no burn rate, and no
   severity, so nothing acts on it. Record the grader's name beside the number:
   the grader defines what "correct" meant, and it is always narrower than
   correct.
2. **Give every burn-rate rule a threshold and two window lengths, and fire
   only when both windows cross.** One boolean `and`, and it is the whole
   mechanism. The two requirements pull in opposite directions on a single
   window's length: short enough to clear within minutes of the burn stopping
   is short enough to page on a blip, and long enough to filter blips keeps
   alerting long after the burn stopped. No single length satisfies both, so a
   single-window rule is a choice between flapping and blindness rather than a
   tuning problem.
3. **Compute burn rate as the observed error rate divided by the rate the
   target permits, and report budget remaining signed.** A burn rate of 1.0
   exhausts the budget exactly at window end, which is what makes one threshold
   mean the same thing for a 99 % service and a 99.9 % one — a raw error-rate
   threshold cannot. Clamping remaining budget at zero throws away *how far
   over*, which is the difference between pausing deploys and freezing them.
4. **Pass severity into the scaling decision, and check it before the
   cooldown.** Textual order inside one function is the entire fix. A cooldown
   exists to stop flapping on noisy utilisation samples; a page-severity burn
   is not noise, and waiting out a timer built to suppress noise is the wrong
   response to users being failed now. Every other decision still respects it,
   which is what keeps the override narrow.
5. **Never let utilisation be the only scaling input.** Utilisation cannot
   distinguish "traffic grew" from "the service is failing and client retries
   are inflating load", and in the second case adding capacity feeds the retry
   storm. Severity is what separates them, and is the reason the scaling
   decision takes it as an input at all.
6. **Derive the scaling decision's severity and the incident's severity from
   one call.** Two subsystems computing their own health signal will disagree
   during exactly the incidents where clarity matters — scaling up while the
   incident is marked resolved, paging while capacity is being removed. The
   diff is whether the controller takes severity as an argument or reads a
   metric itself.
7. **Escalate an unresolved runbook step; never retry it.** Retrying assumes
   the step's *execution* failed. Far more often the step was the wrong
   remediation — a restart does not fix a capacity problem — so the retry burns
   the incident's clock, produces no new information, and leaves no record of
   who was told. The diff is a loop around a step versus a move to the next
   step with a named contact recorded.
8. **Give every runbook step its own timeout, its own named escalation target,
   and an idempotent action.** A step with no timeout is an incident that stops
   progressing at whatever the step is blocked on. A step may fire twice — a
   second alert for the same cause, a partition, a retried trigger — so verify
   idempotency by running one twice, not by asserting it in a comment.
9. **Terminate incident automation in an explicit exhausted state that names
   the last contact escalated to, and make sure the last step has one.**
   Automation that loops, or that stops silently, withholds the fact the
   responder needs first: nobody has fixed this and it is now theirs. Check the
   final step's escalation target specifically — if it is null, the exhausted
   report names nobody, which is the failure the state was added to prevent.
10. **Publish the eval set's smallest detectable delta beside its accuracy, and
    treat any smaller movement as noise.** The number of examples bounds what
    the set can ever report, and that bound is usually far larger than the
    deltas being claimed. Report the confidence interval rather than the point
    estimate: a point estimate with an interval spanning zero is consistent
    with a regression of the same size.
11. **Let the significance answer be three-valued.** `True`, `False`, and a
    third value meaning *this set cannot tell*. Returning `False` when the
    approximation is not usable says "no difference" when the honest answer is
    "no idea", and the two get acted on oppositely: one closes the
    investigation, the other should open one into the eval set. The diff is the
    return type and the guard that produces the third value.
12. **Carry a verified-by field on every golden answer, and refuse to average
    flaky examples away.** An eval set grown from the system's own past output
    measures agreement with a former self, cannot detect a regression that was
    always there, and nothing in the accuracy number reveals it. Name the
    examples whose verdict moved across repeats rather than reporting their
    mean, or instability hides behind a plausible number.

## Deciding

| Situation | Do this | Because |
| --- | --- | --- |
| Availability and latency SLOs exist and someone asks whether the platform is healthy | Add a quality SLI with a grader and a target, however crude, and state its blind spot | "Register a quality SLI with a grader, a target, and a budget window." A model that is up, fast, and wrong scores perfectly on the two SLIs you already have |
| Choosing burn-rate windows | Two windows per severity, both required to cross | "Fire only when both windows cross." A single window is a choice between paging on blips and alerting long after the burn stopped — no length satisfies both requirements |
| An automated remediation ran and did not resolve the incident | Escalate to that step's named contact and run the next step | "Escalate an unresolved runbook step; never retry it." Retrying assumes execution failed, when usually the remediation was wrong, and the clock being burned is the incident's |
| Deciding whether to automate a remediation at all | Automate only cheap, reversible, idempotent steps, each bounded by a timeout; page immediately otherwise | Automation that fails has consumed time *and* changed system state before the human arrives, so the responder inherits a modified system. The timeout is what keeps that downside finite |
| An evaluation reports a few points of improvement | Report the interval and the set's smallest detectable delta, and treat anything under it as unmeasured | "Publish the eval set's smallest detectable delta beside its accuracy." At an 85 % baseline, 50 examples per arm resolve nothing below about 20 points at 95 % confidence and 80 % power — on the lab's unpaired normal approximation, which is the optimistic end; the pooled two-proportion calculation gives nearer 25 |
| The error budget has never depleted in a full window | Treat it as a defect in the SLO, not as evidence of health | An instrument that always reads fine has not been calibrated against real impact. Either the target is loose enough to be uninformative or the SLI is not measuring what users notice |

## Going deeper

| Read | When |
| --- | --- |
| [references/architecture.md](references/architecture.md) | Designing the control loop, or placing alerting, scaling, incident response, cost, and observability in it |
| [references/failure-modes.md](references/failure-modes.md) | An alert, an autoscaler, a runbook, or an SLO is behaving oddly and you are writing the detector |
| [references/patterns.md](references/patterns.md) | You need the shape of a two-window burn-rate rule, a severity-aware scaling decision, an escalating runbook, or a significance test that can decline to answer |
| [references/review-checklist.md](references/review-checklist.md) | Reviewing someone's SLO definitions, alert rules, autoscaler, incident automation, or evaluation harness |
