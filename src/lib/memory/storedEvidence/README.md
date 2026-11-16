# Native run-evidence collection

This internal owner keeps value-free facts supplied at the native execution seams.
It does not walk an execution tree, classify a diagnostic, reconstruct a decision,
copy a record writer or infer collection from an adapter's contents.

The native constructor owner first calls `registerLogEvidence` with the fixed
declaration it actually passed to the real writer. It cannot be relabelled on resume.
`registerEvidence` binds a frame to that evidence-enabled EventLog through a weak key.
An inactive or unknown log creates no binding and the frame gains no own properties.
Disabling reads in a later leg of a keys-declaring log makes that execution's annotation
unavailable. When a first commit arrives without that annotation, the reader marks
its reads partial; a missing first commit is handled by the published reader described below.
An off-declaring log never
claims new read facts.
`beginEvidence` starts one native execution; `recordEvidenceRead` encodes its actual
path/key with Foottrace's public codec and deduplicates at most the writer's read cap.
It never uses snapshot labels or an inferred first-read flag. If another distinct
name exceeds that cap, the whole annotation is unavailable. `noteEvidenceStage` is
the shared once-only owner for mount/no-function entry and collector refusal; every
producer must call it instead of writing a separate `run.stage` note. It keeps the
real native id/parent/resumes without fabricating a commit. If a first commit arrives
without `about`, the stored read channel is partial. The published Foottrace 2.0.0-rc.0 minimum also marks missing first-commit annotations
partial when an entered execution never commits. The older 1.x constructor/reader
failures remain in the regression evidence; neither is bypassed by this collector. No exact omitted-name count is invented. An attempt discard drops
those names, not the execution identity. `takeEvidenceAbout` yields a candidate
first-commit annotation at most once.

Descriptions are offered only on the first **entered** execution of a stage in a log,
not retried after a transport loss. The registry holds at most 1,024 stage names, each
within the writer's text limit; later descriptions stay absent. Description text is
bounded by the writer's description limit before retention. The caller must already
have served author text under the current run rule. Absence never invents a description.

Foottrace owns bounds, annotation admission, manifest/version, note sequencing,
loss accounting, sink copies and stored reading. This owner only calls that public
writer. Names and fixed attention marks contain no values. It never examines an
exception, scope Proxy, observer or caller object to rediscover native ownership.

Adjacent tests exercise the real writer and stored reader, inactive/disabled reads,
integer-name order, canonical dotted-name separation, honest over-cap refusal, retry discard, first-commit behavior and
description lifetime. Adjacent engine tests cover actual constructor/read/commit
seams, decisions, zero selection, stops, subflows, retries and resume. The crash
probe kills a separate process inside a mount after flushing its prefix. The
uncommitted leaf stays unknown, and a missing first annotation stays partial.

The native entry seam supplies ids before observers, and source owners pass the
same served decision/pause/break/error forms to notes and live events. Failure
notes copy only named safe error fields. Continuation bundles never carry `about`,
including a returned mount that reuses an already-committed frame; its real entry
is retained without inventing an own commit or a parent edge.
