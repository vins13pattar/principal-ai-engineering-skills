# Failure modes

Symptom first, because that is what you have when someone reports it. Ordered
by what the failure costs rather than by where it sits in the pipeline. The
first two are the ones that let a bad change reach all of production while
every dashboard stays green — one hides the evidence in an average across
versions, the other in an average across requests.

## Canary metrics folded into the aggregate

**Presents as:** nothing. A green rollout dashboard, a canary promoted on
schedule, and a quality or error problem that appears — full-sized — some hours
later, when the promoted version is serving everything. Afterwards the canary
window looks, in the data you kept, entirely normal.

**Cause:** one set of counters for the whole endpoint. A canary taking a small
traffic slice and failing *outright* moves a blended error rate by roughly its
traffic share: five points at 5 %, which is inside normal variance for most
services. The rollout mechanism therefore reports healthy at exactly the moment
it should be firing. This is arithmetic, not bad luck — no alert threshold
tuned to be useful on the aggregate can also be sensitive to a small slice, so
there is no threshold that fixes it.

**Do:** key every counter by version — request count, error count, latency
percentiles, and whatever quality proxy exists — and make the promote/rollback
decision read the canary's own entry, never the blend. Give each version its
own batcher too, or the latency distributions merge back together one layer
down. Then prove it the only way that means anything: run a version that fails
every request at canary weight, and confirm the metric you would actually alert
on moves. If it does not, the canary is theatre and should not be run.

## Tail latency nobody is watching

**Presents as:** healthy mean latency, a comfortable SLO dashboard, and users
reporting slowness that the graphs deny. Often it arrives with a batching
change that "improved latency", which it did — on average.

**Cause:** batching makes the distribution bimodal. A request arriving just
before a batch closes waits almost nothing; one arriving just after waits
nearly the full timeout. The mean is the arithmetic average of two humps and
describes neither. A second averaging hides more: queue wait summed with model
time makes a system starved of batch slots indistinguishable from a slow model,
and the two have opposite fixes.

**Do:** make p95 and p99 the SLI and delete the mean from the latency panel, so
nobody can accidentally use it. Split the percentile into queue wait and model
execution time as separate series. Split prefill from decode too —
time-to-first-token and time-per-output-token are bounded by different
resources. And measure with a client that bounds its own concurrency: an
unbounded firehose measures your load generator, not your server, and the
percentiles it reports are of a workload nobody will send.

## Health checks that pass while quality regresses

**Presents as:** a new version that is fast, cheap, and returning well-formed
responses, with liveness, readiness, error rate, and latency all green. The
regression surfaces through users, support tickets, or a downstream metric,
usually days later.

**Cause:** infrastructure health and output quality are independent axes, and
only one of them is instrumented. Nothing in a health check reads the content
of a response. A quantization or distillation change is the common trigger,
because it is filed as an optimisation rather than as a model change, so it
skips the evaluation a version swap would have received.

**Do:** put a quality signal on the serving path, per version, however crude —
refusal rate, output-length distribution, a downstream acceptance rate.
Something that moves when the answers get worse. Treat any precision or
architecture change as a model change: re-run the evaluation harness, including
the safety evaluations, on representative traffic rather than trusting an
aggregate benchmark that can hide a task-specific regression.

## Cold-start-blind autoscaling

**Presents as:** capacity that oscillates. The fleet scales out just as the
spike ends, scales back in, and is undersized again for the next one. Latency
spikes correlate with traffic increases despite an autoscaler that is
demonstrably working, and the bill is high for capacity that was never
available when it was needed.

**Cause:** a control signal with less lead time than the actuator's delay.
Loading weights takes minutes, so scaling on current utilisation — which trails
demand — guarantees the new replica becomes ready after the spike that
triggered it. Scaling to zero is the same failure in its most extreme form,
with the cold start on a user's critical path.

**Do:** measure cold start, do not estimate it — the number is the design
input, and the estimate is always optimistic. Scale on queue depth and queue
wait, both of which lead demand, and export them at a resolution a controller
can act on rather than one a dashboard can display. Hold warm headroom sized
from that measured cold start and the observed burst shape. Where traffic is
genuinely scheduled, scale ahead of the schedule instead of reacting to it.

## Batch size tuned once, on the wrong distribution

**Presents as:** a configuration that used to be right. Throughput gradually
short of target, or tail latency gradually over it, with no change to the code
and nothing in the deploy history to blame. The classic acute version: someone
doubles the batch size and throughput barely moves.

**Cause:** batch cost grows with the *padded* sequence length of the batch, so
one long sequence makes every short one in it pay for that length. Past a
point, adding requests to a batch adds padding rather than useful work. Optimal
batch size is therefore a function of the traffic's length distribution, not
its rate — and that distribution drifts continuously as callers and prompts
change, with nothing signalling that the tuning has expired.

**Do:** tune the size limit and the wait timer together, as one pair, against a
sample of real traffic lengths — they have opposing effects and neither is
correct independently. Record the date and the distribution the tuning was
taken against, and re-run it on a schedule. Watch batch size distribution and
time-to-fill in production: batches that consistently close on the timer rather
than on size mean the size limit is not binding and the wait is pure added
latency. Where the spread of lengths is wide, group similar lengths before
batching rather than raising the limit.

## Noisy-neighbour accelerator sharing

**Presents as:** a latency regression in a service whose own traffic did not
change, whose code did not change, and whose metrics show it doing less work
than usual. The hardest kind of incident to diagnose, because every signal the
owning team has is innocent.

**Cause:** several models packed onto one device to raise utilisation. The
packing also couples their latency: one model's traffic spike consumes the
memory bandwidth and the KV cache budget the others were relying on. The same
coupling appears within one model when a batch mixes tenants — a burst of huge
prompts from one starves another's latency budget, and a crash while processing
that batch fails every request in it.

**Do:** record which models share a device and which availability tier each
belongs to, so the decision is inspectable rather than emergent from a
scheduler. Never pack a latency-sensitive model with a batch workload. Keep
batch composition inside whatever tenant boundary actually matters, and
remember that a batch is a shared failure domain as well as a shared latency
one. Export per-model utilisation and cache occupancy on shared devices, since
the victim's own metrics will never explain the symptom.

**Source:** [Architecture: Model Serving Platform](https://handbook.vinodspattar.in/architecture/systems/model-serving-platform/), [Module 9: Model Serving](https://handbook.vinodspattar.in/learn/modules/09-model-serving/), [Lab: Dynamic Batching Inference](https://handbook.vinodspattar.in/build/labs/dynamic-batching-inference/)
