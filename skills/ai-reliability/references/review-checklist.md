# Review checklist

Ordered by what the failure costs, not by where it appears in the file. The
first three decide whether anything else on this list is worth checking — they
are the ones that leave a platform instrumented, alerting, automated, and blind.
Stop and comment at the first failing answer in that section.

## The three that find the most

1. **Is quality an SLI, or only a chart?** *Failing answer:* availability and
   latency are the SLIs, and quality is a number on a dashboard — or is not
   measured at all. The two SLIs the serving layer emits for free cannot see a
   model that is up, fast, and wrong, which is the failure users report. Ask for
   the four things that make it an SLI rather than a panel: which grader
   produced the score, what the target is, over what window, and what reads the
   number. If nothing consumes it, quality is unmonitored however good the chart
   is.

2. **Does every burn-rate rule carry two windows, and does firing require
   both?** *Failing answer:* one window, or two windows combined with an `or`.
   Look for a single `and` over a long-window rate and a short-window rate. A
   short window alone pages on blips until on-call filters the alert by name; a
   long window alone reacts after most of a fast burn and keeps firing after
   recovery. The requirement is not a tuning problem — no single length
   satisfies both.

3. **Has the error budget ever depleted?** *Failing answer:* never, and it is
   being reported as good news. An instrument that has always read fine has not
   been calibrated against real impact: either the target was set to what was
   comfortably achievable, or the SLI is not measuring what users notice. Ask
   where the target came from and whether that derivation is written down
   anywhere.

## Then, in blast-radius order

4. **Does the scaling decision take severity as an input, and is severity
   checked before the cooldown?** *Failing answer:* utilisation is the only
   input, or the cooldown check comes first. Utilisation cannot distinguish
   "traffic grew" from "we are failing and clients are retrying", and in the
   second case capacity feeds the storm. The ordering is textual and one
   diff-visible line: a page-severity burn must not reach a timer that exists to
   suppress noise. Check the override's own guard too — one written as
   `replicas < max_replicas` sends a fast burn at the ceiling straight down the
   cooldown path, where it produces an ordinary hold.

5. **Do alerting, scaling, and incident response read one severity
   computation?** *Failing answer:* each derives its own from whatever metric
   was nearest. Three signals disagree during exactly the incidents where
   clarity matters — scaling up while the incident is marked resolved, paging
   while capacity is being removed. One `report()` call feeding all three makes
   that class of contradiction impossible rather than unlikely.

6. **What happens when a runbook step runs and does not resolve the incident?**
   *Failing answer:* it is retried, with or without backoff. Retry encodes the
   assumption that the step's execution failed; far more often the remediation
   was wrong — a restart does not fix a capacity problem — so the retry spends
   the incident's clock, learns nothing, and notifies nobody. It should escalate
   to that step's named contact and move to the next step.

7. **Does every step have its own timeout and its own named escalation target —
   including the last one?** *Failing answer:* a shared timeout, no timeout, or
   a final step whose escalation target is null. Check the last step
   specifically: if it has no contact, the exhausted report names nobody, and
   the state that exists to say who owns the incident says no one does.

8. **Is there an explicit exhausted state, and does anything alert on reaching
   it?** *Failing answer:* the runner loops, or falls off the end silently.
   Reaching the end of the runbook is a normal outcome and must be reported as
   one, carrying the last contact escalated to — it is by definition the case
   automation could not handle, so it is the case a human must hear about.

9. **Has a runbook step been run twice, in a test?** *Failing answer:*
   idempotency is asserted in a comment or in the PR description. A step fires
   twice under a retried trigger, a partition, or a second alert for the same
   root cause, and these steps hold enough privilege to make a repeat expensive.

10. **What happens to an exception raised inside a step's action?** *Failing
    answer:* it propagates out of the runner, so the incident produces no report
    at all — neither resolved nor exhausted. Catching only the timeout is the
    common shape. The caller has to treat an escaped exception as an exhausted
    incident, or the automation fails silently in the case it exists for.

