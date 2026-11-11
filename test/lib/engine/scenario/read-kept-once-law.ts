/**
 * The read-kept-once law — the named record change for a stage that edits IN PLACE a value it only read
 * (out of contract; `memory/keptReads.ts`).
 *
 * An engine up to 11.2.0 retained a read at every read. So when a stage read a key, changed the value in
 * place, and read the key again, `stageReads` held the value WITH the stage's own edit, as if the state
 * had held it. This build retains a read once for each object a key holds. What moves, and only for
 * such a stage:
 *
 *   1. `stageReads[key]` holds what the key held in the state the stage BEGAN from, where the older
 *      engine holds that value with the in-place edits the stage made before its last read of the key;
 *   2. dev mode's in-place report (`warnOnBorrowedMutation`) holds that first copy against the value at
 *      commit, so it can report an edit the older engine missed because the key was read again after
 *      it. A report can only differ for a (stage, key) of point 1.
 *
 * A record written by an older engine has neither, and it is never regenerated (it exists to be old). So
 * a comparison takes the law's facts out of the build's record and compares every remaining byte. Each
 * fact is ASSERTED before it is taken out:
 *
 *   - from the record: the stage, the key, and that what the build kept is byte for byte what the
 *     build's own fold says the key held before the stage's commit;
 *   - from the program, when the caller knows it (`mayMove`): that this stage's last read of this key
 *     came after an in-place edit and before any write of the key. The record alone cannot say that,
 *     and without it a build that wrongly kept the first read of a key the stage then WROTE and read
 *     again would pass (the second reader of the change showed it). The comparisons that run generated
 *     programs pass it (`memory/property/borrowed-edits.ts`).
 *
 * Reports outside the law's (stage, key) pairs must be identical, in order. The reports ON those pairs
 * are handed back to the caller, which pins them where the programs are fixed (the corpus).
 *
 * The law is written for a LINE of stages: "the state the stage began from" is the fold before its own
 * commit, which is not so beside a parallel sibling. A tree with children is refused.
 *
 * The law is asked only when both engines committed the same log to the same state: a difference there
 * is another law's (the admitted record), proven by its own witness.
 *
 * It lives here, beside the other named record law (`mapper-reads-law.ts`), and not with the tests that
 * use it (`test/lib/memory/`): that folder is the record's, and a test there that does not load the
 * engine belongs to the record's own package (`scripts/record-tests.mjs`).
 */

type Json = Record<string, any>;
type Kept = Record<string, string>;

export interface KeptOnce {
  /** The build's record with the law's facts taken out; the input itself when the law moved nothing. */
  readonly build: Kept;
  /** The reads the law moved, as `stage key`, in the order they were made. */
  readonly moved: readonly string[];
  /** In-place reports the build makes on those reads, as `stage key`. */
  readonly reported: readonly string[];
  /** In-place reports the older engine made on those reads, as `stage key`. */
  readonly reportedBefore: readonly string[];
}

/** The steps of a tree in the order they ran (the borrowed charts are a line; a fork's children follow their parent). */
function steps(tree: unknown): Json[] {
  const out: Json[] = [];
  const stack: unknown[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop() as Json | undefined;
    if (node === null || typeof node !== 'object') continue;
    out.push(node);
    stack.push(node.next, ...[...((node.children as unknown[]) ?? [])].reverse());
  }
  return out;
}

const text = (value: unknown) => (value === undefined ? '«absent»' : JSON.stringify(value));
const parse = (kept: string, what: string): any => {
  const value = JSON.parse(kept);
  // Without an edit the re-serialised text IS the input, so the only bytes this can move are the law's.
  if (JSON.stringify(value) !== kept) throw new Error(`read-kept-once law: ${what} does not round-trip`);
  return value;
};

/** `stage key` of an in-place report, or '' for any other warning. */
function reportOf(warning: string): string {
  const match = /^\[footprint\] Stage "([^"]+)" changed `([^`.[]+)/.exec(warning);
  return match ? `${match[1]} ${match[2]}` : '';
}
const linesOf = (warnings: string | undefined) => (warnings ? warnings.split('\n') : []);

