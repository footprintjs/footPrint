/**
 * Property — nothing outside the record holds a container of the record (F3, 9.33.0).
 *
 * WHY: since F3 every bundle is deep-frozen at `EventLog · record`. That is safe ONLY if no object reachable
 * from a bundle is also reachable from somewhere the engine or a stage writes: a shared container would turn
 * into a frozen object under live state (a `TypeError` in the next stage), under a recorder's payload or under
 * a stage's own read. The plan wrote this property for F4b (which removes `redactPatch`'s clones); F3 is where
 * sharing would first become fatal, so it lands here and F4b re-runs it.
 *
 * WHAT: real runs of the copy-on-write fixture's chart programs — a subflow (object seed, object merge-back,
 * array merge either way), fork children, a redaction policy, initial context, every `readTracking` /
 * `writeTracking` / `writeProvenance` / `commitValues` dial — and the identity set of every object reachable
 * from every bundle ANY EventLog recorded (the run's and each subflow's: overwrite, updates, the trace and its
 * rows, `readKeys`, `redactedPaths`, `tags`, `untrackedSources`). None of them may be reachable from:
 *   live `sharedState`, the redacted mirror, `initialState`, the execution tree (stageWrites / stageReads
 *   retention), `subflowResults` (both views, their `history` aside — that IS the log), the recorder snapshots,
 *   any recorder hook payload, or what a stage reads (`$getValue` of every key at the start and the end of
 *   every stage).
 * A positive control proves the detector sees a shared object when there is one.
 *
 * F4b (9.33.0) removed `redactPatch`'s two whole-patch clones: the log now records the transaction buffer's
 * commit-time payload ITSELF (no policy) or a spine copy of it (a scrubbed path), and `nextGeneration` reads
 * that same payload. So the property now runs EVERY program twice — redaction policy ON and OFF — and adds the
 * consequence it guards: nothing a stage can reach (live `sharedState`, its own `$getValue` reads) is frozen,
 * so an in-place edit can never meet the record's freeze as a `TypeError` in a later stage.
 */
import fc from 'fast-check';
import { EventLog } from 'foottrace/write';

import {
  type ChartOp,
  type ChartProgram,
  applyChartOp,
  BUILD,
  chartProgramArb,
  isObj,
  keepOffDates,
} from './copy-on-write-fixture';

const KEYS = ['a', 'b', 'list', 'obj', 'hist'];
const HOOKS = [
  'onRead', 'onWrite', 'onCommit', 'onError', 'onStageStart', 'onStageEnd', 'onPause', 'onResume', 'onStageExecuted',
  'onNext', 'onDecision', 'onFork', 'onSelected', 'onSubflowEntry', 'onSubflowExit', 'onSubflowRegistered', 'onLoop',
  'onBreak', 'onStageRetry', 'onRunStart', 'onRunEnd', 'onRunFailed', 'onEmit',
]; // prettier-ignore

/** Every object reachable from `v` (own enumerable keys, Map/Set members), with the first path that reached it. */
function reach(v: unknown, label: string, skip?: (key: string) => boolean): Map<object, string> {
  const out = new Map<object, string>();
  const stack: Array<[unknown, string]> = [[v, label]];
  while (stack.length > 0) {
    const [x, path] = stack.pop()!;
    if (x === null || typeof x !== 'object' || out.has(x)) continue;
    out.set(x, path);
    if (x instanceof Map) for (const [k, val] of x) stack.push([k, `${path}<key>`], [val, `${path}<value>`]);
    else if (x instanceof Set) for (const m of x) stack.push([m, `${path}<member>`]);
    else
      for (const k of Object.keys(x)) if (!skip?.(k)) stack.push([(x as Record<string, unknown>)[k], `${path}.${k}`]);
  }
  return out;
}

/** The fixture's chart, with every stage reading every key raw at its start and its end. */
function buildChart(p: ChartProgram, errors: string[], reads: unknown[]) {
  const stageFn = (ops: ChartOp[]) => (s: any) => {
    for (const k of KEYS) reads.push(s.$getValue(k));
    for (const o of ops) applyChartOp(s, o, errors);
    for (const k of KEYS) reads.push(s.$getValue(k));
  };
  let b = BUILD.flowChart('Seed', stageFn(p.seed), 'seed');
  p.stages.forEach((ops, i) => {
    if (p.fork && p.fork.at === i) {
      b = b.addListOfFunction(p.fork.children.map((c, j) => ({ id: `child-${j}`, name: `Child${j}`, fn: stageFn(c) })));
      b = b.addFunction('Join', stageFn([{ t: 'readAll' }]), 'join');
    }
    if (p.sub && p.sub.at === i) {
      const sub = p.sub;
      let inner = BUILD.flowChart('Inner0', stageFn(sub.inner[0]), 'inner-0');
      sub.inner.slice(1).forEach((ops, j) => {
        inner = inner.addFunction(`Inner${j + 1}`, stageFn(ops), `inner-${j + 1}`);
      });
      b = b.addSubFlowChart('sub', inner.build(), 'Sub', {
        inputMapper: (parent: any) =>
          sub.seedObj
            ? { obj: { x: 1, n: parent.b ?? 0 }, list: [1, 2], a: parent.a ?? 'none' }
            : { a: parent.a ?? 'none', list: [1] },
        outputMapper: (out: any, parent: any) =>
          keepOffDates(
            sub.mergeObj && (parent?.obj === undefined || isObj(parent.obj))
              ? { obj: { y: out.a ?? null, deep: { q: 1 } }, list: [7], hist: out.list ?? [] }
              : { b: out.obj ?? null, list: [8] },
            parent,
          ),
        ...(sub.arrayReplace ? { arrayMerge: 'replace' } : {}),
      });
    }
    b = b.addFunction(`Stage${i}`, stageFn(ops), `stage-${i}`);
  });
  return b.build();
}

