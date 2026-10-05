# Narrative text formatting

Internal, stateless formatting rules shared by narrative event handlers. This
module does not collect events, own a store, or walk an execution tree.

`sentences.ts` owns the English bodies shared by the combined and flow-only
views: ordinary next-stage and loop text, non-evidence decisions, forks,
validation details and errors, and stop/pause/resume text. Prefixes, first-stage
and revisit wording, selection, subflow, retry and evidence variants stay with
the recorder that owns those differences.

Error bodies and validation suffixes are separate helpers. The flow-only view
includes a suffix for any nonempty issue array (even a sparse array whose joined
details are empty); Combined includes it only for truthy detail text. These
existing decisions, and the order of error-text coercion, stay at the boundary.

The five former ordinary-loop templates now call `loopSentence`. Strategies
still decide **when** to call it: Separate records immediately; Windowed reads
its retained event objects on export; RLE formats single-pass groups on export
and retains its existing endpoint-based count and first description. Adaptive,
Milestone and Progressive still delegate accepted events to the base recorder.
No strategy is merged, and no buffering, flush point, index or snapshot policy
changes. These are formatting helpers, not an event registry or recorder base.

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
