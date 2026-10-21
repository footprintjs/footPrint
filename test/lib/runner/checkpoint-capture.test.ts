/** First persistence slice of #111: checkpoint metadata, never a durable-history claim. */
import { describe, expect, it, vi } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../src/index.js';
import { decodeCheckpoint } from '../../../src/lib/pause/record.js';

const chart = () =>
  flowChart<{ value: number }>(
    'Seed',
    (s) => {
      s.value = 1;
    },
    'seed',
  )
    .addPausableFunction(
      'Ask',
      {
        execute: () => ({ question: 'Continue?' }),
        resume: (s) => {
          s.value += 1;
        },
      },
      'ask',
    )
    .build();

async function paused(captureCoverage = true) {
  const ex = new FlowChartExecutor(chart(), { captureCoverage });
  await ex.run();
  return ex;
}

function capture(checkpoint: unknown): any {
  return (checkpoint as { capture?: unknown }).capture;
}

describe('checkpoint capture observation', () => {
  it('keeps a scoped paused observation through JSON and the existing codec', async () => {
    const ex = await paused();
    const checkpoint = ex.getCheckpoint()!;
    const note = capture(checkpoint);
    expect(note).toMatchObject({
      version: 1,
      runId: ex.getSnapshot().runId,
      scope: 'root-log',
      boundary: { status: 'paused' },
      persistence: 'memory-only',
      channels: { control: 'unknown' },
    });
    expect(note.commits).toEqual(ex.getSnapshot().capture!.commits);
    expect(note.limitations).toContain('checkpoint-history-not-included');
    expect(capture(decodeCheckpoint(JSON.parse(JSON.stringify(checkpoint))))).toEqual(note);
    expect(checkpoint).not.toHaveProperty('commitLog');
    expect(checkpoint).not.toHaveProperty('recorders');
  });

  it('does not build a snapshot or call recorder serialization to create a checkpoint', async () => {
    const ex = new FlowChartExecutor(chart(), { captureCoverage: true });
    const serialize = vi.fn(() => {
      throw new Error('PRIVATE_RECORDER');
    });
    ex.attachFlowRecorder({ id: 'private', onRunStart() {}, toSnapshot: serialize });
    const snapshot = vi.spyOn(ex, 'getSnapshot').mockImplementation(() => {
      throw new Error('NO_TREE_WALK');
    });
    await ex.run();
    expect(capture(ex.getCheckpoint())).toBeDefined();
    expect(serialize).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(JSON.stringify(capture(ex.getCheckpoint()))).not.toMatch(/PRIVATE|NO_TREE/);
  });

  it('keeps both disabled and absent opt-in checkpoints free of capture metadata', async () => {
    for (const options of [{}, { captureCoverage: false }]) {
      const ex = new FlowChartExecutor(chart(), options);
      await ex.run();
      expect(ex.getCheckpoint()).not.toHaveProperty('capture');
      expect(decodeCheckpoint(JSON.parse(JSON.stringify(ex.getCheckpoint())))).not.toHaveProperty('capture');
    }
  });

  it('detaches checkpoint metadata from the live record and from decoded metadata', async () => {
    const ex = await paused();
    const checkpoint = ex.getCheckpoint()!;
    const decoded = decodeCheckpoint(checkpoint);
    const original = structuredClone(capture(decoded));
    capture(checkpoint).commits.to = 999;
    capture(checkpoint).limitations.push('PRIVATE_MARK');
    expect(capture(decoded)).toEqual(original);
    expect(ex.getSnapshot().capture!.commits.to).not.toBe(999);
    expect(ex.getSnapshot().capture!.limitations).not.toContain('PRIVATE_MARK');
  });

  it.each([false, true])('resume (same executor: %s) never borrows the paused note', async (same) => {
    const ex = await paused();
    const checkpoint = JSON.parse(JSON.stringify(ex.getCheckpoint()));
    const before = JSON.stringify(checkpoint);
    const next = same ? ex : new FlowChartExecutor(chart(), { captureCoverage: true });
    await next.resume(checkpoint, true);
    const note = next.getSnapshot().capture!;
    expect(note.runId).not.toBe(capture(checkpoint).runId);
    expect(note.boundary.status).toBe('completed');
    expect(note.limitations).toContain('resumed-segment');
    expect(note.limitations).not.toContain('checkpoint-history-not-included');
    expect(JSON.stringify(checkpoint)).toBe(before);
  });

  it('does not enable capture from metadata in a stored checkpoint', async () => {
    const ex = await paused();
    const next = new FlowChartExecutor(chart());
    await next.resume(JSON.parse(JSON.stringify(ex.getCheckpoint())), true);
    expect(next.getSnapshot()).not.toHaveProperty('capture');
  });

  it('a new run does not inherit checkpoint or resumed limitations', async () => {
    const ex = await paused();
    await ex.resume(ex.getCheckpoint()!, true);
    await ex.run();
    expect(ex.getSnapshot().capture!.limitations).not.toContain('resumed-segment');
    expect(ex.getSnapshot().capture!.limitations).not.toContain('checkpoint-history-not-included');
  });

  it('retains effective modes without inventing stored reads or decisions', async () => {
    const ex = new FlowChartExecutor(chart(), { captureCoverage: true, readTracking: 'off', writeTracking: 'summary' });
    await ex.run();
    expect(capture(ex.getCheckpoint())).toMatchObject({
      modes: { readTracking: 'off', writeTracking: 'summary' },
      channels: { reads: 'disabled', control: 'unknown', readSources: 'not-collected' },
    });
  });

  it.each([
    ['policy', false],
    ['policy', true],
    ['per-write', false],
    ['per-write', true],
  ] as const)('records active %s redaction independently of an earlier snapshot (%s)', async (redaction, snapshot) => {
    const flow = flowChart<{ hiddenKey: string }>(
      'Seed',
      (scope) => {
        scope.$setValue('hiddenKey', 'PRIVATE_VALUE', redaction === 'per-write');
        if (snapshot) ex.getSnapshot();
      },
      'seed',
    )
      .addPausableFunction('Ask', { execute: () => 1, resume: () => undefined }, 'ask')
      .build();
    const ex = new FlowChartExecutor(flow, { captureCoverage: true });
    if (redaction === 'policy') ex.setRedactionPolicy({ keys: ['hiddenKey'] });
    await ex.run();
    const note = capture(ex.getCheckpoint());
    expect(note.limitations).toContain('redaction-active');
    expect(note.limitations).toContain('checkpoint-history-not-included');
    expect(JSON.stringify(note)).not.toMatch(/hiddenKey|PRIVATE_VALUE/);
    expect(capture(decodeCheckpoint(JSON.parse(JSON.stringify(ex.getCheckpoint()))))).toEqual(note);
  });
});

