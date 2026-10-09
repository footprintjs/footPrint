/**
 * A record written through `footprintjs/write` — the classes the engine writes with (C5) — shaped like a
 * run, for the record's tests that need a record and not the engine (scripts/record-tests.mjs).
 *
 * `step(id, body)` is one stage of a flowchart: a `RecordFrame` at the run's root (or at `address`) whose
 * reads are TRACKED as a stage's are — noted on the frame (each row's `readKeys` under `'reads-prefix'`)
 * and kept for the execution tree (`stageReads`, by user-level key) — then committed as `<id>#<n>`, `n`
 * the run's execution counter, and released (what `StageContext · commit` does with its record half).
 * `snapshot()` is what a reader reads off a run: the log, its fold base, and the execution tree — one
 * node per step, `next`-linked, as a linear chart's.
 *
 * The same steps a chart's stages take give the same bytes (test/lib/memory/scenario/write-door-same-bytes
 * directly checks this helper): a stage that assigns `scope.k = v` is `s.set('k', v)`, one that reads `scope.k` is
 * `s.read('k')`, `$update` is `s.merge`, `$delete` is `s.delete`.
 *
 * @example
 * ```ts
 * const run = recordRun({ count: 0 }, { writeProvenance: 'reads-prefix' });
 * run.step('increment', (s) => s.set('count', (s.read('count') as number) + 1));
 * const { commitLog, initialState, executionTree } = run.snapshot();
 * ```
 */
import type { CommitBundle, CommitPhase, ExecutionTree, UntrackedSource } from '../../src/trace';
import type { RecordEncoding, WriteScrub } from '../../src/write';
import { EventLog, RecordFrame, SharedMemory } from '../../src/write';

/** One stage's view of its frame: tracked reads and the three verbs, at user-level paths. */
export interface StepScope {
  /** A tracked read of `key` (under `path`): served by the frame, noted for `readKeys`, kept as a stage read. */
  read(key: string, path?: string[]): unknown;
  set(key: string, value: unknown, scrub?: WriteScrub, path?: string[]): void;
  merge(key: string, value: unknown, scrub?: WriteScrub, path?: string[]): void;
  delete(key: string, path?: string[]): void;
  /** The frame itself, for what the three verbs do not reach. */
  readonly frame: RecordFrame;
}

export interface StepOptions {
  /** The bundle's `stage` (a chart stage's display name); default: the id. */
  name?: string;
  /** Where the frame reads and writes (`['runs', <id>]` for a fork child); default: the root. */
  address?: readonly string[];
  tags?: readonly string[];
  /**
   * A continuation of the last step with this id (`'exit'`: a mount's exit; `'repeat'`: a fork child's
   * settle): the same execution, so its runtimeStageId by default, no new tree node, no counter tick.
   */
  phase?: CommitPhase;
  untrackedSources?: ReadonlySet<UntrackedSource>;
  /**
   * The runtimeStageId; default `<id>#<n>`, `n` the run's execution counter, which every step but a
   * continuation advances. Give it when the chart numbers past a stage this run does not write (a
   * subflow's inner stages, on its own log).
   */
  runtimeStageId?: string;
}

export interface RecordRun {
  readonly state: SharedMemory;
  readonly log: EventLog;
  /** One stage: `body` reads and writes through the frame, then the frame commits and releases. */
  step(id: string, body?: (s: StepScope) => void, options?: StepOptions): CommitBundle;
  /** What a reader reads: the log (served), its fold base, and the linear execution tree. */
  snapshot(): { commitLog: CommitBundle[]; initialState: Record<string, unknown>; executionTree?: ExecutionTree };
}

/** A run seeded with `seed` (its `initialContext`), written under `encoding` (default: `'full'`, no read prefix). */
export function recordRun(seed: Record<string, unknown> = {}, encoding: Partial<RecordEncoding> = {}): RecordRun {
  const state = new SharedMemory(undefined, seed);
  const log = new EventLog(state.getState());
  const dials: RecordEncoding = { commitValues: 'full', writeProvenance: 'off', ...encoding };
  const nodes: ExecutionTree[] = [];
  const lastIdOf = new Map<string, string>();
  let counter = 0;

  const step: RecordRun['step'] = (id, body, options = {}) => {
    const frame = new RecordFrame(state, log, options.address ?? []);
    frame.useEncoding(dials);
    const stageReads: Record<string, unknown> = {};
    const at = (key: string, path: string[]) => frame.at(path, key);
    const scope: StepScope = {
      frame,
      read(key, path = []) {
        const value = frame.read(path, key);
        frame.noteRead(path, key);
        // Full read retention takes its copy WHEN read, before the caller can edit the borrowed value.
        stageReads[[...path, key].join('.')] = structuredClone(value);
        return value;
      },
      set: (key, value, scrub, path = []) => frame.write(at(key, path), value, 'set', scrub),
      merge: (key, value, scrub, path = []) => frame.write(at(key, path), value, 'merge', scrub),
      delete: (key, path = []) => frame.write(at(key, path), undefined, 'delete'),
    };
    body?.(scope);
    const continuation = options.phase !== undefined;
    const runtimeStageId =
      options.runtimeStageId ?? (continuation ? lastIdOf.get(id) : undefined) ?? `${id}#${counter}`;
    if (!continuation) {
      counter++;
      lastIdOf.set(id, runtimeStageId);
    }
    frame.commit(() => ({
      stage: options.name ?? id,
      stageId: id,
      runtimeStageId,
      untrackedSources: options.untrackedSources,
      tags: options.tags,
      phase: options.phase,
    }));
    frame.release();
    // As the engine's tree: a stage that read nothing carries no `stageReads`; a continuation is no new stage.
    if (!continuation) {
      nodes.push(Object.keys(stageReads).length > 0 ? { id, runtimeStageId, stageReads } : { id, runtimeStageId });
    }
    const list = log.list();
    return list[list.length - 1];
  };

  const snapshot: RecordRun['snapshot'] = () => {
    let executionTree: ExecutionTree | undefined;
    for (let i = nodes.length - 1; i >= 0; i--) {
      executionTree = executionTree ? { ...nodes[i], next: executionTree } : { ...nodes[i] };
    }
    return { commitLog: log.list(), initialState: log.getInitialState(), executionTree };
  };

  return { state, log, step, snapshot };
}
