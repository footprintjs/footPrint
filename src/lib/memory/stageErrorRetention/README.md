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
`owned.ts` registers the same policy owner's private port while preserving every public
RedactionRule method signature and arity. `boundary.ts` applies actual error-envelope
slot decisions through the existing cycle/alias copier. Generic views retain the
already-safe object projection weakly, preserving public partial-mask messages and
protecting raw causes without rereading them. This never attests a current native
origin: native memos and affirmative result slots remain independent. No scalar
history, pending owner, frame or callback is held by that generic privacy view.

Generic and native object privacy facts carry explicit mask strength: raw-only,
diagnostic text, or full source/opaque masking. Generic serving and boundary leaves
choose the strongest fact, so an earlier partial cache cannot hide a later full mask.
This choice never supplies the sources of a new native execution.

Native and wrapper calls hand the private owner their exact diagnostic address. The
existing diagnostic reducer returns its actual whole-selection flag with the retained
value, so text that already equals the placeholder cannot attest clear. Diagnostic-only
selection keeps the existing public name/code law; source/opaque masks omit authored
fields. The public three-argument retainStageError contract still takes the caller's
already-retained text and gains no guessed adapter address or mutable last decision.
The inert generic path skips key enumeration unless real privacy knowledge exists.

Function error values participate in weak privacy lookup without invocation or
enumeration; a known masked function is served as its safe structure. Symbol
errors use only their producer's exact envelope slot and safe text, never a
scalar lookup. Clear sibling occurrences and raw operational results stay real.