describe('checkpoint scope continuity', () => {
  it('a nested pause records only the root observation, never child coverage', async () => {
    const nested = flowChart('Parent', () => undefined, 'parent')
      .addSubFlowChartNext('child', chart(), 'Child')
      .build();
    const ex = new FlowChartExecutor(nested, { captureCoverage: true });
    await ex.run();
    const checkpoint = ex.getCheckpoint()!;
    expect(checkpoint.subflowPath).toEqual(['child']);
    expect(capture(checkpoint)).toMatchObject({ scope: 'root-log', logAddress: { drillPath: [] } });
    expect(capture(checkpoint).limitations).toContain('child-scopes-not-attested');
    expect(capture(decodeCheckpoint(JSON.parse(JSON.stringify(checkpoint))))).toEqual(capture(checkpoint));
  });

  it('a second pause belongs to its new segment and does not mutate the first checkpoint', async () => {
    const second = flowChart<{ value: number }>(
      'Seed',
      (s) => {
        s.value = 1;
      },
      'seed',
    )
      .addPausableFunction('One', { execute: () => 1, resume: () => undefined }, 'one')
      .addPausableFunction('Two', { execute: () => 2, resume: () => undefined }, 'two')
      .build();
    const ex = new FlowChartExecutor(second, { captureCoverage: true });
    await ex.run();
    const first = ex.getCheckpoint()!;
    const original = JSON.stringify(first);
    await ex.resume(JSON.parse(original), true);
    const next = ex.getCheckpoint()!;
    expect(capture(next).runId).not.toBe(capture(first).runId);
    expect(capture(next).commits.from).toBe(capture(first).commits.to);
    expect(capture(next).boundary.status).toBe('paused');
    expect(JSON.stringify(first)).toBe(original);
  });
});

