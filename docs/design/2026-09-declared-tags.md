# Declared tags — a name on the stage, carried by its commit (design, 2026-09-10)

**Decision (owner, 2026-09-10):** build it as three additive packets — footprintjs first. This page is the
field-level design packet 1 implements; packets 2 and 3 are named at the end so nobody re-derives them.

**Status:** packet 1 implemented in footprintjs 9.21.0 (2026-09-10). Where the code's existing law overrode this
page: (a) the tag is RELEASED on commit like `untrackedSources`, so a double-commit path (fork child fan-out repeat,
mount exit bundle) records it once — the stop's FIRST bundle is where `tagStops` reads it; (b) `.tag()` also refuses
the `_cursorTail` mis-attribution case (after `addSubFlowChart` / `addListOfFunction`) the way `.retry()` does, plus a
duplicate name and a second declaration on one stage; a whitespace-only name counts as empty; (c) the resumed leg does
NOT re-stamp "from its chart" by itself — `FlowChartExecutor.resume`'s synthetic `innerResumeChain` node copies
`pausedNode.tags` on both re-entries; (d) `RuntimeStructureManager.stageNodeToStructure` also copies `tags`, so a
lazily-resolved node's Map advertises them. Packets 2 and 3 are unchanged.

**Status addendum (9.21.1, 2026-09-10):** packet 2 measured a gap in packet 1 — a subflow MOUNT had no tag site
(`SubflowMountOptions` carried no `tags`; no mount method called `applyTags`), so a consumer's slot mounts fell back to
id derivation inside an otherwise tagged recording, against law 3. Fixed at the one landing site:
`SubflowMountOptions.tags` → `applyTags` from all eight mount methods (eager/lazy × fork-child/linear/decider-branch/
selector-branch). The tag lands on the mount's FIRST bundle in the parent log (exit bundle: none); the subflow's own log
is untouched. `.tag()` after `addSubFlowChart` / `addSubFlowChartBranch` STILL refuses (the cursor stays on the parent
— a fork-child mount is one of N siblings, the same law `.retry()` keeps); the refusal now names the option. Untagged
mounts stay byte-identical (the 9.20.0 reference is unchanged).

## The question it answers

