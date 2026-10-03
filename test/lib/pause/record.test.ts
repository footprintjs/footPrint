/**
 * The checkpoint codec (F8, 9.39.0) — `pause/record.ts`: one version, one
 * upcaster, one validator, one message set.
 *
 * - UNIT: the upcaster (v0 → v1 drops the legacy `continuationStageId` and
 *   stamps the version; never edits its input; refuses a version it does not
 *   know).
 * - BACK-COMPAT: a checkpoint written by 9.20.0, 9.27.0, 9.28.0 and 9.37.0
 *   resumes through the upcaster into the healthy run (the 9.27.0 file is the
 *   pin `resume-real-chart-9.27.0-checkpoints.test.ts` has always read; the
 *   other three were made on their release tags for this packet, from the
 *   same fixture charts — never regenerate them on new code).
 * - SECURITY (table-driven): every malformed record is refused with ONE
 *   sentence at BOTH former validation sites — the checkpoint's own record
 *   (`FlowChartExecutor · resume`, until 9.38.0) and a waiting sibling's
 *   `pendingPauses[n]` (`ResumeEntry`, until 9.38.0) — differing only in the
 *   path prefix.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { FlowchartCheckpoint } from '../../../src/index.js';
import { FlowChartExecutor } from '../../../src/index.js';
import { ResumeEntry } from '../../../src/lib/engine/handlers/ResumeEntry.js';
import { CHECKPOINT_VERSION, decodeCheckpoint, upcastCheckpoint } from '../../../src/lib/pause/record.js';
import { type ResumeChartName, HEALTHY, RESUME_CHARTS } from './resume-real-chart-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const NAMES = Object.keys(RESUME_CHARTS) as ResumeChartName[];
const RELEASES = ['9.20.0', '9.27.0', '9.28.0', '9.37.0'] as const;

function referenceOf(release: string) {
  return JSON.parse(readFileSync(join(here, 'reference', `resume-real-chart-${release}.json`), 'utf8')) as {
    generatedBy: string;
    checkpoints: Record<ResumeChartName, FlowchartCheckpoint & Record<string, unknown>>;
  };
}

const isPaused = (result: unknown) =>
  typeof result === 'object' && result !== null && (result as { paused?: unknown }).paused === true;

describe('the upcaster', () => {
  it('reads an unversioned (pre-9.39.0) checkpoint as version 0: drops continuationStageId, stamps the version', () => {
    const stored = { sharedState: {}, pausedStageId: 'a', subflowPath: [], continuationStageId: 'after', x: 1 };
    const before = structuredClone(stored);
    const up = upcastCheckpoint(stored);
    expect(up).toEqual({
      checkpointVersion: CHECKPOINT_VERSION,
      sharedState: {},
      pausedStageId: 'a',
      subflowPath: [],
      x: 1,
    });
    expect(stored).toEqual(before); // the caller's object is never edited
  });

  it('passes the current version through as a copy', () => {
    const stored = { checkpointVersion: 1, sharedState: {}, pausedStageId: 'a', subflowPath: [] };
    const up = upcastCheckpoint(stored);
    expect(up).toEqual(stored);
    expect(up).not.toBe(stored);
  });

  it.each([2, 0, '1', null])('refuses a version it does not know (%j)', (version) => {
    expect(() => upcastCheckpoint({ checkpointVersion: version })).toThrow(
      /^Invalid checkpoint: checkpointVersion .* is not one this release reads/,
    );
  });

  it('a new checkpoint is written at the current version and never carries continuationStageId', async () => {
    const executor = new FlowChartExecutor(RESUME_CHARTS.askLoopTopLevel());
    await executor.run();
    const checkpoint = executor.getCheckpoint()!;
    expect(checkpoint.checkpointVersion).toBe(CHECKPOINT_VERSION);
    expect(Object.keys(checkpoint)[0]).toBe('checkpointVersion');
    expect(Object.prototype.hasOwnProperty.call(checkpoint, 'continuationStageId')).toBe(false);
    expect(decodeCheckpoint(JSON.parse(JSON.stringify(checkpoint))).checkpointVersion).toBe(1);
  });
});

describe('a checkpoint from an older release resumes through the upcaster', () => {
  it.each(RELEASES)('the %s reference is what it claims', (release) => {
    const reference = referenceOf(release);
    expect(reference.generatedBy).toContain(`footprintjs ${release}`);
    expect(Object.keys(reference.checkpoints).sort()).toEqual([...NAMES].sort());
    for (const checkpoint of Object.values(reference.checkpoints)) {
      expect(checkpoint.checkpointVersion).toBeUndefined();
    }
  });

  const cases = RELEASES.flatMap((release) => NAMES.map((name) => [release, name] as const));
  it.each(cases)('%s · %s: fresh executor, stored bytes → the healthy run', async (release, name) => {
    const chart = RESUME_CHARTS[name]();
    let executor = new FlowChartExecutor(chart);
    let pauses = 1;
    let result: unknown = await executor.resume(structuredClone(referenceOf(release).checkpoints[name]), {
      n: pauses,
    });
    while (isPaused(result) && pauses < 12) {
      pauses += 1;
      const wire = JSON.parse(JSON.stringify(executor.getCheckpoint()));
      executor = new FlowChartExecutor(chart);
      result = await executor.resume(wire, { n: pauses });
    }
    const state = executor.getSnapshot().sharedState as Record<string, unknown>;
    expect(state.trace).toEqual(HEALTHY[name].trace);
    expect(pauses).toBe(HEALTHY[name].pauses);
  });
});

// ── One validator, one message set — both former entry points ────────────

/** A record field broken one way, and the sentence (after the location) it must be refused with. */
const MALFORMED: ReadonlyArray<readonly [string, (r: Record<string, unknown>) => void, string]> = [
  ['no paused stage', (r) => delete r.pausedStageId, 'pausedStageId must be a non-empty string'],
  ['an empty paused stage', (r) => (r.pausedStageId = ''), 'pausedStageId must be a non-empty string'],
  ['a numeric paused stage', (r) => (r.pausedStageId = 7), 'pausedStageId must be a non-empty string'],
  ['a string path', (r) => (r.subflowPath = 'sf-a'), 'subflowPath must be an array of strings'],
  ['a path of numbers', (r) => (r.subflowPath = [1]), 'subflowPath must be an array of strings'],
  ['captures as an array', (r) => (r.subflowStates = []), 'subflowStates must be an object'],
  ['captures as null', (r) => (r.subflowStates = null), 'subflowStates must be an object'],
  ['a capture that is not an object', (r) => (r.subflowStates = { sf: 3 }), 'subflowStates["sf"] must be an object'],
  ['a capture that is an array', (r) => (r.subflowStates = { sf: [] }), 'subflowStates["sf"] must be an object'],
  ['an unknown pausedBy', (r) => (r.pausedBy = 'magic'), "pausedBy must be 'interrupt' when present"],
];