/**
 * Take the law's facts out of `build`, the record this build kept of a program, against `old`, the
 * older engine's record of the same program. Throws when a difference in what a stage read is not the
 * law's, when `mayMove` says the program gives that read no reason to move, or when a report differs
 * outside the reads the law moved.
 */
export function withoutKeptOnce(old: Kept, build: Kept, mayMove?: (stage: string, key: string) => boolean): KeptOnce {
  const untouched: KeptOnce = { build, moved: [], reported: [], reportedBefore: [] };
  if (old.executionTree === build.executionTree && old.warnings === build.warnings) return untouched;
  for (const field of ['commitLog', 'sharedState', 'folds'] as const) if (old[field] !== build[field]) return untouched;

  const log = parse(build.commitLog, 'the commit log') as Json[];
  const folds = build.folds.split('\n').map((fold, i) => parse(fold, `fold ${i}`) as Json);
  const oldTree = parse(old.executionTree, "the older engine's tree");
  const buildTree = parse(build.executionTree, "the build's tree");
  const oldSteps = steps(oldTree);
  const moved: string[] = [];
  steps(buildTree).forEach((step, at) => {
    const before = oldSteps[at];
    const where = `read-kept-once law at ${step.runtimeStageId}`;
    if (before?.runtimeStageId !== step.runtimeStageId) throw new Error(`${where}: the older tree has another step`);
    if ((step.children as unknown[] | undefined)?.length) throw new Error(`${where}: the law is for a line of stages`);
    const kept = (step.stageReads ?? {}) as Json;
    const keptBefore = (before.stageReads ?? {}) as Json;
    if (Object.keys(kept).join('\u0000') !== Object.keys(keptBefore).join('\u0000')) {
      throw new Error(`${where}: reads [${Object.keys(kept)}], the older engine [${Object.keys(keptBefore)}]`);
    }
    for (const key of Object.keys(kept)) {
      if (text(kept[key]) === text(keptBefore[key])) continue;
      // The state the stage began from: the fold up to the commit before its own.
      const commit = log.findIndex((bundle) => bundle.runtimeStageId === step.runtimeStageId);
      if (commit < 1) throw new Error(`${where}: no commit before the stage's own to read '${key}' from`);
      const began = folds[commit - 1][key];
      if (text(kept[key]) !== text(began)) {
        throw new Error(`${where}: '${key}' is kept as ${text(kept[key])}, the stage began with ${text(began)}`);
      }
      if (mayMove !== undefined && !mayMove(step.name, key)) {
        throw new Error(
          `${where}: '${key}' moved, and the program's last read of it does not follow an in-place edit of an unwritten key`,
        );
      }
      moved.push(`${step.name} ${key}`);
      kept[key] = keptBefore[key];
    }
  });

  // Reports: identical outside the reads the law moved; on them, handed back.
  const onMoved = (warning: string) => moved.includes(reportOf(warning));
  const now = linesOf(build.warnings);
  const then = linesOf(old.warnings);
  const rest = now.filter((warning) => !onMoved(warning));
  const restThen = then.filter((warning) => !onMoved(warning));
  if (rest.join('\n') !== restThen.join('\n')) {
    throw new Error(
      `read-kept-once law: a warning differs outside the reads it moved [${moved}]\n  older: ${restThen.join(
        ' | ',
      )}\n  build: ${rest.join(' | ')}`,
    );
  }
  if (moved.length === 0) {
    if (old.warnings !== build.warnings) throw new Error('read-kept-once law: warnings differ and no read moved');
    return untouched;
  }
  return {
    build: { ...build, executionTree: JSON.stringify(buildTree), warnings: old.warnings },
    moved,
    reported: now.filter(onMoved).map(reportOf),
    reportedBefore: then.filter(onMoved).map(reportOf),
  };
}
