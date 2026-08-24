# Patterns

Four excerpts: three from `labs/slo-driven-ai-operations` (`src/platform_ops/`),
one from `labs/evaluation-platform` (`src/evaluation_platform/`).
**Conditions on every number below.** In `slo-driven-ai-operations` the metrics
source, scaling target, and paging integration are in-process stand-ins: the
control logic is real, the pipeline is not. In `evaluation-platform` no model is
called; systems under test are deterministic functions with a configured
accuracy, and the statistics are a two-proportion normal approximation — not
exact, and **unpaired**, so every sample size below is conservative (both arms
run the same examples; a paired test needs fewer).
Figures I call measured I ran against the labs' own functions on Python 3.14.5;
baselines established here first were 32/32 and 17/17, both still green with
these excerpts bound over the originals.

## Two windows, and a budget that is allowed to go negative

From `labs/slo-driven-ai-operations`, `src/platform_ops/slo.py`. Serves "fire
only when both windows cross" and "compute burn rate as the observed error rate
divided by the rate the target permits, and report budget remaining signed".

```python
class SLOTracker:
    def _burn_rate(self, lookback_seconds: float) -> float:
        cutoff = self._clock() - lookback_seconds
        recent = [o for o in self._outcomes if o.at >= cutoff]
        if not recent:
            return 0.0
        observed_error_rate = sum(1 for o in recent if not o.success) / len(recent)
        allowed_error_rate = 1.0 - self._spec.target
        if allowed_error_rate <= 0:
            return float("inf") if observed_error_rate > 0 else 0.0
        return observed_error_rate / allowed_error_rate

    def report(
        self, rules: Sequence[BurnRateAlertRule] = DEFAULT_BURN_RATE_RULES
    ) -> ErrorBudgetReport:
        self._prune()
        total = len(self._outcomes)
        failed = sum(1 for o in self._outcomes if not o.success)
        allowed_failures = (1.0 - self._spec.target) * total
        budget_remaining = 1.0 - (failed / allowed_failures) if allowed_failures > 0 else 1.0

        evaluations: list[BurnRateEvaluation] = []
        severity = AlertSeverity.OK
        for rule in rules:
            long_rate = self._burn_rate(rule.long_window_seconds)
            short_rate = self._burn_rate(rule.short_window_seconds)
            fired = long_rate >= rule.threshold and short_rate >= rule.threshold
            evaluations.append(
                BurnRateEvaluation(
                    severity=rule.severity,
                    threshold=rule.threshold,
                    long_window_burn_rate=long_rate,
                    short_window_burn_rate=short_rate,
                    fired=fired,
                )
            )
            if fired and severity_rank(rule.severity) > severity_rank(severity):
                severity = rule.severity

        return ErrorBudgetReport(
            service=self._spec.service,
            target=self._spec.target,
            total_requests=total,
            failed_requests=failed,
            budget_remaining_fraction=budget_remaining,
            evaluations=tuple(evaluations),
            severity=severity,
        )
```

One `and` carries the mechanism: `_burn_rate` runs twice per rule with two
lookbacks, and neither result alone fires anything. Its division makes a
threshold portable — observed error rate over the rate the target permits, so
1.0 exhausts the budget exactly at window end, and the lab's page default of
14.4 drains the demo's 30-day budget in about 2.1 days: 30 ÷ 14.4. The
`evaluations.append(...)` runs whether or not the rule fired, so an alert can be
explained afterwards, and `budget_remaining` is unclamped — I measured −999.0 at
a 99.9 % target with 100 failed outcomes in the window, which clamped would read
as one failure too many. `if not recent: return 0.0` and the `else 1.0` make an
empty window indistinguishable from a perfect one: a tracker with nothing
recorded gave me severity ok, budget 1.0, both rates 0.0.

Deliberately omitted: the imports; `DEFAULT_BURN_RATE_RULES`, whose page rule is
quoted above and whose ticket rule is 6.0 over 6 h / 30 m; `__init__`; the `spec`
property; `record`; `_prune`; the class docstring. `_burn_rate` and `report` are
adjacent in the file; the `class SLOTracker:` header is not, and is retained only
so the block parses. It compiles but does **not** import: a default argument is
evaluated when the `def` runs, so executing it raises `NameError` on
`DEFAULT_BURN_RATE_RULES`. Supply that and `SLOTracker(spec)` then raises
`TypeError`, `__init__` being gone. No comment here is mine; it has none.

