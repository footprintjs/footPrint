# Judge proof ports

One job: lazily assemble actual read/commit evidence into the optional `judgeWitness` proof ports. The existing caller still supplies differs/redacted and the existing exact/redaction sameCommit closure inside judgeWitness. No diagnostic string is parsed and no boolean clears a failure.

`coordinateOf` reports the actual commit occurrence for old9.30. `firstReadCause` constructs candidates from actual receipt/span/receiver joins, then requires the closed branch validator INCLUDING common first-commit, native encoder-origin, frame/epoch and unchanged-outside-operation guards. Host's declared-chart-branches-only result is intentionally the WRONG return type for this port. A missing/ambiguous cause is unproven. `retainedReadCause` separately requires last-owner/delivery binding and then the exact residual kept-string relation.

Root can initially bind `closedFirstCause` to the existing firstCommit124 for the supported WRITEBACK shape; NESTED/CHART unsupported first-commit branches stay unproven until their own closed strategy + common guard is integrated. This is never a family/opcode exemption. Read-only shape1 is independent of first-commit strategy availability.

After source placement, basic caller code is:

```ts
const a = joinedRun(observedBaseline, baselineKept);
const b = joinedRun(observedBuild, buildKept);
const diff = firstDifference(a.kept, b.kept, redacted);
const decision = judgeWitness(a.commits, b.commits, diff !== '', redacted,
  readLawPorts(a, b, family, checkedClosedFirstCause));
const broken = formatWitnessDecision(decision);
// Existing failure/program diagnostic, tally and independent generation/no-alias checks stay at their owners.
// Save the decision's named cause/coordinate as data beside the existing tally.
```

Keep native metadata artifacts beside the original actual values when applying existing M8 exclusions. Do not delete/normalize a new field to make these ports pass. Corpus integration still must first verify live baseline digests against the stored9.28 corpus, and keep a separate named #124 admission list that rejects starts/stops differing. Pause remains explicit per actual leg; no synthetic merged native receipt.
