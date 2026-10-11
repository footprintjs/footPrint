# Interleaved fork: causal read-anchor regression

Captured through published `footprintjs@10.0.0` / `foottrace@1.0.0` public APIs
on 2026-10-10. No library source or recorded row was modified.

`generate.mjs` creates Seed, parallel children A/B, and Join. Seed writes
`runs.b.x = 1`; A reads that 1 and writes `runs.a.y = 2`; B writes its own
`runs.b.x = 9`. The producer then records empty A/B repeat bundles. A's
captured read must keep Seed as its parent, not the temporally later B.

| File | Contents | SHA-256 |
| --- | --- | --- |
| `interleaved-fork-10.0.0.json` | Unchanged commit log, actual scalar observations, and a projection of the actual execution tree's identity/read/next/children fields | `45b01229a52eaf72b305577647c1e191c49025722614f1d610b6bfe251b4d07d` |
| `runtime-snapshot-10.0.0.json` | Full JSON serialization of a second actual run's public snapshot, including initial/current state and runtime diagnostics | `3a22244cf2f71465b5647a8639de1d0481c99f9342f0874c336c3d35f8613990` |

The second run's log and projected read evidence match the first fixture.
The full snapshot is retained for consumer characterization; its runtime
diagnostics may differ in a future capture. These files are never silently
regenerated. Ordinary JSON serialization applies; no value normalization or
record rewriting is performed.

To reproduce the public scenario using a separate existing installation:

```sh
node test/fixtures/causal-phases/generate.mjs /path/to/footprintjs-10-install
node test/fixtures/causal-phases/generate.mjs /path/to/footprintjs-10-install --full
```

The generator requires exact producer/record versions and emits JSON to
stdout: the reader projection normally, or the full snapshot directly with
`--full`. The original full capture extracted the unchanged `runtimeSnapshot`
field from the capture wrapper before serialization. It does not install
packages or write files. The capture used
`/private/tmp/npm-signature-procedure.Rl9mcj/postpublish-LAZgAa`, an isolated
installation of the verified published packages. That path is evidence, not
a test prerequisite. This maintenance backport loads the same immutable fixtures through
`footprintjs/trace`; it does not introduce a Foottrace dependency into 9.x.
The source scenario remains the exact published FootPrint 10 / Foottrace 1
capture documented above.

`test/lib/memory/backtrack-phases.test.ts` first failed against unmodified
Foottrace 1.0.0; the maintenance test repeats that check against 9.48.3 (36 failed, one fixture-verification test passed). The corrected
expectations cover the real run and explicitly labelled synthetic variations:
small/large lookup strategies, stage/per-write attribution, direct roots,
data/control parents, nonempty continuations, re-expansion and legacy rows.
The existing HCI writer fixture and all prior record pins stay unchanged.
