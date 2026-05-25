# Proposal: Stage-id naming clarity — `splitStageId` helper + doc fixes

**Status:** v2 · pivoted from v1 per 3-panel review · helper-only, no event field additions
**Affects:** `src/lib/engine/runtimeStageId.ts` (new helper + doc rewrite), `src/lib/builder/structure/StructureRecorder.ts` (JSDoc clarification)
**Estimated change:** ~10 LOC added in footprintjs · zero LOC deleted in consumers · eliminates a named landmine

---

## Revision history

- **v1** proposed adding `localStageId`/`localFrom`/`localTo`/`localDecider`/`localBranchIds`/`localDefaultBranch` + `subflowPath?` mirror fields to 4 Structure events. 3-panel review:
  - Panel 1 (author): APPROVE_WITH_MINORS — but redundant on subflow-builder-attached recorders (prefixing happens at MOUNT time via `_prefixNodeTree`); export `splitStageId` regardless.
  - Panel 2 (consumer): APPROVE_WITH_MINORS — admitted "no actual bug, documented landmine we route around"; wouldn't adopt the fields; highest-value item is the doc fix.
  - Panel 3 (ergonomics): MAJOR_REVISIONS — cut field additions entirely; ship `splitStageId` + doc rewrite only.
- **v2 (this version)** ships the convergent answer: ONE helper + doc fixes. No event payload changes. Future-proof (applies uniformly to `CommitBundle.stageId`, spec `node.id`, any new stage-id-shaped field).

---

## What problem does this solve?

A consumer reads `parseRuntimeStageId(runtime).stageId` and compares it against `node.id` from a spec. They get a silent false negative for every subflow-nested stage. The collision: both fields are called `stageId` but mean different things.

- `parseRuntimeStageId('sf-tools/execute-tool-calls#8').stageId` → `'execute-tool-calls'` (LOCAL)
- `node.id` after mount → `'sf-tools/execute-tool-calls'` (FULL prefixed, set by `_prefixNodeTree`)
- `StructureStageAddedEvent.stageId` fires AT CONSTRUCTION (before mount) → LOCAL — but `event.spec.id` is a live reference that MAY be the prefixed form by the time a consumer reads it post-mount

The JSDoc on `StructureStageAddedEvent.stageId` actively misleads: it claims the field "matches the `stageId` used at runtime (without the `#N` execution suffix)" — true if you stitch `subflowPath + '/' + stageId` from the parsed output; false if you compare to the parsed `stageId` field directly.

## Why v1's field-additions approach was wrong

Panel 1 surfaced the load-bearing wrinkle: **prefixing happens at MOUNT time**, not at construction. Events fire at construction with LOCAL ids. The events themselves don't carry the asymmetry. The asymmetry lives in:
- `spec.id` post-mount (rewritten by `_prefixNodeTree`)
- `CommitBundle.stageId` (records the post-mount id)
- `runtimeStageId` (built from the post-mount id)

Adding `localStageId` to Structure events would be redundant on subflow-builder-attached recorders (`localStageId === stageId`) and only meaningful at the point a consumer compares two ALREADY-prefixed identifiers — which is exactly where a helper is the right tool.

## Proposed solution

### A. Export `splitStageId` helper from `footprintjs/trace`

```ts
// src/lib/engine/runtimeStageId.ts

/**
 * Decompose a (possibly prefixed) stage id into its components.
 *
 * Use this when you have an id WITHOUT the `#N` execution suffix and
 * need to know the local stage name and/or the subflow path. Common
 * sources of such ids:
 *   - `spec.id` (post-mount the id includes any subflow prefix)
 *   - `CommitBundle.stageId` (same — post-mount id)
 *   - `node.id` from xyflow nodes built off the spec
 *   - the segment of `runtimeStageId` BEFORE the `#` (use
 *     `parseRuntimeStageId` directly for full runtimeStageId strings)
 *
 * @example
 * splitStageId('sf-tools/execute-tool-calls')
 * // → { localStageId: 'execute-tool-calls', subflowPath: 'sf-tools' }
 *
 * splitStageId('execute-tool-calls')
 * // → { localStageId: 'execute-tool-calls', subflowPath: undefined }
 *
 * splitStageId('sf-outer/sf-inner/validate')
 * // → { localStageId: 'validate', subflowPath: 'sf-outer/sf-inner' }
 */
