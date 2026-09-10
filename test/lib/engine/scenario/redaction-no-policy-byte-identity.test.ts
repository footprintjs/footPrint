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

import { runNoPolicyFixture } from './redaction-no-policy-fixture.js';

const here = dirname(fileURLToPath(import.meta.url));
const reference = (encoding: 'full' | 'delta') =>
  readFileSync(join(here, 'reference', `no-policy-9.18.1.${encoding}.json`), 'utf8');

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
