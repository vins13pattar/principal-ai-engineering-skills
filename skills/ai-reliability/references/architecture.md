# AI reliability platform architecture

## The problem the design exists to solve

"Is the platform healthy" is normally answered by looking at a dashboard and
forming an impression. That does not automate, does not scale, and does not
survive being asked at 3am by someone who did not build the system.

An error budget replaces the impression with a number that can be spent,
alerted on, and acted upon — but only if three consumers agree on it: the
alerting that decides whether to wake someone, the autoscaler that decides
whether to add capacity, and the incident automation that decides how far to
escalate. Built at different times by different people, they read separate
signals by default, and then disagree during exactly the incidents where
clarity matters most.

Two properties separate this from ordinary SRE work. **The most important SLI
is often quality, and no infrastructure signal captures it** — a model that is
up, fast, and wrong produces a 200, a normal latency, and a clean trace.
**And the actuator is slow**: capacity takes minutes to arrive because weights
must load, so the control loop's dead time is longer than many of the incidents
it is correcting.

## Requirements worth writing down

- **An SLO derived from user impact**, not from what is comfortably achievable.
- **Burn-rate alerting** that distinguishes a blip from a sustained burn and
  clears promptly once the burn stops.
- **One severity signal**, consumed by alerting, scaling, and incident response
  alike.
- **Capacity response that reads severity**, not utilisation alone.
- **Runbook automation that escalates rather than retrying**, with a bounded
  attempt per step.
- **An honest terminal state** when automation is exhausted.
- **Quality as a first-class SLI**, alongside availability and latency, with a
  named grader and a stated resolution.

## Constraints that decide the design

- **Burn rate needs two windows.** A single window cannot both suppress blips
  and clear quickly; those requirements pull in opposite directions on window
  length, so there is no length that satisfies both.
- **An error budget is only meaningful over a defined window.** "99.9 %"
  without a window is not an SLO — the window is what decides how much failure
  is affordable and how fast it accrues.
- **Actuation latency is a property of the serving platform, not of this
  controller.** What follows for the design is only that the controller's
  cadence must exceed the actuator's delay, or every decision is taken on state
  that has already moved.
- **Quality cannot be measured by infrastructure.** Availability and latency
  SLIs come free from the serving layer; a quality SLI has to be constructed
  deliberately, is always a proxy, and can itself regress silently.
- **A quality SLI's resolution is bounded by its eval set size.** The set
  cannot report a regression smaller than its smallest detectable delta,
  whatever threshold is configured against it.
- **Automation acting during an incident changes the incident.** Anything the
  platform does by itself becomes a variable the responder has to reason about,
  on top of the failure they were paged for.

## Control loop

As transitions rather than a diagram:

1. **Each request outcome is recorded** — success or failure, with the time it
   happened — against the service whose SLO it counts toward.
2. **The rolling window is pruned to the SLO's budget window.** Outcomes older
   than it stop counting, which is what makes the budget rolling rather than
   cumulative.
3. **Burn rate is the observed error rate over a lookback divided by the error
   rate the target permits.** 1.0 exhausts the budget exactly at window end, so
   a threshold of 14.4 — the lab's default for its page rule — drains a 30-day
   budget in about two days, by 30 ÷ 14.4.
4. **Each alert rule evaluates that rate twice** — once over its long window,
   once over its short one.
5. **The rule fires only if both exceed its threshold.** The long window
   filters blips; the short window lets the alert clear within minutes of the
   burn stopping.
6. **The highest-ranked firing rule sets the report's severity**, and both
   windows' rates are recorded on the report whether or not the rule fired.
7. **The autoscaling controller reads that severity first.** At page severity
   it scales up immediately, skipping its own cooldown.
8. **Otherwise the cooldown gates the decision**, and only then does a
   proportional target, clamped to the replica bounds, apply.
9. **The incident runner reads the same severity** and executes the runbook's
   steps in order, each under its own timeout.
10. **An unresolved step escalates to its named contact and the next step
    runs.** No step is retried.
11. **When the steps run out, the incident terminates in an exhausted state**
    carrying the last contact escalated to.

**Steps 5 and 7 are where the design lives.** The conjunction in step 5 is what
buys noise suppression and fast clearing at once, which no single window
achieves. Severity crossing into step 7 is what lets a controller that would
otherwise see only utilisation tell "traffic grew" apart from "we are failing
and clients are retrying" — two situations with opposite correct responses.

