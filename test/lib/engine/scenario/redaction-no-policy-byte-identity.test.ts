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
 * dropped by `stableJSON` on both sides.
 *
 * To regenerate after an INTENDED no-policy change, run the fixture on the
 * old tag and replace the files — never on the new code.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNoPolicyFixture, runNoPolicyRedactViewFixture } from './redaction-no-policy-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const reference = (encoding: 'full' | 'delta') =>
  readFileSync(join(here, 'reference', `no-policy-9.18.1.${encoding}.json`), 'utf8');
const redactViewReference = (encoding: 'full' | 'delta') =>
  readFileSync(join(here, 'reference', `no-policy-redact-view-9.19.1.${encoding}.json`), 'utf8');

describe('redaction — no policy, no change (byte-identical to 9.18.1)', () => {
  it('commitValues: full', async () => {
    expect(await runNoPolicyFixture('full')).toBe(reference('full'));
  });

  it('commitValues: delta', async () => {
    expect(await runNoPolicyFixture('delta')).toBe(reference('delta'));
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
    expect(await runNoPolicyRedactViewFixture('full')).toBe(redactViewReference('full'));
  });

  it('commitValues: delta', async () => {
    expect(await runNoPolicyRedactViewFixture('delta')).toBe(redactViewReference('delta'));
  });

  it('the reference is the RAW subflow heap — plaintext, served as the plain snapshot is', () => {
    const full = JSON.parse(redactViewReference('full'));
    expect(JSON.stringify(full.subflowResults)).toContain('tok-1');
    expect(JSON.stringify(full)).not.toContain('REDACTED');
    // No mirror → the runtime serves the plain view, fold base included.
    expect(full.initialState).toEqual({});
  });
});
