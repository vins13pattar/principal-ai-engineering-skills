# Review checklist

Ordered by what the failure costs, not by where it appears in the file. The
first three are the ones that let a bad change reach all of production with
every dashboard green, so stop and comment at the first failing answer in that
section. The middle group is ranked by blast radius; the last two sections are
always worth asking.

## The three that find the most

1. **Is every metric keyed by version, and does the rollout decision read the
   canary's own entry?** *Failing answer:* one counter per endpoint, or a
   per-version breakdown that exists on a dashboard while the promote gate
   reads the aggregate. A canary at a small traffic share failing outright
   moves a blended error rate by about its traffic share — five points at 5 %,
   inside normal variance — so the aggregate is not merely a worse signal, it
   is one no threshold can rescue. Ask for the test: a version wired to fail
   every request, run at canary weight, with an assertion that the metric
   somebody would alert on actually moves. If that test does not exist, the
   canary has never been shown to be capable of failing.

2. **What happens to the pending requests when the batch handler raises?**
   *Failing answer:* the exception propagates out of the flush. The background
   loop exits, and from then on every queued request and every later arrival
   awaits a future nothing will resolve — a total outage that presents as
   slowness, with no error rate to see it by. The flush must catch broadly, set
   the exception on each waiter, and continue looping. Check the guard on each
   waiter too: setting a result on an already-cancelled future raises, which
   strands the rest of that batch.

3. **What is the latency SLI?** *Failing answer:* the mean, or a percentile
   that blends queue wait with model time. Batching makes the distribution
   bimodal — a request arriving just after a batch closes waits nearly the full
   timeout longer than one arriving just before — so the mean is the average of
   two humps and describes neither. Summed with queue wait, a system starved of
   batch slots is indistinguishable from a slow model, and the two have
   opposite fixes. Look for p95 and p99, split, with the mean absent from the
   panel rather than merely unused.

## Then, in blast-radius order

4. **Does closing the batch race two conditions, and does exactly one loop own
   the flush?** *Failing answer:* a single trigger, or a flush reachable from
   the submit path. Size-only lets a lone request wait indefinitely during a
   lull; timeout-only wastes throughput under load. And if `submit` can flush,
   two concurrent callers form two batches, which inverts the mechanism while
   still passing a single-request test.

5. **Is rollback a routing-weight change — and has anyone decided what a
   zero-weight version does with an explicit version request?** *Failing
   answer:* rollback is a redeploy, or nobody has asked the second question.
   Dropping a weight removes a version from the weighted draw and does nothing
   about a caller who names it, so the same code is either working version
   pinning or a rollback that did not roll back. The two readings are
   indistinguishable in the diff; the decision has to be written down and
   tested.

6. **Is there a quality signal on the serving path, separate from the health
   check?** *Failing answer:* readiness, liveness, latency, and error rate. A
   worse model returns fast, well-formed, wrong answers and passes all four.
   Then check what triggered the change: a quantization or distillation step
   filed as an optimisation has usually skipped the evaluation a version swap
   would have received, safety evaluations included.

7. **What was the autoscaling signal chosen against, and is cold start measured
   or estimated?** *Failing answer:* CPU or accelerator utilisation, and a
   cold-start number nobody has timed. Utilisation trails demand while loading
   weights takes minutes, so the new replica is ready after the spike it was
   summoned for. Queue depth and queue wait lead; warm headroom covers the
   rest, and it can only be sized from a measured number.

8. **What does admission control actually count?** *Failing answer:* a fixed
   request or concurrency limit. KV cache, not the weights alone, is what caps
   concurrency, and it grows with every token generated — so a request that fit
   when it was admitted may not fit ten decode steps later. Look for a budget
   re-evaluated per step, with finished sequences evicted and their pages freed
   before the next admission.

9. **Does each version have its own batcher, or do they share a queue?**
   *Failing answer:* one queue for the endpoint. A shared queue couples the
   canary's batch size and wait time to the stable version's tuning and merges
   both latency distributions, which quietly undoes per-version metrics one
   layer down.

10. **When was the batch tuning last run, and against what?** *Failing answer:*
    at launch, or against uniform synthetic prompts. Batch cost grows with the
    batch's padded sequence length, so optimal size is a property of the
    traffic's length distribution rather than its rate — and that distribution
    drifts with nothing signalling it. The size limit and the wait timer are
    one pair with opposing effects and cannot be tuned separately. Both the
    date and the distribution should be recorded.

11. **Can one batch contain requests from tenants that must not share a failure
    domain?** *Failing answer:* batch composition is whatever arrived. Every
    request in a batch shares a crash and shares a latency; one tenant's burst
    of long prompts spends another's budget. Same question for a device shared
    between models: which availability tier does each belong to, and is a
    latency-sensitive model packed with a batch workload?

12. **Does the benchmark bound its own concurrency, and does it keep the
    failures?** *Failing answer:* every request fired at once, or failed
    requests dropped from the latency distribution. An unbounded client
    measures itself and reports percentiles for a workload nobody sends — and
    for a batching server, concurrency is what decides whether batches close on
    size or on the timer, so an unbounded run exercises one regime and reports
    it as the system's behaviour. Dropping failures lets an endpoint that fails
    fast flatter its own tail.

13. **Where do prompts and completions get written down?** *Failing answer:*
    redaction applied downstream of the log sink. They pass through the queue,
    the batcher, the logs, and the traces; sampled request logging is the
    normal route into a system with different retention rules. Redact at the
    point of logging.

## Cost — last but always

14. **Is the memory of every live version accounted for in capacity?**
    *Failing answer:* only the version currently serving. Rollback headroom is
    a standing cost — each live version holds its own weights and KV cache —
    and it is what bounds how many versions can be live at once. Discovering it
    when the canary will not load is discovering it during a rollout.

15. **Is warm headroom a number somebody chose?** *Failing answer:* a default,
    or scale-to-zero on a path with user-visible latency. It is insurance
    bought against a measured cold start and an observed burst shape; both
    directions cost money, and only one of them costs it visibly.

## Observability — last but always

16. **Are batch size distribution and time-to-fill exported?** *Failing
    answer:* neither. Batches that consistently close on the timer rather than
    on size mean the size limit is not the binding constraint and the wait is
    pure added latency — the cheapest available evidence that the tuning has
    drifted.

17. **Are time-to-first-token and time-per-output-token separate series?**
    *Failing answer:* one latency number. They are bounded by prefill and
    decode respectively, which have different bottlenecks, so the blend hides
    which phase needs the work.

18. **Are queue depth and wait time exported at a resolution a controller can
    use?** *Failing answer:* a one-minute dashboard average. They are the
    signal the measured-cold-start check asks for, and one sampled slower than
    the thing it controls is decoration.

**Source:** [Architecture: Model Serving Platform](https://handbook.vinodspattar.in/architecture/systems/model-serving-platform/), [Module 9: Model Serving](https://handbook.vinodspattar.in/learn/modules/09-model-serving/), [Lab: Dynamic Batching Inference](https://handbook.vinodspattar.in/build/labs/dynamic-batching-inference/)