export function splitStageId(prefixedStageId: string): {
  localStageId: string;
  subflowPath: string | undefined;
} {
  const lastSlash = prefixedStageId.lastIndexOf('/');
  if (lastSlash === -1) {
    return { localStageId: prefixedStageId, subflowPath: undefined };
  }
  return {
    localStageId: prefixedStageId.slice(lastSlash + 1),
    subflowPath: prefixedStageId.slice(0, lastSlash),
  };
}
```

### B. Rewrite `parseRuntimeStageId` JSDoc — name the landmine

Current docstring is accurate about format but doesn't warn about the `stageId` field-name collision with `spec.id`. Add an explicit note:

```ts
/**
 * Parse a runtimeStageId into its components.
 *
 * IMPORTANT — naming collision: the returned `stageId` is the LOCAL
 * form (the segment between the last '/' and the '#'). This is NOT
 * the same as `spec.id` or `node.id` for subflow-nested stages,
 * which contain the FULL prefixed form.
 *
 *   parseRuntimeStageId('sf-tools/execute-tool-calls#8').stageId
 *   // → 'execute-tool-calls'   (LOCAL)
 *
 *   node.id  // (post-mount, in a spec that contains subflows)
 *   // → 'sf-tools/execute-tool-calls'   (FULL prefixed)
 *
 * To compare these two safely, use `splitStageId(node.id)` to get
 * the local form, OR reconstruct the full form via
 * `(subflowPath ? subflowPath + '/' : '') + stageId`.
 */
export function parseRuntimeStageId(runtimeStageId: string): { ... }
```

### C. Add the same warning to `StructureStageAddedEvent.stageId` JSDoc

The current JSDoc claim ("matches the `stageId` used at runtime (without the `#N` execution suffix)") is misleading when stages live in subflows. Replace with:

```ts
/**
 * Stable identifier for this node. AT EVENT FIRE TIME this is the
 * builder's LOCAL form (no subflow prefix — the prefix is applied
 * later by `_prefixNodeTree` when this builder is mounted as a
 * subflow into a parent).
 *
 * Note: `spec.id` is a LIVE reference. If you read it AFTER the chart
 * has been mounted as a subflow, it may have been rewritten to the
 * FULL prefixed form. Use `splitStageId(spec.id)` to decompose safely.
 *
 * To correlate with runtime events:
 *   - same builder (no mount) → `event.stageId === parseRuntimeStageId(runtime).stageId`
 *   - this builder mounted as subflow → use `splitStageId` on the
 *     prefixed form (or `parseRuntimeStageId` on the full runtimeStageId)
 *     before comparing.
 */
readonly stageId: string;
```

Add similar one-liner notes to `from`/`to`/`decider`/`branchIds` fields on the other Structure events — but no payload changes.

## What this DOESN'T do (deliberately)

- ❌ Add `localStageId`/`subflowPath?` fields to Structure events (v1 approach — rejected by Panel 3, contradicted by Panel 1's mount-time-prefixing finding)
- ❌ Change `parseRuntimeStageId` output shape (breaking change)
- ❌ Change `runtimeStageId` format
- ❌ Add anything to `CommitBundle` (consumer reaches for `splitStageId(bundle.stageId)`)
- ❌ Rename any existing field

## Migration / compatibility

- `splitStageId` is a new export under `footprintjs/trace`. Zero impact on existing code.
- JSDoc clarifications are pure documentation — no runtime behavior change.
- Consumers feature-detect via `typeof splitStageId === 'function'` for the rare dual-version case.

## Required tests before merge

1. **Unit**: `splitStageId('local')` → `{ localStageId: 'local', subflowPath: undefined }`
2. **Unit**: `splitStageId('sf/stage')` → `{ localStageId: 'stage', subflowPath: 'sf' }`
3. **Unit**: `splitStageId('sf-outer/sf-inner/stage')` → `{ localStageId: 'stage', subflowPath: 'sf-outer/sf-inner' }`
4. **Unit**: round-trip — `parseRuntimeStageId(runtime).stageId === splitStageId(runtime.split('#')[0]).localStageId` for every chart shape
5. **Unit**: round-trip — `parseRuntimeStageId(runtime).subflowPath === splitStageId(runtime.split('#')[0]).subflowPath`
6. **Property**: for any chart with N levels of subflow nesting, `splitStageId(spec.id)` returns the same `(localStageId, subflowPath)` pair as `parseRuntimeStageId(buildRuntimeStageId(spec.id, 0))` does

## Naming (LOCKED)

- Helper: `splitStageId` (verb-noun, matches `parseRuntimeStageId` and `buildRuntimeStageId` in the same file)
- Return field: `localStageId` (matches existing `parseRuntimeStageId.stageId` semantics; "local" is the natural antonym to "prefixed")
- Return field: `subflowPath` (matches existing `parseRuntimeStageId.subflowPath` and `traversalContext.subflowPath`)