11. **Is burn rate normalised by the permitted error rate, and is remaining
    budget signed?** *Failing answer:* a threshold on the raw error rate, or a
    `max(0, ...)` on the budget. Dividing by the rate the target permits is what
    makes one threshold mean the same thing at 99 % and at 99.9 %. Clamping at
    zero discards how far over, which is the difference between pausing deploys
    and freezing them.

12. **What does a lookback containing no requests report?** *Failing answer:*
    healthy, with nothing watching for it. An empty window usually yields a burn
    rate of zero and a full budget, so a service that has stopped receiving
    traffic reads exactly like a perfect one — and anything failing requests
    upstream of the recording point is invisible to every signal downstream.

13. **Does the evaluation report carry the set size and its smallest detectable
    delta?** *Failing answer:* an accuracy percentage and a delta, with no `n`
    and no interval. The set size bounds what the eval can ever report, usually
    far above the deltas being claimed, and a point estimate whose interval
    spans zero is consistent with a regression of the same size.

14. **Can the significance function answer "this set cannot tell"?** *Failing
    answer:* a `-> bool` return type. Returning `False` when the approximation
    is not usable says "no difference" where the honest answer is "no idea", and
    the two are acted on oppositely — one closes the investigation, the other
    should open one into the eval set.

15. **Who verified the golden answers, and what happens to flaky examples?**
    *Failing answer:* no per-example field recording it, and repeats averaged
    into the score. A set grown from the system's own output measures agreement
    with a former self and cannot detect a regression that was always there;
    nothing in the accuracy number reveals it. Averaging repeats hides
    instability behind a plausible number instead of naming the examples.

16. **Does the evaluation gate report what it discovered and executed, or only
    that it passed?** *Failing answer:* the job is green and says nothing else.
    A run that skipped every case and a run that passed every case emit an
    identical signal, so green is evidence only when it can show which checks
    ran and over what. Ask for discovered, executed, and skipped in the log, and
    for a build that fails on zero discovered. Then the question specific to
    agent-written changes: did this commit touch the checking mechanism as well
    as the implementation, and was that reviewed as its own change?

## Cost — last but always

17. **Is telemetry retention at least the longest burn-rate window?** *Failing
    answer:* nobody checked. The longest window sets retention and query cost,
    and a rule whose window exceeds retention evaluates silently on truncated
    data — an alert that cannot fire and looks configured.

18. **What was traded to afford the quality SLI's cadence?** *Failing answer:*
    the eval set was shrunk, with no one re-checking what it can still detect.
    Cadence and set size are the two knobs and they trade against different
    things: cadence buys detection delay, size buys resolution.

## Observability — last but always

19. **When an alert fires, does it carry both window rates and the threshold?**
    *Failing answer:* the verdict only. An alert that cannot be reconstructed
    afterwards gets argued about instead of debugged, and the argument recurs.

20. **Is a scaling decision's reason recorded alongside its action?** *Failing
    answer:* the action and the replica count. Proportional target, cooldown
    hold, and fast-burn override are three different events that look identical
    as "scaled to 6", and post-incident review needs to tell them apart.

21. **Are time-to-detect and time-to-escalate measured?** *Failing answer:*
    neither. They are the two intervals this automation exists to compress and
    the only evidence that it does.

**Source:** [Architecture: AI Reliability Platform](https://handbook.vinodspattar.in/architecture/systems/ai-reliability-platform/), [Module 12: Observability](https://handbook.vinodspattar.in/learn/modules/12-observability/), [Lab: SLO-Driven AI Operations](https://handbook.vinodspattar.in/build/labs/slo-driven-ai-operations/), [Lab: Evaluation Platform](https://handbook.vinodspattar.in/build/labs/evaluation-platform/), [Cheat Sheet: Incident Response](https://handbook.vinodspattar.in/cheatsheets/sheets/incident-response/)
