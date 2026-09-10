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
 * byte. Volatile fields (timestamps, run ids, `pausedAt`) are dropped on both
 * sides.
 *
 * To regenerate after an INTENDED untagged change, run the fixture on the
 * old tag and replace the files — never on the new code.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runUntaggedFixture } from './declared-tags-untagged-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const reference = (encoding: 'full' | 'delta') =>
  readFileSync(join(here, 'reference', `untagged-9.20.0.${encoding}.json`), 'utf8');

describe('declared tags — an untagged chart is byte-identical to 9.20.0', () => {
  it('commitValues: full', async () => {
    expect(await runUntaggedFixture('full')).toBe(reference('full'));
  });

  it('commitValues: delta', async () => {
    expect(await runUntaggedFixture('delta')).toBe(reference('delta'));
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
