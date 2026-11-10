# Declared-rule narrative formatting

This internal module turns the decision and selection evidence already collected by the engine into the default English narrative. It never evaluates a predicate or collects another scope read. The recorder owns event ordering, buffering, custom-renderer dispatch and storage; it calls these plain formatting functions.

Every threshold is printed with one bounded, inert preview (`index.ts · thresholdText`): a string, number, boolean, null or undefined is summarized, any other value reads `[recorded threshold]`, and a masked threshold is the placeholder. It never calls `toJSON` or an accessor and never throws.

Adjacent index.test.mjs tests are included explicitly by the existing Vitest configuration without entering the TypeScript package build. End-to-end evidence, redaction and saved-history coverage stays in test/lib/decide/scenario/empty-selection-evidence.test.ts.

Stateful recording and the remaining default renderers live in the recorder (`CombinedNarrativeRecorder`).
