/**
 * The "absent when empty" half of the 9.21.0 declared-tags law: a chart that
 * declares NO tag produces bytes identical to 9.20.0 — log, snapshot, fold
 * base, execution tree, subflow results, checkpoint and narrative, under BOTH
 * commit-log encodings, across a pause and a cross-executor resume.
 *
 * `reference/untagged-9.20.0.{full,delta}.json` are the bytes
 * `runUntaggedFixture` produced on the 9.20.0 tree (01685c3) on 2026-09-10,
 * BEFORE any 9.21.0 source edit, run twice per encoding and checked to agree.
 * The same fixture, run on the current code, must reproduce them byte for
 * byte apart from the named R13/F8 changes and the C2 fresh-resume narrative
 * correction pinned by reference() below. Volatile fields (timestamps, run
 * ids, `pausedAt`) are dropped on both sides.
 *
 * To regenerate after an INTENDED untagged change, run the fixture on the
 * old tag and replace the files — never on the new code.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runUntaggedFixture } from './declared-tags-untagged-fixture.js';
import { withoutRecordedPhases } from './f8-recorded-phases.js';
import { bothKeys, withSeedsNamedByMount } from './r13-seed-named-by-mount.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The original bytes with only the named seed attribution and narrative corrections. */
function reference(encoding: 'full' | 'delta'): string {
  const parsed = JSON.parse(
    withSeedsNamedByMount(
      readFileSync(join(here, 'reference', `untagged-9.20.0.${encoding}.json`), 'utf8'),
      bothKeys(['paused'], 'sf', { stage: 'Sub', stageId: 'sf', runtimeStageId: 'sf#9' }),
    ),
  );
  // C2: the original fresh resume had only standalone stage sentences (and
  // C1 removed its duplicate transition). It now starts the enabled combined
  // narrator. Pin the whole corrected resumed leg; all other bytes stay intact.
  expect(parsed.resumed.narrative).toEqual([
    { type: 'stage', text: 'Next, it moved on to Gate.', depth: 0 },
    { type: 'stage', text: 'Next, it moved on to Finish.', depth: 0 },
    { type: 'stage', text: 'Next, it moved on to Finish.', depth: 0 },
  ]);
  parsed.resumed.narrative = [
    {
      type: 'resume',
      text: 'Execution resumed at Gate with input.',
      depth: 0,
      stageName: 'Gate',
      stageId: 'gate',
      runtimeStageId: 'gate#13',
    },
    {
      type: 'stage',
      text: 'Stage 1: The process began with Gate.',
      depth: 0,
      stageName: 'Gate',
      stageId: 'gate',
      runtimeStageId: 'gate#13',
    },
    {
      type: 'step',
      text: 'Step 1: Write approved = true',
      depth: 1,
      stageName: 'Gate',
      stageId: 'gate',
      runtimeStageId: 'gate#13',
      stepNumber: 1,
      key: 'approved',
      rawValue: true,
    },
    {
      type: 'stage',
      text: 'Stage 2: Next, it moved on to Finish.',
      depth: 0,
      stageName: 'Finish',
      stageId: 'finish',
      runtimeStageId: 'finish#14',
    },
    {
      type: 'step',
      text: 'Step 1: Read approved = true',
      depth: 1,
      stageName: 'Finish',
      stageId: 'finish',
      runtimeStageId: 'finish#14',
      stepNumber: 1,
      key: 'approved',
      rawValue: true,
    },
    {
      type: 'step',
      text: 'Step 2: Read summary = "NaN:3"',
      depth: 1,
      stageName: 'Finish',
      stageId: 'finish',
      runtimeStageId: 'finish#14',
      stepNumber: 2,
      key: 'summary',
      rawValue: 'NaN:3',
    },
    {
      type: 'step',
      text: 'Step 3: Write done = true',
      depth: 1,
      stageName: 'Finish',
      stageId: 'finish',
      runtimeStageId: 'finish#14',
      stepNumber: 3,
      key: 'done',
      rawValue: true,
    },
  ];
  return JSON.stringify(parsed, null, 2);
}

describe('declared tags — 9.20.0 bytes except named record and narrative corrections', () => {
  it('commitValues: full', async () => {
    expect(withoutRecordedPhases(await runUntaggedFixture('full'))).toBe(reference('full'));
  });

  it('commitValues: delta', async () => {
    expect(withoutRecordedPhases(await runUntaggedFixture('delta'))).toBe(reference('delta'));
  });

  it('the reference is what it claims — every commit path present, no `tags` key anywhere', () => {
    const full = JSON.parse(reference('full'));
    const ids = (leg: { commitLog: { runtimeStageId: string }[] }) => leg.commitLog.map((b) => b.runtimeStageId);
    // Empty commit, retry, fork children, decider + branch, subflow mount, pause.
    expect(ids(full.paused)).toEqual(
      expect.arrayContaining(['idle#1', 'flaky#2', 'child-a#4', 'child-b#5', 'route#7', 'low#8', 'sf#9', 'gate#12']),
    );
    // The resumed leg re-stamps the gate from the chart and finishes.
    expect(ids(full.resumed)).toEqual(['gate#13', 'finish#14']);
    expect(reference('full')).not.toContain('"tags"');
    expect(reference('delta')).not.toContain('"tags"');
  });
});
