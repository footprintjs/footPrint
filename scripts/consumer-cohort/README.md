# Nonpublishing source-cohort checks

This optional development check tests the SAME seven required consumer contexts on immutable
owner-authored migration branches before an engine RC can be published from main. No source-cohort
plan is shipped here. Without the optional `consumer-cohort.json` plan under the scripts directory, the ordinary audit is unchanged.
An incomplete or invalid plan fails; there is no fallback to ordinary green-on-own-failure rules.

The flowchart runs the already-installed, lock-pinned `footprintjs-baseline` 9.28.0, independent of
the candidate engine. `plan/` admits closed data. `pack/` builds a finite recipe table once in the
existing pack job. `workspace/` materializes strict candidates before the first install. `bytes/`
checks source/archive/physical-file joins. `audit/` runs the original family commands in order.
Each folder owns its tests. There is no cross-repo artifact download, token, new publisher, promoted
version-set file, timer, new check context, peer waiver or merge/release operation.

The data schema is `{schema:1, engineVersion, consumers, packages, registry}`. Every consumer has
`{package,pr,head,siblings:[]}`; configured source-only siblings have `{package,pr,head}`. Source
package rows have `{package,pr,head,version}` and must use a closed recipe. Registry rows have
`{package,version,integrity}`; Foottrace is mandatory. Exactly one PR/full-head tuple per fixed repo is admitted.
All required package versions/ranges come from actual owner source and checked registry bytes.
Unsupported recipes/aliases and missing transitive selections refuse rather than fabricate a graph.
No future consumer SHA, RC version or source ownership is invented by this support change.

Source event/head/base/actual checkout tree and plan hash are observed before npm scripts. The
same-run artifact contains those facts plus npm/member hashes. The upload's immutable artifact ID
and service ZIP digest are recorded AFTER upload, separately (a bundle cannot hash itself). Seven
jobs download that exact same-run ID and verify source/plan/run/archive/member joins before use.
This is reviewed workflow provenance, not cryptographic proof that arbitrary source compiled honestly.

All candidate setup/type/build/test commands must actually pass. Adopting support and adding a plan
creates a NEW feature-branch source head requiring fresh exact-head source/plan review and all normal
required gates. Green support-branch checks do not establish feature compatibility. Runtime/source findings are still repaired at their owner.
An actual on-main RC publication remains a separate authorized operator action through the existing
release route. This feature never publishes its audit-labelled copies or grants foreign review.

Additional independently installed workspace roots currently REFUSE until a concrete closed pairing
recipe is reviewed. They are never omitted from evidence. A recorded development pin alone does not
prove such a runtime graph; the actual install must be inspected.

Source archives carry immutable SOURCE origin, original manifest bytes/hash and a code-derived
strategy; an authored stable label does not claim the registry bytes with the same label. All RC
labels retain collision refusal. AgentFootprint alone may use its existing after-build RC version
stage; the original source manifest and every non-version field remain binding. This support does
not establish an actual AF15 producer or future published-version cohort.
