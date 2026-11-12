# Native invocation extent

This internal capability records the engine's bounded native-invocation bookkeeping for one root-log leg. It does not establish closed capture, external cancellation, producer authenticity or a semantic root cause.

- collector.ts owns the live counters, gaps and immutable terminal cut.
- format.ts owns the version-1 data vocabulary and strict inert-data admission.
- index.test.mjs checks the adjacent runtime/data boundary. The existing capture and saved-history integration suites remain in test/lib/.

There is deliberately no mixed barrel: saved-history readers import format directly; engine producers import collector. The existing packed import-graph test proves the reader door cannot load the native collector.

Version 1 stays running/unverified, its bounds are fixed, and missing evidence stays unknown. Source-adjacent .test.mjs files are discovered by Vitest and excluded from TypeScript package emission.
