/**
 * runAddress.ts — where a frame with a run id writes: the engine's run namespace (C2, a leaf of its own since C4, L4).
 *
 * The record layer never names a namespace: it takes the write ADDRESS as data, a path prefix
 * (`RecordFrame · address`, `SharedMemory · getValue` / `setValue` / `updateValue`, the transaction
 * buffer's `address`). The ENGINE decides it, from the one constant here: a frame with run id `c0`
 * (a fork or selector child takes its own id at the top level) reads and writes at `runs/c0/…`, a
 * frame without one at the root.
 *
 * WHY A LEAF. Two L4 files read the namespace and one imports the other: the frame
 * (`StageContext`, which builds every address) and the redaction verdict (`redaction.ts` — a
 * subflow mapper reading the namespace root reads every namespaced key; the mirror's seed scrubs
 * every namespace). Until C4 the constant sat in `StageContext.ts` and the verdict, then an L2 file,
 * spelled the namespace itself. This file imports nothing; `test/architecture/write-address.test.ts`
 * pins it as the one spelling in the record's reach.
 */

/** The key run namespaces sit under — the engine's one spelling of it. */
export const RUN_NAMESPACE = 'runs';

/** The root's address, shared by every frame without a run id (most of them). Never edited. */
const ROOT_ADDRESS: readonly string[] = Object.freeze([]);

/** Where a frame with run id `runId` reads and writes: `['runs', <id>]`, or `[]` (the root) with none. */
export function runAddress(runId: string): readonly string[] {
  return runId ? [RUN_NAMESPACE, runId] : ROOT_ADDRESS;
}