describe('stored checkpoint capture boundary', () => {
  it.each([
    [
      'version',
      (n: any) => {
        n.version = 2;
      },
    ],
    [
      'scope',
      (n: any) => {
        n.scope = 'child';
      },
    ],
    [
      'persistence',
      (n: any) => {
        n.persistence = 'durable';
      },
    ],
    [
      'boundary',
      (n: any) => {
        n.boundary.status = 'completed';
      },
    ],
    [
      'negative extent',
      (n: any) => {
        n.commits.from = -1;
      },
    ],
    [
      'fractional extent',
      (n: any) => {
        n.commits.to = 1.5;
      },
    ],
    [
      'reversed extent',
      (n: any) => {
        n.commits.from = n.commits.to + 1;
      },
    ],
    [
      'identity',
      (n: any) => {
        n.runId = 'PRIVATE'.repeat(400);
      },
    ],
    [
      'child address',
      (n: any) => {
        n.logAddress.drillPath = ['child'];
      },
    ],
    [
      'mode',
      (n: any) => {
        n.modes.readTracking = 'invented';
      },
    ],
    [
      'channel',
      (n: any) => {
        n.channels.reads = 'invented';
      },
    ],
    [
      'read versions',
      (n: any) => {
        n.channels.readSources = 'captured';
      },
    ],
    [
      'unknown limitation',
      (n: any) => {
        n.limitations.push('PRIVATE_UNKNOWN');
      },
    ],
    [
      'too many limitations',
      (n: any) => {
        n.limitations = Array(1000).fill('tracked-state-only');
      },
    ],
  ])('refuses invalid %s with fixed wording before a resume can change state', async (_, change) => {
    const ex = await paused();
    const checkpoint = JSON.parse(JSON.stringify(ex.getCheckpoint()));
    const note = capture(checkpoint);
    expect(note).toBeDefined();
    change(note);
    expect(() => decodeCheckpoint(checkpoint)).toThrow(
      'Invalid checkpoint: capture must be a bounded paused root-log observation.',
    );
    await expect(ex.resume(checkpoint, true)).rejects.toThrow('Invalid checkpoint: capture');
    expect(ex.getSnapshot().sharedState.value).toBe(1);
  });

  it('never evaluates capture getters, including nested properties', async () => {
    const ex = await paused();
    for (const place of ['top', 'nested', 'array']) {
      const checkpoint = JSON.parse(JSON.stringify(ex.getCheckpoint()));
      const getter = vi.fn(() => {
        throw new Error('PRIVATE_GETTER');
      });
      if (place === 'top') Object.defineProperty(checkpoint, 'capture', { enumerable: true, get: getter });
      if (place === 'nested') Object.defineProperty(capture(checkpoint).commits, 'to', { get: getter });
      if (place === 'array') Object.defineProperty(capture(checkpoint).limitations, '0', { get: getter });
      expect(() => decodeCheckpoint(checkpoint)).toThrow('Invalid checkpoint: capture');
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it('copies known facts only and never lets a supplied control claim certify missing recorder history', async () => {
    const ex = await paused();
    const checkpoint = JSON.parse(JSON.stringify(ex.getCheckpoint()));
    const note = capture(checkpoint);
    expect(note).toBeDefined();
    note.channels.control = 'captured';
    note.limitations = [];
    Object.defineProperty(note, 'privateExtra', {
      get() {
        throw new Error('PRIVATE_EXTRA');
      },
    });
    const decoded = capture(decodeCheckpoint(checkpoint));
    expect(decoded.channels.control).toBe('unknown');
    expect(decoded.limitations).toContain('checkpoint-history-not-included');
    expect(decoded).not.toHaveProperty('privateExtra');
  });

  it.each(['failed', 'partial', 'disabled'])('does not erase a known %s control limitation', async (control) => {
    const ex = await paused();
    const checkpoint = JSON.parse(JSON.stringify(ex.getCheckpoint()));
    capture(checkpoint).channels.control = control;
    expect(capture(decodeCheckpoint(checkpoint)).channels.control).toBe(control);
  });

  it('allows explicit undefined as absence, while refusing null metadata', async () => {
    const ex = await paused(false);
    const checkpoint = { ...ex.getCheckpoint()!, capture: undefined };
    expect(decodeCheckpoint(checkpoint)).not.toHaveProperty('capture');
    expect(() => decodeCheckpoint({ ...checkpoint, capture: null })).toThrow('Invalid checkpoint: capture');
  });

  it('does not invoke array get traps to inspect length or entries', async () => {
    const ex = await paused();
    const checkpoint = JSON.parse(JSON.stringify(ex.getCheckpoint()));
    const get = vi.fn(() => {
      throw new Error('PRIVATE_ARRAY_GET');
    });
    const note = capture(checkpoint);
    note.logAddress.drillPath = new Proxy([], { get });
    note.limitations = new Proxy(note.limitations, { get });
    expect(capture(decodeCheckpoint(checkpoint)).limitations).toContain('checkpoint-history-not-included');
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['throw', 'change'])('does not read capture again through a root proxy (%s)', async (behavior) => {
    const ex = await paused();
    const checkpoint = JSON.parse(JSON.stringify(ex.getCheckpoint()));
    const original = capture(checkpoint);
    const captureGet = vi.fn(() => {
      if (behavior === 'throw') throw new Error('PRIVATE_CAPTURE_ERROR');
      return { ...original, runId: 'CHANGED_CAPTURE' };
    });
    const stored = new Proxy(checkpoint, {
      get(target, key, receiver) {
        return key === 'capture' ? captureGet() : Reflect.get(target, key, receiver);
      },
    });
    expect(capture(decodeCheckpoint(stored))).toEqual(original);
    expect(captureGet).not.toHaveBeenCalled();
  });
});
