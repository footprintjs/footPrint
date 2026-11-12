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
 * byte apart from the named R13/F8 changes, the L1 lean checkpoint, the C2
 * fresh-resume narrative correction and the P1a attempt evidence (10.1: the
 * retried stage's tree node carries its attempts; its narrative renders one
 * attempt line per attempt instead of the retry line — `p1a-attempt-evidence.ts`)
 * pinned by reference() below, and the mapper-reads law (the Sub mount's node carries the keys its
 * inputMapper and merge-back read — `mapper-reads-law.ts`, taken out of the build's bytes after it is asserted),
 * and the read-window law (foottrace 1.13.0: the fork child that ran beside its sibling, `child-b#5`, carries
 * `beganAt` — `read-window-law.ts`, `UNTAGGED_READ_WINDOWS`; asserted exactly, then taken out of the build's
 * bytes, since 9.20.0 could not write it), and the 12.0.0 list form (the reference's linked trees are read as
 * the run's stages in order, a fork's children as `branches` — `withListTrees`). Volatile fields (timestamps, run ids,
 * `pausedAt`, an attempt's `startedAt` / `durationMs`) are dropped on both
 * sides, and a narrative attempt line's duration is settled to `«ms»`.
 *
 * To regenerate after an INTENDED untagged change, run the fixture on the
 * old tag and replace the files — never on the new code.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { upcastCheckpoint } from '../../../../src/lib/pause/record.js';
import { runUntaggedFixture, UNTAGGED_MAPPER_READS, UNTAGGED_READ_WINDOWS } from './declared-tags-untagged-fixture.js';
import { withoutRecordedPhases } from './f8-recorded-phases.js';
import { withoutMapperReadsText } from './mapper-reads-law.js';
import { withAttemptEvidence, withSettledAttemptDurations } from './p1a-attempt-evidence.js';
import { bothKeys, withSeedsNamedByMount } from './r13-seed-named-by-mount.js';
import { withoutReadWindowsText } from './read-window-law.js';

const here = dirname(fileURLToPath(import.meta.url));

type Linked = Record<string, any>;

/**
 * The 12.0.0 list form — the named shape change every older reference predates: a tree is the run's stages
 * in the order they ran, and a fork's (or a decider's) children are `branches`, one list each, the last key
 * of the stage. A reference is never regenerated (it exists to be old), so its linked trees (`next` /
 * `children`) are read in the list form here: every other byte stays the reference's own.
 */
function listForm(head: Linked | undefined): Linked[] {
  const stages: Linked[] = [];
  for (let node = head; node; node = node.next) {
    const { next: _next, children, ...self } = node;
    stages.push(children ? { ...self, branches: (children as Linked[]).map((child) => listForm(child)) } : self);
  }
  return stages;
}

/** Every linked `executionTree` / subflow `stageContexts` of a parsed reference, in the list form, in place. */
function withListTrees(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (
      (key === 'executionTree' || key === 'stageContexts') &&
      child &&
      typeof child === 'object' &&
      !Array.isArray(child)
    )
      (value as Linked)[key] = listForm(child as Linked);
    else withListTrees(child);
  }
}

/** A mount's node path in the linked form (`executionTree`, then one `next` per stage) as a list index. */
function listPath(path: readonly (string | number)[]): (string | number)[] {
  const out: (string | number)[] = [];
  for (let i = 0; i < path.length; i++) {
    out.push(path[i]);
    if (path[i] !== 'executionTree' || typeof path[i + 1] === 'number') continue;
    let index = 0;
    while (path[i + 1] === 'next') {
      index += 1;
      i += 1;
    }
    out.push(index);
  }
  return out;
}
const MAPPER_READS = UNTAGGED_MAPPER_READS.map((mount) => ({ ...mount, node: listPath(mount.node) }));
/** The original bytes with only the named seed attribution and narrative corrections. */
function reference(encoding: 'full' | 'delta'): string {
  const parsed = JSON.parse(
    withSeedsNamedByMount(
      readFileSync(join(here, 'reference', `untagged-9.20.0.${encoding}.json`), 'utf8'),
      bothKeys(['paused'], 'sf', { stage: 'Sub', stageId: 'sf', runtimeStageId: 'sf#9' }),
    ),
  );
  // L1 — the lean checkpoint (format 2): the stored checkpoint is what the ONE
  // codec reads it as. `upcastCheckpoint` drops `executionTree` and
  // `subflowResults` — records no resume read; every other byte stays 9.20.0's
  // (the format key itself is taken out of the build's bytes, f8-recorded-phases).
  const { checkpointVersion: _format, ...lean } = upcastCheckpoint(parsed.checkpoint);
  parsed.checkpoint = lean;
  // C2: the original fresh resume had only standalone stage sentences (and
  // C1 removed its duplicate transition). It now starts the enabled combined
  // narrator. Pin the whole corrected resumed leg; all other bytes stay intact.
  // D5: the resumed stage's header no longer re-announces its arrival.
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
      text: 'Stage 1: It continued from the pause.',
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
  // P1a (10.1): the retried Flaky stage's attempt evidence — on its tree node, and as attempt lines.
  withAttemptEvidence(parsed);
  // 12.0.0: the trees in the list form.
  withListTrees(parsed);
  // C2 (10.2): only the already recorded retry gains a proof-backed attention projection.
  const flaky = parsed.paused.executionTree[2];
  expect(flaky.id).toBe('flaky');
  expect(flaky.attempts).toHaveLength(3);
  expect(Object.hasOwn(flaky, 'attention')).toBe(false);
  parsed.paused.executionTree[2] = {
    ...flaky,
    attention: [{ kind: 'retried', reason: 'RETRY_RECORDED', evidence: ['flaky#2@1', 'flaky#2@2', 'flaky#2@3'] }],
  };
  return JSON.stringify(parsed, null, 2);
}

/**
 * The build's bytes with the named laws the old reference predates taken out: the read windows (first, while
 * the `phase` they are checked against is still there), F8, then the mapper reads.
 */
async function build(encoding: 'full' | 'delta'): Promise<string> {
  const windowless = withoutReadWindowsText(await runUntaggedFixture(encoding), UNTAGGED_READ_WINDOWS);
  const bytes = withoutRecordedPhases(windowless);
  return withSettledAttemptDurations(withoutMapperReadsText(bytes, MAPPER_READS));
}

describe('declared tags — 9.20.0 bytes except named record and narrative corrections', () => {
  it('commitValues: full', async () => {
    expect(await build('full')).toBe(reference('full'));
  });

  it('commitValues: delta', async () => {
    expect(await build('delta')).toBe(reference('delta'));
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
    // …and no read window: 9.20.0 could not write one (the build's are asserted and taken out in build()).
    expect(reference('full')).not.toMatch(/"beganAt"|"sawUntil"/);
    expect(reference('delta')).not.toMatch(/"beganAt"|"sawUntil"/);
  });
});
