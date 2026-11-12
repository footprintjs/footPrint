/**
 * The no-policy half of the 9.19.0 redaction law: a consumer that sets NO
 * redaction policy sees NO change.
 *
 * `reference/no-policy-9.18.1.{full,delta}.json` are the bytes the fixture
 * chart produced on the 9.18.1 code (generated on 2026-09-10 by running
 * `runNoPolicyFixture` on the `v9.18.1` tag, twice, and checking the two runs
 * agreed). The same fixture, run on the current code, must reproduce them —
 * snapshot state, commit log under BOTH encodings, execution tree (reads and
 * writes retention), subflow results (seed commit and merge-back), and every
 * narrative entry, byte for byte. Volatile fields (timestamps, run ids) are
 * dropped by `stableJSON` on both sides. The one shape change, 12.0.0's list
 * form of the trees, is applied to the references (`withListTrees`).
 *
 * To regenerate after an INTENDED no-policy change, run the fixture on the
 * old tag and replace the files — never on the new code.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutRecordedPhases } from './f8-recorded-phases.js';
import { type MountReads, withoutMapperReadsText } from './mapper-reads-law.js';
import { bothKeys, withSeedsNamedByMount } from './r13-seed-named-by-mount.js';
import { runNoPolicyFixture, runNoPolicyRedactViewFixture } from './redaction-no-policy-fixture.js';

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

/** The reference's text with its trees in the list form, re-serialised in the same layout. */
function withListTreesText(json: string): string {
  const space = json.includes('\n') ? 2 : undefined;
  const parsed = JSON.parse(json);
  withListTrees(parsed);
  return JSON.stringify(parsed, null, space);
}

/** The one named R13 change on both references: the subflow's seed names its mount. */
const SEED = bothKeys([], 'sf', { stage: 'Sub', stageId: 'sf', runtimeStageId: 'sf#2' });
const reference = (encoding: 'full' | 'delta') =>
  withListTreesText(
    withSeedsNamedByMount(readFileSync(join(here, 'reference', `no-policy-9.18.1.${encoding}.json`), 'utf8'), SEED),
  );
const redactViewReference = (encoding: 'full' | 'delta') =>
  withListTreesText(
    withSeedsNamedByMount(
      readFileSync(join(here, 'reference', `no-policy-redact-view-9.19.1.${encoding}.json`), 'utf8'),
      SEED,
    ),
  );

/**
 * The mount-reads law (`mapper-reads-law.ts`), the same on both fixtures: the Sub mount (`sf#2`, the third
 * node) reads `profile`, `tags` and `count` in its inputMapper — after Touch: profile { name: 'Ada L.', auth },
 * tags ['a', 'b'], count 4. The run keeps full reads, so each entry is a copy of the value. Its outputMapper
 * reads only the subflow's output. Its merge-back reads `tags` (an array, appended) and `profile` (a plain
 * object, merged) again: each keeps its first place and holds the copy of that second read, the same one,
 * since the parent's values have not changed in between. No reads-prefix, so no `readKeys`.
 */
const MAPPER_READS: readonly MountReads[] = [
  {
    node: ['executionTree', 2],
    runtimeStageId: 'sf#2',
    reads: [
      { key: 'profile', retained: { name: 'Ada L.', auth: { token: 'tok-1' } } },
      { key: 'tags', retained: ['a', 'b'] },
      { key: 'count', retained: 4 },
    ],
  },
];
/** The build's bytes with the named laws the old references predate taken out: F8, then the mapper reads. */
const build = (bytes: string) => withoutMapperReadsText(withoutRecordedPhases(bytes), MAPPER_READS);

describe('redaction — no policy, no change (byte-identical to 9.18.1)', () => {
  it('commitValues: full', async () => {
    expect(build(await runNoPolicyFixture('full'))).toBe(reference('full'));
  });

  it('commitValues: delta', async () => {
    expect(build(await runNoPolicyFixture('delta'))).toBe(reference('delta'));
  });

  it('the reference itself is what it claims — plaintext everywhere, nothing redacted', () => {
    const full = JSON.parse(reference('full'));
    expect(JSON.stringify(full)).toContain('tok-1');
    expect(JSON.stringify(full)).not.toContain('REDACTED');
    expect(full.report).toEqual({ redactedKeys: [], fieldRedactions: {}, patterns: [] });
  });
});

/**
 * The 9.20.0 half: the SERVED view. `getSnapshot({ redact: true })` now serves
 * each subflow's own mirror — but a run with no policy keeps no mirror, at
 * the run level or in any subflow, so its served view (state, fold base,
 * log, tree, subflow results) must be byte-identical to what 9.19.1 served.
 * `reference/no-policy-redact-view-9.19.1.{full,delta}.json` were generated
 * on 2026-09-10 by running `runNoPolicyRedactViewFixture` on the 9.19.1 tree
 * (fd458f4) BEFORE the 9.20.0 source edits, twice, and checking the two runs
 * agreed. Regenerate only from the old code, never from the new.
 */
describe('redaction — no policy, no mirror: the served view is byte-identical to 9.19.1', () => {
  it('commitValues: full', async () => {
    expect(build(await runNoPolicyRedactViewFixture('full'))).toBe(redactViewReference('full'));
  });

  it('commitValues: delta', async () => {
    expect(build(await runNoPolicyRedactViewFixture('delta'))).toBe(redactViewReference('delta'));
  });

  it('the reference is the RAW subflow heap — plaintext, served as the plain snapshot is', () => {
    const full = JSON.parse(redactViewReference('full'));
    expect(JSON.stringify(full.subflowResults)).toContain('tok-1');
    expect(JSON.stringify(full)).not.toContain('REDACTED');
    // No mirror → the runtime serves the plain view, fold base included.
    expect(full.initialState).toEqual({});
  });
});
