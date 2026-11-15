# Stage-authored error retention

One retained projection, with weak execution-scoped provenance. `sources.ts` keeps
setup unknown until the actual stage-body call; a stale binding is unknown too.
`retention.ts` samples live source selection after error conversion and key reads.
`maskedErrors.ts` remembers the projection without retaining thrown objects strongly.

The redaction rule owns selection and the placeholder. StageRunner supplies only
phase and provenance; stage-error/facade serving asks at the existing late hooks.
Native attempts, operational exceptions, capture envelopes and scheduling stay owned
by their existing modules. Unknown stage sources mask under an active state policy;
adapter failures are not assigned stage provenance. Tests are beside these helpers;
integration controls live in `test/lib/engine/security/stage-error-source-redaction.test.ts`.
