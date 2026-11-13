# Subflow output handoff

A subflow writes its own log. Its `outputMapper` can read that child's state and write a differently named value into the parent. With `captureOutputHandoff: true`, the corresponding `SubflowResult.outputHandoff` records this boundary without putting child key names into the parent's `readKeys`. Capture is off by default.

Run the complete [subflow output handoff example](../../examples/post-execution/causal-chain/06-subflow-output-handoff.ts):

```bash
npx tsx --tsconfig examples/tsconfig.json examples/post-execution/causal-chain/06-subflow-output-handoff.ts
```

It copies the child's `txnId` into the parent's `receipt`. The parent deliberately has an unrelated key also named `txnId`: resolving the handoff's child key against that parent key would name the wrong writer.

## Capture contract

Enable the executor's `captureOutputHandoff: true` option before running. The engine observes root-key accesses to the child's output state while the mapper runs, and keeps the observed read prefix for each parent write that commits. Use it together with `writeProvenance: 'reads-prefix'` when child writes should also retain their own recorded read prefixes. The two dials are independent: existing users of write provenance do not acquire handoff metadata merely by upgrading.

With capture enabled, the mapper's child output is an observed view over a copy of the child's state. Normal property access and spreading work. To clone the view, use `structuredClone({ ...output })`; `structuredClone(output)` cannot clone the observed proxy. A retained child view remains readable after the mapper commits, but later accesses add no capture. The existing state, commit logs and scope-local `readKeys` keep their meanings.

Capture closes as soon as the merge-back commit lands, before `ScopeRecorder.onCommit` notifications. A commit observer's later reads cannot add references retroactively. A child-output read made by a getter during commit retention or cloning instead marks the handoff partial with `commit-time-read`: its timing does not establish a read before the staged parent write.

The optional field has this shape:

| Field | Meaning |
| --- | --- |
| `version: 1` | The handoff metadata version. |
| `attribution: 'observed-read-prefix'` | Recorded accesses before a write; no claim that each access caused that write. |
| `parent.address` | The exact parent log address: `logRunId` and `drillPath`. |
| `parent.runtimeStageId` | The mount invocation that committed the merge-back. |
| `parent.commitIdx` | The merge-back's array position in that parent's local commit log. |
| `child.address` | The exact child log address for this invocation. |
| `child.beforeCommitIdx` | Exclusive cutoff in the child's local history, taken before output mapping. |
| `writes[]` | Actual admitted parent write paths, each with a `reads` list of observed child root keys. |
| `status` | `captured` or `partial`. Even `captured` describes access-prefix observation, not semantic derivation. |
| `limitations[]` | Why the observation is partial; see below. |

For example, a mapper that returns `{ first: child.a, second: child.b }` can record both `a` and `b` for both parent writes: both reads happened before merge-back staged either write. Access to `child.profile.name` records the root key `profile`, not a proved dependency on one nested field. Closed-over data and untracked computation are not made explainable by this channel.

The field is absent when capture is off, without an output mapper, or when no merge-back write commits. A failed merge or a no-op does not acquire a handoff. Absence means no handoff evidence, not that the parent write had no dependencies.

## Follow the boundary explicitly

1. Find the parent write in its own log. Use its exact mount `runtimeStageId` to select the matching result from `snapshot.subflowResults`; a reusable subflow name or its latest-result alias does not identify one visit.
2. Match `parent.address`, `parent.runtimeStageId` and `parent.commitIdx` to the parent recording and merge-back. Match `child.address` to the selected child's `treeContext.logAddress`.
3. For the desired parent write path, inspect its observed child keys. Query those keys in the child's `treeContext.history`, using `child.beforeCommitIdx` as the exclusive cutoff. For example, Foottrace's `findLastWriter(childHistory, key, cutoff)` resolves a local recorded writer.
4. Keep the result's attribution and limitations visible. An unresolved local writer remains unknown; do not substitute a same-named parent key or infer an earlier input source.

Current Foottrace `causalChain` and `sliceForKey` queries remain scope-local. They do not automatically traverse `outputHandoff`; the reader must load/select the exact child record and ask the child question separately. Grouping the logs into one array changes their addresses and cutoffs and is not a supported substitute.

## Partial observations

| Limitation | Reader behavior |
| --- | --- |
| `privacy-active` | An active redaction rule withholds child read-key references for the entire handoff, not just individually matched names. A redacted export likewise withholds previously captured references. Empty `reads` lists do not establish independence. |
| `explicit-output` | The child returned a non-null explicit output rather than exposing its state. Its property names cannot be treated as recorded child state keys. |
| `output-mutated` | The mapper changed the observed output view. The remaining references do not establish complete attribution. |
| `commit-time-read` | A child-output read occurred while the commit retained or cloned values, for example through a getter. Keep the local boundary instead of following child references from this partial handoff. |
| `budget-exhausted` | Some observation was omitted. Do not complete the missing prefix or choose a substitute source. |

The access-prefix allowance is 4,096 items and 64 × 1,024 key characters, counting observed keys and saved prefix copies together. The staged-write allowance is 256 distinct paths and 64 × 1,024 path characters. These are bounded capture allowances, not an unbounded list of everything the mapper did. A partial result supports a local-boundary fallback and inspection of the stated gap; it does not authorize a definite cross-scope cause.

This metadata is retained with the native in-memory result and its snapshot. It adds no crash-safe sink entry, storage receipt or claim that an external operation succeeded. Saving or exporting other evidence does not give this channel durable capture authority.
