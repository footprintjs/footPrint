/**
 * Back-compat: a checkpoint WRITTEN BY 9.27.0 resumes correctly on 9.28.0.
 *
 * The one-shot resume re-entry changed how a checkpoint is re-entered, not
 * what a checkpoint is. `reference/resume-real-chart-9.27.0.json` holds the
 * first checkpoint of every chart in resume-real-chart-fixture.ts, produced on
 * the 9.27.0 tree (8b98da2) on 2026-09-27, BEFORE any 9.28.0 source edit, and
 * JSON round-tripped — exactly what a consumer has sitting in Redis/Postgres
 * across the upgrade. Each one must resume on the current code into the
 * healthy run: the same trace, the same number of pauses, as a run that never
 * left the current code.
 *
 * Never regenerate the reference on the new code — it exists to be old.
 *
 * Test type: integration (back-compat across a release boundary).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { FlowchartCheckpoint } from '../../../src/index.js';
import { FlowChartExecutor } from '../../../src/index.js';
import { type ResumeChartName, HEALTHY, RESUME_CHARTS } from './resume-real-chart-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const reference = JSON.parse(readFileSync(join(here, 'reference', 'resume-real-chart-9.27.0.json'), 'utf8')) as {
  generatedBy: string;
  checkpoints: Record<ResumeChartName, FlowchartCheckpoint>;
};

const NAMES = Object.keys(RESUME_CHARTS) as ResumeChartName[];

function isPaused(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { paused?: unknown }).paused === true;
}

describe('a 9.27.0 checkpoint resumes on the fixed engine', () => {
  it('the reference is what it claims: one 9.27.0 checkpoint per fixture chart', () => {
    expect(reference.generatedBy).toMatch(/^footprintjs 9\.27\.0 \(8b98da2\)/);
    expect(Object.keys(reference.checkpoints).sort()).toEqual([...NAMES].sort());
  });

  it.each(NAMES)('%s: fresh executor, stored bytes → the healthy run', async (name) => {
    const chart = RESUME_CHARTS[name]();
    // Every resume on a fresh executor, from bytes — the stored checkpoint first.
    let executor = new FlowChartExecutor(chart);
    let pauses = 1;
    let result: unknown = await executor.resume(structuredClone(reference.checkpoints[name]), { n: pauses });
    while (isPaused(result) && pauses < 12) {
      pauses += 1;
      const wire = JSON.parse(JSON.stringify(executor.getCheckpoint()));
      executor = new FlowChartExecutor(chart);
      result = await executor.resume(wire, { n: pauses });
    }

    const state = executor.getSnapshot().sharedState as Record<string, unknown>;
    expect(state.trace).toEqual(HEALTHY[name].trace);
    expect(pauses).toBe(HEALTHY[name].pauses);
    if (name === 'twoDeep') expect(state.aPreRuns).toBe(1);
  });
});