"Filter stops by tag and group the rest — is a tag commit-based or state-based?" Both exist, as different things,
and the split *is* the design. Three marks look alike because they end in one operation ("keep these stops, fold the
rest into them" — `axis.ts · filterStops`, shipped in 9.18.0). They differ in who puts the mark and when:

| Mark | Who, when | Lives | Example |
|---|---|---|---|
| **Declared tag** | the author, at build time | the Map (spec node) → stamped into the Trace (commit bundle) | `'milestone:llm-turn'` |
| **Derived tag** | the reader, at read time, from the fold | computed by a strategy; never stored | "the current skill changed here" |
| **Bookmark** | the reader, at read time, by choice | on the cursor (`mark`/`marks`); persisted beside a recording, never in it | "come back here" |

Only the first is missing from the record. This page adds it and nothing else.

## Laws

1. **A tag is a NAME declared at build time; a value is never a tag.** No run-time `scope.$tag()`: a runtime string can
   carry a value (`'user:' + email`) and none of the redaction enforcement points would see it. Data-dependent marks
   are derived tags (read side) or telemetry (`$emit`) — never the log.
2. **Absent when empty.** An untagged chart's log, snapshot, checkpoint and every recorder output are byte-identical
   to 9.20.0. (The same law `CommitBundle.untrackedSources?` keeps.)
3. **The tag is the fact; a derivation is the fallback.** A consumer that classified stops from ids (agentfootprint's
   `milestoneFor`) reads `bundle.tags` first and derives only for recordings made before tags existed.
4. **Free strings in the substrate.** footprintjs owns no domain vocabulary; a consumer declares its own
   (`'milestone:<kind>'`). Any-of / all-of is the keep rule's choice; `meta` carries the full array.
5. **Attribution by precedence.** Untagged stages belong to the tagged stop BEFORE them (what `filterStops` does;
   what the milestone strategy already means by "iteration"). Not a per-tag flag.
6. **The Map advertises the vocabulary.** The spec node carries `tags` as-is (JSON-safe), so `StructureRecorder` /
   the contract can list the tags a chart CAN produce, and the Trace shows which a run DID hit. A lens draws its
   legend before the run exists.

## Fields and sites (packet 1, footprintjs)

- `builder/types.ts` · stage options gain `tags?: readonly string[]` beside `retry`; `FlowChartBuilder.ts` gains a
  `.tag(...names)` cursor modifier and ONE landing site `applyTags(node, spec, tags, where)` — the twin of
  `applyRetryPolicy`, called from every `options.tags` site and the modifier. Refusals: empty string, non-string,
  the branch-segment marker `~` inside a name (the grammar's reserved byte) — thrown at build time.
- `engine/graph/StageNode.ts` · `StageNode.tags?: readonly string[]` — a POLICY-like field, not a kind: no
  `computeNodeType` edit, no type-union sites. Both prefixer twins spread `{ ...node }`, so the field rides subflow
  prefixing untouched (`branch-segment-prefixer-equivalence.test.ts` must stay green).
- Spec node (`builder/structure`): `tags` copied as-is; `StructureRecorder` sees it on `onNodeAdded`-shaped events
  unchanged in shape (a new optional key on the node payload).
- `memory/types.ts` · `CommitBundle.tags?: readonly string[]`, absent when empty.
- Stamp: `FlowchartTraverser.ts · executeNodeStep` sets `context.tags = node.tags` where it sets `runtimeStageId`;
  `StageContext.ts · commit` spreads a `tagsFragment()` beside `untrackedSourcesFragment()` on BOTH commit paths
  (the zero-buffer fast path included — an empty commit is a deliberate stop). NOT inherited by `createNext` /
  `createChild` (per-node identity; the four dials' triplication is untouched; `SubflowExecutor` needs nothing).
- Encoding/redaction/checkpoint/chain: the fragment is added after `toChangeOnlyPayload` / `toDeltaPayload`, so it
  is independent of `commitValues`; redaction never sees it (names); the checkpoint carries no commit log, so nothing
  must survive it — the resumed leg re-stamps from its chart; chains get tags per leg for free; the error path commits
  before rethrow, so a failed stage keeps its tag; `interrupt()` re-runs the stage → two tagged stops on a chain (true).
- Reader: `time-travel/tagStops.ts` · `tagStops(tags?: readonly string[]): TimeTravelStrategy<readonly string[]>` =
  `filterStops(commitStops(log, tree), s => keep when log[s.commitIdx].tags ∩ tags ≠ ∅ (all tagged stops when tags is
  omitted), meta = bundle.tags)`. Exported from `/trace` beside `commitStops` and `filterStops`. Stored `unknown[]`
  rows: `bundles.ts · bundleRefusal` already tolerates the field.

## Tests packet 1 must carry (red before)

byte-identical log/snapshot/checkpoint for an untagged chart (both encodings; reference generated on 9.20.0 the way
`redaction-no-policy-byte-identity.test.ts` does it) · a tag on an empty commit · retry: one stamp regardless of
attempts · fork children: each child's bundle carries its own tag · subflow: the prefixed node keeps the tag and the
subflow's own log carries it · chain `[paused, resumed]`: per-leg · `interrupt()`: two tagged stops · `~` in a name
refused at build · stored row with `tags` accepted by `bundleRefusal` · `tagStops`: keep-by-any-of, absorption before,
`prologue` on an absorbing start, `meta` = the array, `stateAt` at every kept stop equals `commitStops`'s at the same
commit (the equivalence law) · the Map lists the vocabulary (StructureRecorder sees `tags` on the spec node).

## Docs packet 1 must carry

`src/lib/time-travel/README.md` section "Declared vs derived tags" with the laws above and TWO examples: a tagged chart
scrubbed by `tagStops`, then the same axis by a write-set predicate over `log[stop.commitIdx].trace` (a derived tag,
no new API); builder README/JSDoc for `.tag()` and `options.tags`; CHANGELOG [9.21.0] WHY (a stored recording from any
chart carries its own milestones without a consumer's id conventions; no `#`/`/` parsing) + example; CLAUDE.md
extension-points line for `tags` beside `retry`.

## Packets 2 and 3 (not this page's code)

2. **agentfootprint:** declare `'milestone:<kind>'` from the `milestoneFor` table at each stage's declaration site;
   `milestoneStops` reads `bundle.tags` first, `milestoneFor(id)` as fallback; extend
   `milestone-stops-equivalence.test.ts` to pin tag-axis == id-axis on every fixture (this is also the forgotten-tag
   catch); the derived example (`keyedFold` keep: skill changed / tool added) with its measured cost.
3. **agentfootprint-lens:** a tag picker over `tagStops` only if wanted; bookmarks persisted beside the recording
   (sidecar keyed by runId + runtimeStageId), never in it.

## Rejected

Run-time `$tag()` (redaction hole; 4-file `$`-method checklist); `$emit` as the carrier (never reaches the commit
log); a derived-tag TYPE (a keep rule over the fold is already the API; a full `stateAt` per candidate stop is
quadratic — 323 ms per fold on 1,719 commits measured in agentfootprint); bookmarks in the log (a reader could rewrite
the run's facts); a per-tag attribution flag (law 5).
