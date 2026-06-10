# Design note — Commits record CHANGES, not writes

> Status: shipped. Audience: library maintainers + downstream recorder authors.
> Related code: [`TransactionBuffer.commit`](../../src/lib/memory/TransactionBuffer.ts),
> [`deepEqual`](../../src/lib/memory/utils.ts).

## The one-line rule

A stage's **commit bundle is its net state delta** — the set of paths whose
final value differs from the value the stage started with. A write that nets to
no change (a no-op write, or a write-then-revert) **does not appear in the
commit**, even though the write itself happened.

## Why this exists

Before this change, `TransactionBuffer` recorded every `set`/`merge` verbatim, so
the commit bundle was a log of **operations**, not **changes**. Two patterns
produce no net change yet were committed as "mutations":

| Pattern | Example | Net change |
|---|---|---|
| No-op write | base `K=1`, stage writes `K=1` | none |
| Write-then-revert | base `K=1`, stage writes `K=2` then `K=1` | none |

The no-op write is not hypothetical: an agent context slot that re-emits the
same system prompt / tools / messages every turn writes identical content each
iteration. Recording that as a mutation:

1. **Bloated causal slicing.** `causalChain` / `findLastWriter` walk the commit
   trace to find which stage a value depends on. Spurious intermediate writes
   (the `K=2` that got reverted) showed up as false dependencies.
2. **Lit up downstream "what changed?" consumers.** The lens highlight reads the
   commit patch to decide which stages to emphasise; every slot lit every turn
   because every slot "wrote", even when nothing changed.

The brand is explainability. The substrate must be truthful: the commit log
should answer *"what did this stage change?"*, not *"what did this stage type?"*.

## How it works

At commit time the buffer holds both `baseSnapshot` (state when the stage began —
captured lazily at the stage's *first write* since #13, which is identical to
stage-entry state because stage writes only reach SharedMemory at commit) and
`workingCopy` (state after all its writes). For each touched path it keeps
the path **only if** `deepEqual(before, after)` is false. Surviving `set` paths
copy their final value from `overwritePatch`; surviving `merge` paths copy their
accumulated delta from `updatePatch` — so the `set`/`merge` verb is preserved and
replay (`applySmartMerge`) is byte-identical to recording only the real changes.

This is a **single net-delta diff at commit**, one deep compare per touched path,
O(changed state), paid once per stage. The rejected alternative — a per-write
deep-equal skip — is more expensive (runs on every write) **and** misses
write-then-revert (the intermediate write differs from the value present at the
instant it is written, so a per-write check records it).

## Two honest tiers — do NOT unify them

| Signal | Level | Records a no-op / revert? | Feeds |
|---|---|---|---|
| **commit patch** (`overwrite`/`updates`/`trace`) | change-level | no | commit log, causal chain, narrative, lens highlight |
| **`onWrite` event** / `writeCount` | op-level | yes | metrics, behavioural observability |

`onWrite` deliberately stays op-level: a debugger *wants* to see "wrote 2, then
reverted to 1" — that is real behaviour. Only the **committed change** is the net
delta. These are two different questions ("what did it do?" vs "what changed?")
and must not be collapsed into one.

## Empty commits are intentional (and load-bearing)

A stage that nets no change commits an **empty patch — not nothing**.
`StageContext.commit()` records the bundle **unconditionally**, so every executed
stage keeps its `runtimeStageId` marker and stays a time-travel cursor stop. Only
its patch is empty. (Since #13, a stage that never *wrote* records that same
empty bundle through a zero-clone fast path — no buffer is ever constructed —
with identical commit-log output.)

This is the property that makes the change safe for the commit-indexed time
machine: the **number and order of commits is unchanged** (one per stage, as
before), so the lens slider / `buildCommitSyncMap` indices are untouched. We
made the *contents* truthful without disturbing the *cursor*.

Downstream "did this stage change anything?" is therefore a one-liner:
`bundle.trace.length > 0` (equivalently, a non-empty `overwrite`/`updates`).

## Known limitations / future work

- **Key deletion** is still unrepresentable in `MemoryPatch`. Setting a key to
  `undefined` is treated as a *change* (value differs from base), not a deletion.
  A future `delete` verb would close this.
- **Array-merge dedup** in `deepSmartMerge` still uses reference equality
  (`new Set([...dst, ...src])`), so deep-equal *objects* in a merged array are
  not deduped. Orthogonal to this change; tracked separately.
- **Cyclic values** are out of contract for `deepEqual` exactly as they are for
  checkpoint serialisation (state must be JSON-shaped). Dev mode flags cycles at
  write time.
- **Pluggable performance primitives (bring-your-own).** `deepEqual` (and other
  hot-path primitives like `deepSmartMerge` / the `structuredClone` calls) are
  internal today. A future opt-in could let a consumer inject their own
  implementation — e.g. a SIMD/fast-deep-equal, a schema-aware comparator, or a
  structural-sharing clone — for extreme-throughput workloads, while everyone
  else keeps the zero-config built-in. Caveats to design for: (1) a BYO
  comparator MUST honour the structural-equality contract or commits could
  silently drop real changes (data loss) — so it needs a documented contract +
  dev-mode validation; (2) exposing internals widens the public API, so this is
  deliberately deferred until post-adoption. Tracked in the README roadmap as a
  community-friendly extension point.
