# Stage-authored error retention

One retained projection, with weak execution-scoped provenance. `sources.ts` keeps
setup unknown until the actual stage-body call; a stale binding is unknown too.
`retention.ts` samples live source selection after error conversion and key reads.
`maskedErrors.ts` remembers the projection without retaining thrown objects strongly.
`origins.ts` binds native callbacks to one execution and isolates their weak object
memos. Native scalar errors are freshly decided, rather than sharing a scalar history.
`selectedError.ts` owns the existing cause/aggregate walk with that same origin memo.
Remembered partial projections are reconsidered when current sources require a stronger
mask. Under an active policy, an opaque structured message/name or a failed extraction
is unavailable and masked, rather than serving a value with a false string type.

The redaction rule owns selection and the placeholder. StageRunner supplies only
phase and provenance; stage-error/facade serving asks at the existing late hooks.
Native attempts, operational exceptions, capture envelopes and scheduling stay owned
by their existing modules. Unknown stage sources mask under an active state policy;
adapter failures are not assigned stage provenance. Tests are beside these helpers;
integration controls live in `test/lib/engine/security/stage-error-source-redaction.test.ts`.
The native failure owner separately retains clear/masked/unknown projections against
its current pending token (`errors/failureRetention`). `escaping.ts` consumes that
receipt for terminal events and root closing metadata; absence cannot attest clear.
