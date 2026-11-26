# Engine witnesses against foottrace

The engine imports the record through `foottrace`, `foottrace/write` and `foottrace/paths` only.
The record's unit tests live in foottrace; these helpers support tests of what the engine writes.

`recordWitness.ts` is deliberately test-only instrumentation. The existing copy-on-write
differentials and their adversarial controls patch the actual buffer's `commit`, `admit` and
`detachBase` methods. They obtain that identity from a publicly constructed `RecordFrame`, after
one ordinary write. The helper fails loudly if the private layout or a watched method changes.
This preserves those controls without a private package import, an extra public API or a copy of
the implementation. Runtime code must never depend on this helper or private buffer layout.

`pathRelationOracle.ts` compares segment arrays independently for the engine-log differentials.
The record's production relationship implementation is not imported into its own oracle.

`childProcessEnv.ts` creates the minimal environment for disposable npm/Git fixture children: only the Node executable search path, optional Windows `SystemRoot` and the host's temporary-directory pointers (`TMPDIR`, `TMP`, `TEMP`, each only when the host sets it), then the existing Git isolation boundary. A temp pointer is a location, not a capability: without it a child's `os.tmpdir()` falls back to `/tmp`, away from the host's own scratch, and fails where `/tmp` is not writable. Each fixture adds its own registry, cache and execution controls explicitly; no ambient credentials or startup hooks are inherited. `test/architecture/child-process-env.test.ts` pins the exact set.
