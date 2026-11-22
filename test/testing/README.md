# Chart-law baseline measurements

These tests measure existing public pause/resume and saved-record behavior before a testing API exists.
They add no engine implementation, serialization adapter or delivery helper.

- `baseline.fixtures.ts` owns fresh finite chart/answer fixtures and machine-readable observation rows.
- `baseline.pause.test.ts` compares named business state under direct and native paused execution.
- `baseline.record.test.ts` reads plain saved records through Foottrace, separately disclosing unavailable narrative queries.
- `baseline.limitations.test.ts` pins actual native limitation outcomes; it does not claim that a future kit refuses them.

Existing real-chart property, spine and argument-parity tests remain unchanged. The baseline reuses their exported
fixture charts and driver for additional anchor observations, without importing test modules or copying their builders.
Generated counts, seeds, shrinking and original timeouts retain their existing owners.

Each observation prints `CHART_LAW_BASELINE` followed by JSON. A supported comparison, an observed limitation,
an unavailable query and an unfinished run are distinct outcomes. Whole snapshots are never normalized into equality.
Checkpoints use JSON only for explicitly JSON-safe fixtures. Plain record entries use Foottrace's existing codec.

This phase uses ordinary inline recorders and plain `memorySink` storage. Rich capture persistence and delivery laws
are outside this baseline; no timers, retries, fake clocks or extra runtime instrumentation are introduced.
