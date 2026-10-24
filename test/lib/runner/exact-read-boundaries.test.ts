import { createReadSourceRecord, SharedMemory } from 'foottrace/write';
import { describe, expect, it, vi } from 'vitest';

import { registerScopeRuntime } from '../../../src/advanced.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { copyCheckpointCapture } from '../../../src/lib/capture/checkpointCapture.js';
import { NativeCapture } from '../../../src/lib/capture/nativeCoverage.js';
import { copyIdentity } from '../../../src/lib/capture/noteShape.js';
import { EngineReadSourceCapture } from '../../../src/lib/capture/readSources.js';
import { RedactionRule } from '../../../src/lib/memory/redaction.js';
import { runPolicy } from '../../../src/lib/memory/runPolicy.js';
import { StageContext } from '../../../src/lib/memory/StageContext.js';
import { decodeCheckpoint } from '../../../src/lib/pause/record.js';
import { ExecutionRuntime } from '../../../src/lib/runner/ExecutionRuntime.js';

const enabled = { readSources: true };
const view = (ex: FlowChartExecutor<any, any>) => ex.getSnapshot().readSources!;

describe('exact source integration boundaries', () => {
  it('preserves the exact serialized v1 checkpoint note, including original key order', () => {
    const capture = new NativeCapture('run', { logRunId: 'run', drillPath: [] }, 0, runPolicy());
    capture.end('paused');
    const note = capture.snapshot(3);
    const expected = { ...note, limitations: [...note.limitations, 'checkpoint-history-not-included'] };
    expect(JSON.stringify(copyCheckpointCapture(note))).toBe(JSON.stringify(expected));
  });
  it('keeps first-touch and live-fallback selection native across sibling commits', () => {
    const runtime = new ExecutionRuntime('Reader', 'reader', undefined, { n: 1 }, runPolicy(enabled), undefined, {
      runId: 'run',
    });
    const reader = runtime.rootStageContext;
    reader.bindFailureIdentity('run', 'reader#1');
    expect(reader.getValue([], 'n')).toBe(1);
    expect(reader.getValue([], 'later')).toBeUndefined();
    const writer = runtime.newRoot('Writer', 'writer');
    writer.bindFailureIdentity('run', 'writer#2');
    writer.setObject([], 'n', 2);
    writer.setObject([], 'later', 3);
    writer.commit();
    expect(reader.getValue([], 'n')).toBe(1);
    expect(reader.getValue([], 'later')).toBe(3);
    const rows = runtime.readSources!.snapshot(runtime.executionHistory.length).record!.occurrences;
    expect(rows.map((row) => row.source.kind)).toEqual(['base', 'unavailable', 'base', 'committed']);
    expect(rows[3].source).toEqual({ kind: 'committed', commitIdx: 0 });
  });

  it('does not turn a reverted staged generation into a committed source', async () => {
    const ex = new FlowChartExecutor(
      flowChart<{ n: number }>(
        'Revert',
        (s) => {
          s.n = 2;
          const staged = s.n;
          s.n = 1;
        },
        'revert',
      )
        .addFunction(
          'Read',
          (s) => {
            const n = s.n;
          },
          'read',
        )
        .build(),
      { ...enabled, initialContext: { n: 1 } },
    );
    await ex.run();
    expect(ex.getSnapshot().commitLog[0].trace).toEqual([]);
    expect(view(ex).record!.occurrences.map((row) => row.source.kind)).toEqual(['staged', 'base']);
  });

  it('preserves the original read exception without retrying the getter', () => {
    const original = new Error('PRIVATE');
    let reads = 0;
    const state = new SharedMemory(undefined, {});
    const book = createReadSourceRecord(state, { logRunId: 'run', drillPath: [] });
    Object.defineProperty(state.getState(), 'n', {
      get() {
        reads++;
        throw original;
      },
    });
    const frame = new StageContext('', 'Read', 'read', state, '', book.log);
    frame.bindFailureIdentity('run', 'read#1');
    frame.usePolicy(runPolicy(enabled));
    frame.readSources = new EngineReadSourceCapture('run', book);
    expect(() => frame.getValue([], 'n')).toThrow(original);
    expect(reads).toBe(1);
    expect(book.snapshot().status).toBe('failed');
    expect(JSON.stringify(book.snapshot())).not.toContain('PRIVATE');
  });

  it('seals terminal evidence before late native reads can append to it', async () => {
    const ex = new FlowChartExecutor(
      flowChart<{ n: number }>(
        'Read',
        (s) => {
          const n = s.n;
        },
        'read',
      ).build(),
      { ...enabled, initialContext: { n: 1 } },
    );
    await ex.run();
    const runtime = (ex as any).traverser.getRuntime() as ExecutionRuntime;
    const before = JSON.stringify(view(ex));
    runtime.rootStageContext.getValue([], 'n');
    expect(JSON.stringify(view(ex))).toBe(before);
  });

  it('performs the same one getter and one post-read privacy verdict as the disabled path', () => {
    for (const capture of [false, true]) {
      const order: string[] = [];
      const state = new SharedMemory(undefined, { n: 1 });
      const book = createReadSourceRecord(state, { logRunId: 'run', drillPath: [] });
      const rule = new RedactionRule({ keys: ['other'] });
      const verdict = rule.verdictAt.bind(rule);
      vi.spyOn(rule, 'verdictAt').mockImplementation((path, key) => {
        order.push('verdict');
        return verdict(path, key);
      });
      Object.defineProperty(state.getState(), 'n', {
        enumerable: true,
        configurable: true,
        get() {
          order.push('read');
          return 1;
        },
      });
      const frame = new StageContext('', 'Read', 'read', state, '', book.log);
      frame.bindFailureIdentity('run', 'read#1');
      frame.usePolicy(runPolicy({ readSources: capture }, rule));
      if (capture) frame.readSources = new EngineReadSourceCapture('run', book);
      expect(frame.getValue([], 'n')).toBe(1);
      expect(order).toEqual(['read', 'verdict']);
      if (capture) expect(book.snapshot().occurrences[0].source.kind).toBe('unavailable');
    }
  });

  it('keeps read-prefix and gap bookkeeping outside the pure privacy callback', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const book = createReadSourceRecord(state, { logRunId: 'run', drillPath: [] });
    const rule = new RedactionRule({ keys: ['n'] });
    const frame = new StageContext('', 'Read', 'read', state, '', book.log);
    frame.bindFailureIdentity('run', 'read#1');
    frame.usePolicy(runPolicy({ readSources: true, writeProvenance: 'reads-prefix' }, rule));
    const capture = new EngineReadSourceCapture('run', book);
    frame.readSources = capture;
    const native = (frame as any).record;
    const note = vi.spyOn(native, 'noteRead');
    const gap = vi.spyOn(capture, 'limit');
    const verdict = rule.verdictAt.bind(rule);
    const judge = vi.spyOn(rule, 'verdictAt').mockImplementation((path, key) => {
      expect(note).not.toHaveBeenCalled();
      expect(gap).not.toHaveBeenCalled();
      return verdict(path, key);
    });
    expect(frame.getValue([], 'n')).toBe(1);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledExactlyOnceWith([], 'n');
    expect(gap).toHaveBeenCalledExactlyOnceWith('privacy-active');
    judge.mockRestore();
    frame.setObject([], 'out', 2);
    frame.commit();
    expect(book.log.list()[0].trace[0].readKeys).toEqual(['n']);
  });

  it('keeps the successful read prefix and original error when a pure verdict throws', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const book = createReadSourceRecord(state, { logRunId: 'run', drillPath: [] });
    const rule = new RedactionRule({ keys: ['n'] });
    const frame = new StageContext('', 'Read', 'read', state, '', book.log);
    frame.bindFailureIdentity('run', 'read#1');
    frame.usePolicy(runPolicy({ readSources: true, writeProvenance: 'reads-prefix' }, rule));
    frame.readSources = new EngineReadSourceCapture('run', book);
    const note = vi.spyOn((frame as any).record, 'noteRead');
    const failure = Symbol('original verdict failure');
    const judge = vi.spyOn(rule, 'verdictAt').mockImplementationOnce(() => {
      expect(note).not.toHaveBeenCalled();
      throw failure;
    });
    let caught: unknown;
    try {
      frame.getValue([], 'n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(judge).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledExactlyOnceWith([], 'n');
    judge.mockRestore();
    frame.setObject([], 'out', 2);
    frame.commit();
    expect(book.log.list()[0].trace[0].readKeys).toEqual(['n']);
  });

  it('does not note an unsuccessful native read or run its privacy verdict', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const book = createReadSourceRecord(state, { logRunId: 'run', drillPath: [] });
    const rule = new RedactionRule({ keys: ['n'] });
    const frame = new StageContext('', 'Read', 'read', state, '', book.log);
    frame.bindFailureIdentity('run', 'read#1');
    frame.usePolicy(runPolicy({ readSources: true }, rule));
    frame.readSources = new EngineReadSourceCapture('run', book);
    const note = vi.spyOn((frame as any).record, 'noteRead');
    const judge = vi.spyOn(rule, 'verdictAt');
    const failure = Symbol('original native failure');
    Object.defineProperty(state.getState(), 'n', {
      get() {
        throw failure;
      },
    });
    let caught: unknown;
    try {
      frame.getValue([], 'n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(note).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });

  it('does not let failed bookkeeping replace the original verdict error', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const book = createReadSourceRecord(state, { logRunId: 'run', drillPath: [] });
    const rule = new RedactionRule({ keys: ['n'] });
    const frame = new StageContext('', 'Read', 'read', state, '', book.log);
    frame.bindFailureIdentity('run', 'read#1');
    frame.usePolicy(runPolicy({ readSources: true }, rule));
    frame.readSources = new EngineReadSourceCapture('run', book);
    vi.spyOn((frame as any).record, 'noteRead').mockImplementation(() => {
      throw new Error('cleanup');
    });
    const failure = Symbol('original verdict failure');
    const judge = vi.spyOn(rule, 'verdictAt').mockImplementationOnce(() => {
      throw failure;
    });
    let caught: unknown;
    try {
      frame.getValue([], 'n');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('uses the native execution stamp even if the public display identity changes', () => {
    const state = new SharedMemory(undefined, { n: 1 });
    const book = createReadSourceRecord(state, { logRunId: 'run', drillPath: [] });
    const frame = new StageContext('', 'Read', 'read', state, '', book.log);
    frame.bindFailureIdentity('run', 'read#1');
    frame.usePolicy(runPolicy(enabled));
    frame.readSources = new EngineReadSourceCapture('run', book);
    frame.runtimeStageId = 'forged';
    expect(frame.getValue([], 'n')).toBe(1);
    expect(book.snapshot().occurrences[0].runtimeStageId).toBe('read#1');
  });

  it('does not claim captured-empty for a non-native scope', async () => {
    const ex = new FlowChartExecutor(flowChart('Empty', () => {}, 'empty').build(), {
      ...enabled,
      scopeFactory: () => registerScopeRuntime({}, { target: {}, handlesAssignments: true }),
    });
    await ex.run();
    expect(view(ex)).toMatchObject({ status: 'partial', limitations: ['custom-scope'] });
  });

  it('reports native saturation rather than silently dropping occurrences', async () => {
    const ex = new FlowChartExecutor(
      flowChart<{ n: number }>(
        'Many',
        (s) => {
          for (let i = 0; i < 1100; i++) {
            const n = s.n;
          }
        },
        'many',
      ).build(),
      { ...enabled, initialContext: { n: 1 }, readTracking: 'off' },
    );
    await ex.run();
    const sources = view(ex);
    expect(sources.status).toBe('partial');
    expect(sources.record!.occurrences).toHaveLength(sources.record!.limits.maxPerExecution);
    expect(sources.record!.gaps).toContainEqual(expect.objectContaining({ reason: 'budget-exhausted' }));
  });

  it('withholds the source channel from redacted exports, including references captured before a mark', async () => {
    const ex = new FlowChartExecutor(
      flowChart<{ n: number }>(
        'Read',
        (s) => {
          const n = s.n;
        },
        'read',
      ).build(),
      { ...enabled, initialContext: { n: 1 } },
    );
    await ex.run();
    expect(view(ex).record).toBeDefined();
    const safe = ex.getSnapshot({ redact: true });
    expect(safe.readSources).toMatchObject({ status: 'unknown', limitations: ['redacted-source-export'] });
    expect(safe.readSources).not.toHaveProperty('record');
    expect(safe.capture!.channels.readSources).toBe('unknown');
  });

  it('keeps strict version-1 admission closed to version-2 observations', async () => {
    const ex = new FlowChartExecutor(flowChart('Empty', () => {}, 'empty').build(), enabled);
    await ex.run();
    expect(ex.getSnapshot().capture!.version).toBe(2);
    expect(copyIdentity(ex.getSnapshot().capture)).toBeUndefined();
  });

  it('does not borrow the root source book for a child invocation', async () => {
    const ex = new FlowChartExecutor(
      flowChart('Root', () => {}, 'root')
        .addSubFlowChartNext('child', flowChart('Child', () => {}, 'child-step').build(), 'Child')
        .build(),
      enabled,
    );
    await ex.run();
    expect(view(ex).status).toBe('captured');
    const children = Object.values(ex.getSnapshot().subflowResults!) as any[];
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(child.treeContext.readSources).toMatchObject({
        status: 'unknown',
        limitations: ['child-source-ownership'],
      });
      expect(child.treeContext.readSources).not.toHaveProperty('record');
    }
  });

  it('cannot enable sources through a stored version-2 checkpoint', async () => {
    const c = flowChart<{ n: number }>(
      'Read',
      (s) => {
        const n = s.n;
      },
      'read',
    )
      .addPausableFunction('Ask', { execute: () => ({}), resume: () => {} }, 'ask')
      .build();
    const ex = new FlowChartExecutor(c, { ...enabled, initialContext: { n: 1 } });
    await ex.run();
    const checkpoint = decodeCheckpoint(JSON.parse(JSON.stringify(ex.getCheckpoint())));
    const next = new FlowChartExecutor(c);
    await next.resume(checkpoint, true);
    expect(next.getSnapshot()).not.toHaveProperty('readSources');
    expect(next.getSnapshot()).not.toHaveProperty('capture');
  });

  it.each([0, 'true', null, {}, []])('refuses invalid source opt-in %j before creating a run', (readSources) => {
    expect(() => new FlowChartExecutor(flowChart('Empty', () => {}, 'empty').build(), { readSources } as any)).toThrow(
      'readSources must be a boolean',
    );
  });
});
