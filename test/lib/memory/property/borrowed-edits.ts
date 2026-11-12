/**
 * Which reads of a BORROWED program the read-kept-once law may move (`engine/scenario/read-kept-once-law.ts`),
 * said from the PROGRAM, not from either engine's record.
 *
 * WHY. The law accepts a differing read when what the build kept equals what the key held before the
 * stage's commit. Alone, that also accepts a WRONG build: one that keeps the first read of a key the
 * stage then wrote and read again (found by the second reader of the change). The program knows better.
 * A read may move only when the stage's LAST read of the key came after it had edited the value in
 * place and before it wrote the key: then the older engine kept the value with the edit, and this build
 * keeps what the state held. If the stage wrote the key before its last read, both engines keep what
 * that last read saw, and a difference is a fault.
 *
 * What each op of the fixture does to its key, in order (`copy-on-write-fixture.ts · applyBorrowedOp`):
 *
 *   read        reads
 *   mutGet      reads, then edits in place
 *   mutIter     reads (twice), then edits each element in place
 *   writeBack   reads, edits in place, then writes the same object back
 *   push        reads, then writes
 *   set/update  writes
 */
import type { BorrowedProgram } from './copy-on-write-fixture.js';

const READS = new Set(['read', 'mutGet', 'mutIter', 'writeBack', 'push']);
const EDITS = new Set(['mutGet', 'mutIter', 'writeBack']);
const WRITES = new Set(['set', 'update', 'push', 'writeBack']);

/** `(stage, key)`: may the law move what stage `S<i>` is said to have read of `key`? */
export function mayMoveIn(program: BorrowedProgram): (stage: string, key: string) => boolean {
  const allowed = new Set<string>();
  program.stages.forEach((stage, index) => {
    const edited = new Set<string>();
    const written = new Set<string>();
    const lastReadMoves = new Map<string, boolean>();
    for (const op of stage.ops) {
      // Within one op: its read comes first, then its edit, then its write.
      if (READS.has(op.t)) lastReadMoves.set(op.k, edited.has(op.k) && !written.has(op.k));
      if (EDITS.has(op.t) && !written.has(op.k)) edited.add(op.k);
      if (WRITES.has(op.t)) written.add(op.k);
    }
    for (const [key, moves] of lastReadMoves) if (moves) allowed.add(`S${index} ${key}`);
  });
  return (stage, key) => allowed.has(`${stage} ${key}`);
}