async function freshCheckpoint(): Promise<Record<string, unknown>> {
  const executor = new FlowChartExecutor(RESUME_CHARTS.askLoopTopLevel());
  await executor.run();
  return JSON.parse(JSON.stringify(executor.getCheckpoint())) as Record<string, unknown>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('one validator, one message set — the table hits both former entry points', () => {
  it.each(MALFORMED)(
    '%s — the checkpoint’s own record (former FlowChartExecutor · resume check)',
    async (_, breakIt, what) => {
      const checkpoint = await freshCheckpoint();
      breakIt(checkpoint);
      const executor = new FlowChartExecutor(RESUME_CHARTS.askLoopTopLevel());
      await expect(executor.resume(checkpoint as never, {})).rejects.toThrow(
        new RegExp(`^Invalid checkpoint: ${escape(what)}\\.$`),
      );
    },
  );

  it.each(MALFORMED)(
    '%s — a waiting sibling, pendingPauses[0] (former ResumeEntry check)',
    async (_, breakIt, what) => {
      const checkpoint = await freshCheckpoint();
      const sibling: Record<string, unknown> = {
        pausedStageId: checkpoint.pausedStageId,
        subflowPath: [],
        subflowStates: {},
      };
      breakIt(sibling);
      const executor = new FlowChartExecutor(RESUME_CHARTS.askLoopTopLevel());
      await expect(executor.resume({ ...checkpoint, pendingPauses: [sibling] } as never, {})).rejects.toThrow(
        new RegExp(`^Invalid checkpoint: pendingPauses\\[0\\]\\.${escape(what)}\\.$`),
      );
    },
  );

  it.each([
    ['a non-object checkpoint', () => 'nope', 'the checkpoint must be an object'],
    ['a null checkpoint', () => null, 'the checkpoint must be an object'],
    [
      'sharedState as an array',
      (c: Record<string, unknown>) => ({ ...c, sharedState: [] }),
      'sharedState must be a plain object',
    ],
    [
      'no sharedState',
      (c: Record<string, unknown>) => ({ ...c, sharedState: undefined }),
      'sharedState must be a plain object',
    ],
    [
      'pendingPauses not an array',
      (c: Record<string, unknown>) => ({ ...c, pendingPauses: {} }),
      'pendingPauses must be an array',
    ],
    [
      'a non-object sibling',
      (c: Record<string, unknown>) => ({ ...c, pendingPauses: ['x'] }),
      'pendingPauses[0] must be an object',
    ],
    [
      'a string executionCount',
      (c: Record<string, unknown>) => ({ ...c, executionCount: '7' }),
      'executionCount must be a non-negative integer',
    ],
    [
      'a negative executionCount',
      (c: Record<string, unknown>) => ({ ...c, executionCount: -1 }),
      'executionCount must be a non-negative integer',
    ],
    [
      'a fractional executionCount',
      (c: Record<string, unknown>) => ({ ...c, executionCount: 1.5 }),
      'executionCount must be a non-negative integer',
    ],
    [
      'visitCounts with a non-count',
      (c: Record<string, unknown>) => ({ ...c, visitCounts: { a: 'x' } }),
      'visitCounts must map stage ids to non-negative integers',
    ],
  ] as const)('%s — refused before anything is touched', async (_, shape, what) => {
    const checkpoint = shape(await freshCheckpoint());
    const executor = new FlowChartExecutor(RESUME_CHARTS.askLoopTopLevel());
    await expect(executor.resume(checkpoint as never, {})).rejects.toThrow(
      new RegExp(`^Invalid checkpoint: ${escape(what)}\\.$`),
    );
    expect(executor.getCheckpoint()).toBeUndefined();
  });
});

describe('the codec’s other rules', () => {
  it('a v1 checkpoint never keeps continuationStageId', () => {
    const up = upcastCheckpoint({ checkpointVersion: 1, pausedStageId: 'a', continuationStageId: 'after' });
    expect(up).toEqual({ checkpointVersion: 1, pausedStageId: 'a' });
  });

  it('a malformed top-level pausedExecution is DROPPED, as a sibling’s is — never trusted, never fatal', async () => {
    const checkpoint = await freshCheckpoint();
    const decoded = decodeCheckpoint({ ...checkpoint, pausedExecution: { runId: 7 } });
    expect(Object.prototype.hasOwnProperty.call(decoded, 'pausedExecution')).toBe(false);
    const sibling = decodeCheckpoint({
      ...checkpoint,
      pendingPauses: [{ pausedStageId: 'x', subflowPath: [], pausedExecution: { runId: 7 } }],
    }).pendingPauses![0];
    expect(Object.prototype.hasOwnProperty.call(sibling, 'pausedExecution')).toBe(false);
    // …and a well-formed one is kept on both.
    expect(decodeCheckpoint(checkpoint).pausedExecution).toEqual(checkpoint.pausedExecution);
  });

  it.each([
    ['not an array', {}, 'pendingPauses must be an array'],
    ['a record with no stage', [{ subflowPath: [] }], 'pendingPauses[0].pausedStageId must be a non-empty string'],
  ] as const)('ResumeEntry.plan, called directly, checks its pendingPauses with the codec (%s)', (_, pending, what) => {
    const standIn = { name: 'S', id: 's' };
    expect(() =>
      ResumeEntry.plan({
        root: standIn,
        subflows: {},
        path: [],
        captures: {},
        standIn,
        pendingPauses: pending as never,
      }),
    ).toThrow(new RegExp(`^Invalid checkpoint: ${escape(what)}\\.$`));
  });
});
