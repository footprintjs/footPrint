# Native closure data boundary

`format.ts` copies the exact inert descriptor for one already recorded native prefix.
`evidence.ts` checks its retained invocation counts and commit identities. Neither
module observes live execution, selects a failure, or attests semantic cause.

Both are reader-safe L0 modules. `invocations.ts` is the separate producer-only
bounded count/token owner; readers never import it. No module keeps a live frame,
error, scope or callback. Producer state stays out of the trace import graph.
The adjacent tests exercise refusal; the engine scenarios cover collection and saving.
