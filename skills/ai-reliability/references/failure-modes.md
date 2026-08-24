# Failure modes

Symptom first, because that is what you have when someone reports it. Ordered
by what the failure costs rather than by where it sits in the loop.

The first two are the ones that make everything downstream decorative: one
calibrates the instrument to always read fine, the other guarantees the alert
is either ignored or absent. Both are invisible while they are happening, and
for a model-backed service the first has a specific shape — the SLIs that come
free from the serving layer cannot see a model that is up, fast, and wrong, so
a platform with only those two is not monitoring the thing users complain
about.

## An SLO nobody derived from users

**Presents as:** health. A target that has never been missed, a budget that has
never depleted, alerts that have never fired, and a quality problem that
reaches you through support tickets or a downstream metric instead. Nothing in
the reliability stack participated in finding it.

**Cause:** the target was chosen because it was comfortably achievable. That
produces a budget that never depletes and therefore alert rules that never
evaluate to anything but ok — an instrument calibrated to always read fine. For
an AI service the more common version is subtler: the SLIs are availability and
latency because those are the two the serving layer emits for free, and the
failure users actually experience is a confidently wrong answer, which scores
perfectly on both. The dashboard is not lying about what it measures; it is
measuring something nobody complained about.

**Do:** write down the user impact the target was derived from, next to the
target. Treat a full window with no budget depletion as a finding to
investigate rather than as a result to report — occasional depletion is the
signal an SLO exists to produce. Then add a quality SLI: an eval run whose
score feeds the same burn-rate and severity machinery as the other two, with a
named grader, a target, and a window. Record the eval set's smallest detectable
delta beside the score, because a set too small to resolve the regression you
care about will report ok indefinitely and be right to.

## Single-window burn-rate alerting

**Presents as:** one of two complaints, depending on which way the window was
set. Either pages that fire on transient blips and then flap, until on-call
starts ignoring the alert by name. Or an outage that ran most of its length
before anything fired, and an alert that then kept firing for hours after the
service recovered.

**Cause:** both complaints are the same rule with a different constant. A
window short enough to clear within minutes of the burn stopping is short
enough that a momentary error spike crosses the threshold. A window long enough
to average blips away holds a stale average long after the burn has ended, and
reacts to the start of a fast burn only after most of it has already been
spent. The two requirements pull in opposite directions on one number, so this
is not a tuning problem with an answer.

**Do:** give each severity a threshold and *two* windows, and fire only when
both exceed it. The long window supplies the noise suppression; the short one
supplies the fast clear. Export both rates on the alert, not just the verdict,
or an alert that fired cannot be explained afterwards. Then check the quiet
case: burn rate over a lookback with no requests in it is zero, so a service
that has stopped receiving traffic entirely reports healthy on every window at
once.

## Utilization-only scaling that cannot see why load is high

**Presents as:** an autoscaler that responds correctly to load and makes the
incident worse. Replica count climbs, utilisation stays pinned, error rate does
not improve, and the bill does. Frequently the scale-up correlates so well with
the traffic that nobody suspects it.

**Cause:** utilisation is a measurement of *how much* load there is and carries
nothing about *why*. "Traffic grew" and "the service is failing and client
retries are inflating load" look identical in it, and they have opposite
correct responses — the second is a retry storm, and capacity feeds it.

**Do:** pass severity into the scaling decision as an input, so the controller
has a signal that distinguishes the two cases, and record the reason with every
decision — proportional target, cooldown hold, or fast-burn override — so a
post-incident review can reconstruct why capacity moved. Where load is
suspected to be retry-driven, the fix is upstream of this controller
altogether.

## Cooldowns that suppress the response an outage needs

**Presents as:** a capacity response that arrives minutes after it was needed,
during an incident where the autoscaler was demonstrably working and every
decision it logged says "hold".

**Cause:** a cooldown exists to stop the controller flapping on noisy
utilisation samples, and it is normally applied to every decision uniformly. A
fast error-budget burn is not a noisy sample — it means users are being failed
right now — so the one case where waiting is actively harmful is also the case
the timer was never designed for.

**Do:** check severity *before* checking the cooldown, so a page-severity burn
takes a deliberate, narrow escape hatch while every other decision still
respects the timer. Test the override specifically, since it is a branch that
only executes during the worst incidents and will otherwise be discovered
broken during one. Note what an override costs: it usually stamps the
last-scaled time as well, so the next ordinary decision is held by a cooldown
the override itself started.

## Runbook automation that retries instead of escalating

**Presents as:** an incident whose timeline shows the same automated step
running three or four times, ten minutes gone, and a human paged at the end
knowing nothing more than at the start.

**Cause:** retry is the reflex from every other part of the system, and it
encodes an assumption that does not hold here — that the step's *execution*
failed. Far more often the execution was fine and the remediation was wrong: a
restart does not fix a capacity problem or a bad dependency, and running it
again produces the same non-result. Retrying also leaves no record of who was
told, because nobody was.

**Do:** on an unresolved step, escalate to that step's named contact and run
the next step. Bound each step with its own timeout, so a step that hangs
cannot become an incident that stops progressing. Record each step's outcome —
resolved, timed out, escalated — which is what turns the automation from a
black box into something reviewable afterwards. And verify idempotency by
running a step twice, since a second alert for the same cause will do exactly
that.

## Incident automation with no exhausted state

**Presents as:** silence. The automation stopped, the incident is still open,
and the responder's first task is working out whether anything is still running
and who, if anyone, has been notified. Or the opposite: a loop that keeps
re-running the same steps, so the incident channel fills while nothing changes.

**Cause:** the terminal case was never written. The code models "resolved" and
models "keep going" and has no third state for "I am out of steps and a human
owns this now" — which is the single most important fact for whoever picks it
up.

**Do:** report an explicit exhausted status carrying the last contact escalated
to, distinct from resolved, and treat reaching it as a normal outcome rather
than an error. Then check the final step's escalation target: if it is null,
the exhausted report names nobody, and the state that exists to say who owns
the incident says no one does. Alert on the arrival of an exhausted incident,
since it is by definition the case automation could not handle.

**Source:** [Architecture: AI Reliability Platform](https://handbook.vinodspattar.in/architecture/systems/ai-reliability-platform/), [Module 12: Observability](https://handbook.vinodspattar.in/learn/modules/12-observability/), [Lab: SLO-Driven AI Operations](https://handbook.vinodspattar.in/build/labs/slo-driven-ai-operations/), [Cheat Sheet: Incident Response](https://handbook.vinodspattar.in/cheatsheets/sheets/incident-response/)
