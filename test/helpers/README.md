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
