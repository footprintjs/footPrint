# Narrative text formatting

Internal, stateless formatting rules shared by narrative event handlers. This
module does not collect events, own a store, or walk an execution tree.

`resolveText` owns the nullable formatter-result contract used by scope
operations, mapped subflow inputs and emitted events:

- A string supplies the text, including an empty string.
- `null` deliberately excludes that entry.
- `undefined` evaluates the caller's default template, exactly once.

Handlers invoke custom methods on the original formatter object before asking
this rule to resolve the result. Their context construction, eager value
summaries, buffering, ordering, counters, metadata and storage remain unchanged.
Default templates stay lazy; exclusion must never trigger a fallback.

This module is not a public package export. The public contract remains
`NarrativeFormatter` in `narrativeTypes.ts`.