## Severity checked before the cooldown

From `labs/slo-driven-ai-operations`, `src/platform_ops/autoscaler.py`. Serves
"pass severity into the scaling decision, and check it before the cooldown" and
"never let utilisation be the only scaling input".

```python
class AutoscalingController:
    def decide(
        self, *, current_replicas: int, utilization: float, alert_severity: AlertSeverity
    ) -> ScalingDecision:
        now = self._clock()

        if (
            alert_severity == self._policy.fast_burn_severity
            and current_replicas < self._policy.max_replicas
        ):
            decision = self._clamped_decision(
                current_replicas + 1,
                current_replicas,
                "fast error-budget burn detected; scaling up despite cooldown",
            )
            self._last_scaled_at = now
            return decision

        since_last_scale = None if self._last_scaled_at is None else now - self._last_scaled_at
        cooldown = self._policy.cooldown_seconds
        in_cooldown = since_last_scale is not None and since_last_scale < cooldown
        if in_cooldown:
            return ScalingDecision(
                action=ScalingAction.HOLD,
                replicas=current_replicas,
                reason="within cooldown window since the last scaling action",
            )
```

The design is the textual order: the severity branch sits above the cooldown
branch and returns, so a page-severity burn never reaches the timer and
everything else does. Reverse the two and the code still reads sensibly, still
passes any test that does not advance the clock, and no longer works.
`alert_severity` being a parameter is the other half — the controller cannot
compute its own health signal, so it cannot disagree with the alerting that did.

The override also sets `_last_scaled_at`: at page severity, then immediately at
ok severity, I got HOLD, "within cooldown window".

Deliberately omitted: the imports; `__init__`; the class docstring; and
everything after the cooldown block — the proportional target with its HPA-style
`_target_replicas` helper, and `_clamped_decision`, called above, which clamps to
the policy's replica bounds. The block compiles and imports as printed; the first
`decide` raises `AttributeError` on `self._clock`, `__init__` being omitted. No
comment here is mine; it has none.

## Escalate, never retry, and end in a state that names someone

From `labs/slo-driven-ai-operations`, `src/platform_ops/runbook.py`. Serves
"escalate an unresolved runbook step; never retry it", "give every runbook step
its own timeout", and "terminate in an explicit exhausted state".

```python
class IncidentRunner:
    async def run(self, incident_id: str, service: str, severity: AlertSeverity) -> IncidentReport:
        context = IncidentContext(service=service, severity=severity)
        executions: list[StepExecution] = []
        final_escalation: str | None = None

        for step in self._runbook.steps:
            context.attempts += 1
            started = self._clock()
            timed_out = False
            try:
                async with asyncio.timeout(step.timeout_seconds):
                    resolved = await step.action(context)
            except TimeoutError:
                resolved = False
                timed_out = True
            duration = self._clock() - started

            if resolved:
                executions.append(
                    StepExecution(
                        step.name,
                        resolved=True,
                        timed_out=False,
                        escalated_to=None,
                        duration_seconds=duration,
                    )
                )
                return IncidentReport(
                    incident_id=incident_id,
                    service=service,
                    severity=severity,
                    status=IncidentStatus.RESOLVED,
                    steps=tuple(executions),
                    final_escalation=None,
                )

            final_escalation = step.escalate_to
            executions.append(
                StepExecution(
                    step.name,
                    resolved=False,
                    timed_out=timed_out,
                    escalated_to=final_escalation,
                    duration_seconds=duration,
                )
            )

        return IncidentReport(
            incident_id=incident_id,
            service=service,
            severity=severity,
            status=IncidentStatus.EXHAUSTED,
            steps=tuple(executions),
            final_escalation=final_escalation,
        )
```

There is no retry anywhere in this function, and that absence is the pattern.
The loop only moves forward: an unresolved step records its escalation target and
the next runs, timed-out steps included, so a hanging step cannot become an
incident that stops progressing. `final_escalation = step.escalate_to` overwrites
on every unresolved step, so the exhausted report carries the *last* step's
contact, not the most senior one reached. A two-step runbook whose
steps both fail and whose last step has `escalate_to=None` gave me EXHAUSTED with
`final_escalation` None, while `steps` still showed the first escalating to
`platform-oncall` — the state that says who owns the incident named nobody.
`except TimeoutError` also catches only the timeout: an exception inside
`step.action` propagates out of `run`, leaving no report at all.