/** Run one program; return every place a recorded object is reachable from outside the record. */
async function sharedWithTheRecord(
  p: ChartProgram,
  inject?: (recorded: any[], payloads: unknown[], reads: unknown[]) => void,
) {
  const frozen: string[] = [];
  const recorded: any[] = [];
  const realRecord = EventLog.prototype.record;
  EventLog.prototype.record = function (this: EventLog, bundle) {
    recorded.push(bundle);
    return realRecord.call(this, bundle);
  };
  try {
    const errors: string[] = [];
    const reads: unknown[] = [];
    const payloads: unknown[] = [];
    const recorder: Record<string, unknown> = { id: 'reachability' };
    for (const hook of HOOKS) recorder[hook] = (...args: unknown[]) => payloads.push(args);
    const executor = new BUILD.FlowChartExecutor(buildChart(p, errors, reads), {
      commitValues: p.cfg.commitValues,
      readTracking: p.cfg.readTracking,
      writeTracking: p.cfg.writeTracking,
      writeProvenance: p.cfg.writeProvenance,
      ...(p.cfg.initial ? { initialContext: { a: 'init', obj: { x: 0, nest: { q: [1, 2] } }, hist: [{ n: 1 }] } } : {}),
    });
    executor.attachCombinedRecorder(recorder);
    if (p.cfg.policy) executor.setRedactionPolicy({ keys: ['b'], fields: { obj: ['y'] } });
    try {
      await executor.run();
    } catch {
      /* what landed is in the log either way */
    }
    const snap = executor.getSnapshot();
    const redacted = p.cfg.policy ? executor.getSnapshot({ redact: true }) : undefined;
    inject?.(recorded, payloads, reads);

    const record = new Map<object, string>();
    recorded.forEach((bundle, i) => {
      for (const [o, path] of reach(bundle, `bundle[${i}]`)) if (!record.has(o)) record.set(o, path);
    });
    const notTheLog = (key: string) => key === 'history' || key === 'commitLog';
    const views: Array<[string, unknown]> = [
      ['sharedState', snap.sharedState],
      ['redactedState', redacted?.sharedState],
      ['initialState', snap.initialState],
      ['executionTree', snap.executionTree],
      ['subflowResults', snap.subflowResults],
      ['redactedSubflowResults', redacted?.subflowResults],
      ['recorders', snap.recorders],
      ['hookPayloads', payloads],
      ['stageReads', reads],
    ];
    const hits: string[] = [];
    for (const [label, view] of views) {
      for (const [o, path] of reach(view, label, notTheLog)) {
        const inRecord = record.get(o);
        if (inRecord !== undefined) hits.push(`${path} is ${inRecord}`);
      }
    }
    // What a stage can edit in place: nothing there may be frozen (a frozen object would be the record's).
    for (const [label, view] of [
      ['sharedState', snap.sharedState],
      ['stageReads', reads],
    ] as Array<[string, unknown]>) {
      for (const [o, path] of reach(view, label)) if (Object.isFrozen(o)) frozen.push(path);
    }
    return { hits, bundles: recorded.length, frozen };
  } finally {
    EventLog.prototype.record = realRecord;
  }
}

describe('no container of the record is reachable from outside it', () => {
  it('over real runs — subflow seed and merge-back, fork children, every dial; each program with redaction ON and OFF', async () => {
    await fc.assert(
      fc.asyncProperty(chartProgramArb, async (program) => {
        for (const policy of [false, true]) {
          const p = { ...program, cfg: { ...program.cfg, policy } };
          const { hits, bundles, frozen } = await sharedWithTheRecord(p);
          expect(bundles).toBeGreaterThan(0);
          expect(hits).toEqual([]);
          expect(frozen).toEqual([]);
        }
      }),
      { numRuns: 100 },
    );
  }, 90_000);

  it('the positive control: an object of the record handed to a recorder payload IS reported', async () => {
    const [program] = fc.sample(chartProgramArb, { numRuns: 1, seed: 42 });
    const { hits } = await sharedWithTheRecord(program, (recorded, payloads) => {
      payloads.push({ leaked: recorded[0].trace });
    });
    expect(hits.some((h) => h.startsWith('hookPayloads') && h.includes('.trace'))).toBe(true);
  });

  it('the positive control for the freeze: an object of the record a stage could reach IS reported frozen', async () => {
    const [program] = fc.sample(chartProgramArb, { numRuns: 1, seed: 7 });
    const { hits, frozen } = await sharedWithTheRecord(program, (recorded, _payloads, reads) => {
      reads.push({ held: recorded[0].trace });
    });
    expect(hits.some((h) => h.startsWith('stageReads'))).toBe(true);
    expect(frozen.length).toBeGreaterThan(0);
  });

  it('runs what it claims: every program executes, with and without a policy', async () => {
    let runs = 0;
    for (const program of fc.sample(chartProgramArb, { numRuns: 10, seed: 11 })) {
      for (const policy of [false, true]) {
        const { bundles } = await sharedWithTheRecord({ ...program, cfg: { ...program.cfg, policy } });
        if (bundles > 0) runs++;
      }
    }
    expect(runs).toBe(20);
  });
});