Note what the loop does *not* do. Burn rate over an empty lookback is zero and
budget remaining over an empty window is full, so a service receiving no
traffic at all reads as perfectly healthy. Anything upstream that fails
requests before they reach this recording point is invisible to every signal
downstream of it.

## Scaling

- **The SLI pipeline must outscale the service it measures.** Instrumentation
  that degrades under load blinds you during the one event the measurement
  exists for.
- **Burn-rate windows are queries over retained data**, so the longest window
  sets retention and query cost. A 30-day budget window at five-minute
  resolution is a storage decision, not a config value.
- **Per-service SLOs multiply.** Past a few dozen, SLO definitions have to be
  data rather than code, or the alerting configuration becomes the bottleneck
  and rules drift from the services they describe.
- **Incident automation must be idempotent**, since a step may fire twice under
  a retried trigger, a partition, or a second alert for the same root cause.
- **A quality SLI scales by cadence, not by replicas.** Its cost is an
  evaluation run, so the tuning knob is how often the set runs and how large it
  is — and shrinking the set to afford the cadence silently raises the smallest
  regression it can detect.

## Security

- **Runbook steps act with privilege.** Automation that restarts services or
  scales infrastructure holds credentials a compromised alerting path could
  exercise, which makes the *trigger* as security-relevant as the action.
- **Escalation targets are personal data and an availability map.** A leaked
  on-call schedule tells an attacker exactly when response is thinnest.
- **Incident records capture systems at their least redacted** and are retained
  the longest of anything here.
- **Automated remediation needs an audit trail** equal to a human action: what
  fired, why, with what authority, and what it changed.

## Cost

- **Telemetry retention is set by the longest burn-rate window.** A 30-day
  budget window commits to 30 days of queryable resolution.
- **Alert-driven scaling spends money on a signal**, which makes a mis-tuned
  burn-rate rule a billing event as well as a paging one.
- **Warm headroom held for fast-burn response is standing cost**, justified by
  the incident latency it removes rather than by utilisation.
- **Every automated remediation step has a cost when it is wrong** — a needless
  scale-up, a restart that drops in-flight work — which is why steps should be
  cheap and reversible before they are clever.
- **On-call is the largest cost in this architecture**, and it is spent by
  alert quality. Noisy alerting is expensive in the least visible way.
- **A quality SLI costs inference on every evaluated example**, so its cadence
  is a direct trade against the detection delay it buys.

## Trade-offs

**Multiwindow alerting vs. a single threshold.** Two windows per rule buy noise
suppression and fast clearing simultaneously, which no single window achieves.
The cost is configuration complexity — each severity needs a threshold and two
window lengths — and rules that are harder to explain to whoever they page. It
is worth paying because the alternative is alert fatigue or blindness, and both
end in the alert being ignored.

**Automated remediation vs. paging a human immediately.** Automation resolves
common causes in seconds and, when it fails, has consumed time *and* changed
system state before a human arrives. Paging immediately is slower for routine
failures and hands the responder an unmodified system. Bounding each step with
a timeout and escalating rather than retrying is what keeps the first option's
downside finite.

**Tight SLO vs. achievable SLO.** A tight target surfaces real degradation and
spends engineering time on reliability users may not value; a loose one is
cheap and never fires. The test is not what the team can hit but what users
notice. An error budget that has never depleted is measuring the wrong thing or
is set too loose to be an instrument.

**Quality as an SLI vs. availability and latency only.** Availability and
latency are free from the serving layer and miss the failure that matters most
for a model-backed service — fast, well-formed, wrong output. A quality SLI
catches it, and is always a proxy: it needs its own pipeline, its own grader,
and its own eval set, and it can regress silently itself. An imperfect quality
signal beats none, provided its limitations are stated next to it.

**Source:** [Architecture: AI Reliability Platform](https://handbook.vinodspattar.in/architecture/systems/ai-reliability-platform/), [Module 12: Observability](https://handbook.vinodspattar.in/learn/modules/12-observability/), [Lab: SLO-Driven AI Operations](https://handbook.vinodspattar.in/build/labs/slo-driven-ai-operations/) (its control-loop diagram, which supplied the transitions above), [Lab: Evaluation Platform](https://handbook.vinodspattar.in/build/labs/evaluation-platform/)