Deliberately omitted: the imports; `__init__`; the class docstring; and the
`Runbook` class above it, which holds the ordered steps and refuses an empty
sequence. The `class IncidentRunner:` header is retained above a non-adjacent
`run` (`__init__` sits between) so the block compiles; it imports as printed and
the first `run` raises `NameError` on `IncidentContext`, the imports being gone.
No comment here is mine; it has none.

## A significance test that is allowed to say "cannot tell"

Composed from `labs/evaluation-platform`, `src/evaluation_platform/significance.py`:
three `Comparison` methods adjacent in the file, followed by a module-level
function that is not — `required_sample_size` sits between them. Serves "let the
significance answer be three-valued" and "publish the eval set's smallest
detectable delta".

```python
class Comparison:
    def approximation_is_usable(self) -> bool:
        """Guards against reporting a confident answer the maths cannot support."""
        p = self.pooled_rate
        cells = (
            self.baseline_total * p,
            self.baseline_total * (1 - p),
            self.candidate_total * p,
            self.candidate_total * (1 - p),
        )
        return min(cells) >= MIN_EXPECTED_COUNT

    def is_significant(self) -> bool | None:
        if not self.approximation_is_usable():
            return None
        return abs(self.z_score()) > Z_ALPHA

    def confidence_interval(self) -> tuple[float, float]:
        """95% interval on the delta. If it contains zero, the delta is not established."""
        a, b = self.baseline_rate, self.candidate_rate
        se = math.sqrt(
            a * (1 - a) / self.baseline_total + b * (1 - b) / self.candidate_total
        )
        margin = Z_ALPHA * se
        return (self.delta - margin, self.delta + margin)


def smallest_detectable_delta(baseline_rate: float, sample_size: int) -> float:
    if sample_size <= 0:
        raise ValueError("sample_size must be positive")
    variance = 2 * baseline_rate * (1 - baseline_rate)
    return (Z_ALPHA + Z_POWER) * math.sqrt(variance / sample_size)
```

`-> bool | None` is the rule, and the guard producing the third value is four
expected cell counts against a floor of five — the regime small eval sets live
in, so "cannot tell" is the common answer there. `confidence_interval` uses each
arm's variance while the omitted `z_score` pools them, which a hand-rolled
version gets wrong by reusing one.

Measured with the lab's own functions here, at 95 % two-sided confidence and
80 % power: 42/50 against 44/50 gives +4.0 points with an interval of [−9.6,
+17.6] and `is_significant()` False — the same data is consistent with a
ten-point regression. `smallest_detectable_delta` at an 85 % baseline returns
20.0 points for n = 50 and 14.1 for n = 100; +3 points there needs 2,033 examples
per arm against 457 for +6, a factor of 4.45, since effect size enters squared.

Deliberately omitted: the module docstring; the imports; `Z_ALPHA`, `Z_POWER`,
`MIN_EXPECTED_COUNT`; the `@dataclass(frozen=True)` decorator, the class
docstring, the four fields, and the `baseline_rate`, `candidate_rate`, `delta`
and `pooled_rate` properties; `z_score`, which sits above
`approximation_is_usable` and pools the variance; `required_sample_size`, which
separates the class from the printed function; the docstrings of
`is_significant` and `smallest_detectable_delta`, and the latter's three-line
comment about approximating the candidate variance by the baseline's. The block
compiles and imports; `Comparison(42, 50, 44, 50)` then raises `TypeError`, the
decorator and fields being gone, and `smallest_detectable_delta` raises
`NameError` on `Z_ALPHA`. Nothing here was added or rewritten by me, and after
that one deletion the block carries no comment at all.

**Source:** [Lab: SLO-Driven AI Operations](https://handbook.vinodspattar.in/build/labs/slo-driven-ai-operations/), [Lab: Evaluation Platform](https://handbook.vinodspattar.in/build/labs/evaluation-platform/) (with its decision-path diagram), [`labs/slo-driven-ai-operations`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/slo-driven-ai-operations), [`labs/evaluation-platform`](https://github.com/vins13pattar/principal-ai-engineer-handbook/tree/main/labs/evaluation-platform)
