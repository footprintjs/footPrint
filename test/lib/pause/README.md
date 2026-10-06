# Pause and resume tests

The real-chart property compares a paused/resumed run with a direct run of the same plan. It retains 160 generated plans in each executor mode, six placement choices at each depth, all loop/pause bounds and the hand-picked anchors. Cross-executor resumes still serialize and parse every checkpoint as JSON.

## Reproduce a property run

`resume-property-config · resumePropertyParameters` owns this property's configuration. Normal runs draw a fresh random seed for each mode, so every CI run checks a new batch. The effective seed is part of the test name before execution starts, so an outer Vitest timeout still identifies the batch. Fast-check's native failure report retains the seed, shrunk counterexample path and original error; no custom reporter replaces it.

Run the normal gate:

```bash
npm test -- test/lib/pause/resume-real-chart.property.test.ts
```

Explore another complete 160-case batch in one mode:

```bash
RESUME_PROPERTY_SEED=42 npm test -- test/lib/pause/resume-real-chart.property.test.ts -t 'same-executor resume'
```

For an assertion failure, copy the reported seed and path. This example replays root case `12`; substitute the actual path, including any colon-separated shrink steps:

```bash
RESUME_PROPERTY_SEED=42 RESUME_PROPERTY_PATH=12 npm test -- test/lib/pause/resume-real-chart.property.test.ts -t 'same-executor resume'
```

Explicit path replay runs only that case without further shrinking; it is a debugging command, not the full gate. Use the failing mode's name in the filter and the same source revision and fast-check version: a seed does not pin changes to the generator or its dependencies. A timeout before fast-check finishes may have no counterexample path; replay its entire named seed batch instead. Seed overrides must be signed 32-bit decimal integers. Paths must be colon-separated nonnegative safe integers and require an explicit seed. Invalid overrides fail rather than being silently coerced. Retain a discovered regression as a hand-picked anchor so it is checked on every run, not only when its seed comes up again.

## Observation ownership

`resume-real-chart-fixture · drive` owns the run/checkpoint/resume loop. Its default collects one snapshot per leg for the invariant and history tests. Callers that only inspect final state set `collectLegs: false`; `legs` is then empty and the driver requests just the final snapshot. Checkpoint collection, answering, pause bounds and same/cross executor behavior do not change. The final state reuses the last collected snapshot when history is enabled.

`resume-driver-observation.test.ts` counts calls on real executors rather than relying on machine-dependent time thresholds. For P pauses, the old driver requested P+2 snapshots, full collection now requests P+1, and final-only collection requests one. It also checks executor/resume counts, JSON checkpoint isolation, limits, errors and outcome equivalence. The property and its anchors do not assert on `legs`, so they opt out; tests that inspect history retain the default.

## Investigation limits

The previously reported five-second timeout was not reproduced on the October 5 baseline. Isolated modes took about 0.5–0.6 seconds; a clean full-suite run took about 1.3–1.8 seconds per mode. With the then-fixed seed `20261005`, instrumentation counted 1,445 public snapshot reads per mode before this change and 320 afterward (including each direct run's final snapshot). Snapshot calls accounted for about 1–2% of the instrumented runtime; checkpoint cloning, execution and garbage collection remained larger costs. This proves removal of unused observation work, not a large speedup or immunity to overloaded machines. The test timeout, generator bounds and normal run counts are unchanged. No production resume behavior is changed.
