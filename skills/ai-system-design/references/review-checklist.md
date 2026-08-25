# Review checklist

For the case where someone has sent you a design document and you have an hour.
Work the sequence in order — each step's failure invalidates the ones below it,
so a review that starts at the diagram produces comments that cannot be acted
on. Cost and observability come last but always.

## The sequence

1. **Read the constraints before the diagram.** *Failing answer:* a constraints
   section written in adjectives — "high scale", "low latency", "must be
   reliable" — or no constraints section at all. Stop there. That absence is the
   finding, and it is a bigger one than anything you would have found in the
   diagram, because every downstream comment would be measured against your
   assumptions rather than the author's requirements.

2. **Check that the requirements would change the design.** *Failing answer:*
   you can swap the volume or the latency target and the architecture is
   identical. The constraints are decoration and the components were chosen
   first. The tell is usually a design that opens with a technology list.

3. **Find the decision that is hardest to reverse.** Data boundary, state
   ownership, external contract — sorted by cost to undo in
   [failure-thinking.md](failure-thinking.md). Ask whether the author knows
   which one it is; most of the review's value concentrates here. *Failing
   answer:* every decision is presented at the same weight, which means none was
   deliberated, including the expensive one.

4. **Trace one request end to end** and look for the seam nobody described:
   retries, partial failure, what holds state, what happens on redeploy.
   *Failing answer:* a component inventory with arrows. Arrows do not say what
   the receiver does with a half-written response, and that is where the design
   is either finished or not.

5. **Ask what would refute it.** Each claim needs a measurement and a threshold
   at which someone acts. *Failing answer:* "it will scale", "quality is
   sufficient", "we'll monitor it". Push until a claim has a number, a signal
   that produces the number, and the event that causes the check to run.

6. **Comment on cost and observability last but always.** They are the two
   sections most often missing and the two that predict operability. *Failing
   answer:* no cost per request anywhere in the document — which reads as a
   design whose costs were never understood, since in an AI system cost per
   request is what governs how far the design scales before it changes shape.

7. **Separate blocking from non-blocking, explicitly, in writing.** *Failing
   answer:* one undifferentiated list of comments. It gets treated as
   all-optional or all-mandatory, and both are wrong. State which are which, and
   for each blocking one, how you would know it was fixed.

## Questions that find real problems

| Section | Ask |
| --- | --- |
| Constraints | Peak rps, p99 target, what "correct" means, whose data, cost per call |
| Capacity | Does `arrival_rate × latency` agree with the configured pool and replica counts? |
| State | Who owns it, what a failure loses, what happens on the second replica |
| Retries | Bounded attempts, bounded total deadline, jitter — and is the handler idempotent? |
| Failure | What breaks first at 10×? What is the blast radius of full compromise? |
| Data | Is permission filtering inside the query, or applied after retrieval? |
| Quality | Is there an eval set, a threshold, and an owner? Or only latency monitoring? |
| Rollout | Reversible in one deploy? If not, what evidence would change the decision? |

Two of those rows are the AI-specific ones and they are the rows most often
absent. A design with no evaluation story has no way to detect its own most
likely failure — the model that stays fast, stays available, and gets worse. A
design that filters permissions after retrieval leaks through result counts and
latency even on the requests where no unauthorized text is returned.

## Review habits that waste the hour

- **Rewriting the design as the one you would have written.** That is a
  different document, not a review, and the author cannot act on it without
  discarding their own.
- **Litigating a two-way door.** If it is reversible in a deploy and the author
  owns the code, let it go.
- **Comments with no stated constraint behind them.** They read as preference
  and get treated as preference, which is the correct response to them.
- **Approving because it is well written.** Prose quality and design quality are
  uncorrelated, and the well-written design with no capacity arithmetic is the
  one that gets approved fastest.
- **Blocking on something you have not said how to fix, or how you would know it
  was fixed.** The author now has a veto with no exit condition.

## Feedback that lands

Name the constraint you are reasoning from, state the failure you predict
concretely, and say what would change your mind. A comment with all three is
hard to dismiss and easy to act on. Missing the first, it is preference; missing
the second, it is a worry; missing the third, it is a demand.

Most design arguments turn out to be about unstated requirements rather than
about the design. When a colleague prefers a different approach, separate the
disagreement into constraint, evidence, and preference: resolve the constraints
first, then name the evidence that would settle it and what it would cost to
get, and if what remains is preference within the same constraints, it is a
two-way door and not worth the meeting.

## Red flags in the design itself

Technologies chosen before constraints · capacity in adjectives · the model
treated as a function returning a string, with no cost, no latency tail, and no
degradation · no evaluation story · security discussed only as authentication,
ignoring retrieved documents, tool descriptions, and model output feeding an
action · no stated cost for any decision · state owned by two components at once
· a public API shipped without a version.

The mirror-image red flag is a design built for a hundred times its actual
traffic. It carries the operational burden of that complexity every day in
exchange for capacity nobody uses, and the discipline is identical: state the
constraint, and let it justify the complexity or not.

**Source:** [Cheat Sheet: Design Review](https://handbook.vinodspattar.in/cheatsheets/sheets/design-review/), [Cheat Sheet: Design Round](https://handbook.vinodspattar.in/cheatsheets/sheets/design-round/), [Module 13: System Design](https://handbook.vinodspattar.in/learn/modules/13-system-design/)
