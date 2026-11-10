# Declared-rule narrative formatting

This internal module turns the decision and selection evidence already collected by the engine into the default English narrative. It never evaluates a predicate or collects another scope read. The recorder owns event ordering, buffering, custom-renderer dispatch and storage; it calls these plain formatting functions.

Empty selections print their thresholds with a bounded, inert preview (`index.ts · thresholdText`): a string, number, boolean, null or undefined is summarized, any other value reads `[recorded threshold]`, and a masked threshold is the placeholder. Matched rules and nonempty selections print the threshold as JSON; a threshold that cannot be serialized (a BigInt, a cycle, a throwing `toJSON` or getter) falls back to the inert preview, so the line is never lost.

Adjacent index.test.mjs tests are included explicitly by the existing Vitest configuration without entering the TypeScript package build. End-to-end evidence, redaction and saved-history coverage stays in test/lib/decide/scenario/empty-selection-evidence.test.ts.

Stateful recording and the remaining default renderers live in the recorder (`CombinedNarrativeRecorder`).
