/**
 * Record bytes — each scenario (./scenarios.ts) re-run and compared, byte for
 * byte, with the bytes pinned on footprintjs 9.44.1 in ./pinned/. A difference
 * is a bug or a named law fix — never a refactor (../README.md, the re-pin policy).
 *
 * Test types: Byte-identity (every scenario, the whole served record) ·
 * Contract (the pinned set is exactly the scenario set).
 *
 * Re-pin, for a named law fix only: RECORD_BYTES_REPIN=1 npx vitest run test/fixtures/record-bytes
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { pinnedText } from '../bytes.js';
import { SCENARIOS } from './scenarios.js';

const PINNED = join(dirname(fileURLToPath(import.meta.url)), 'pinned');
const REPIN = process.env.RECORD_BYTES_REPIN === '1';

describe('record bytes — flowchart scenarios pinned on 9.44.1', () => {
  it.each(Object.keys(SCENARIOS))('%s reproduces its pinned bytes', async (name) => {
    const text = pinnedText(await SCENARIOS[name]!());
    const file = join(PINNED, `${name}.json`);
    if (REPIN) writeFileSync(file, text);
    expect(text).toBe(readFileSync(file, 'utf8'));
  });

  it('pins every scenario, and nothing that is not one', () => {
    const pinned = readdirSync(PINNED).map((f) => f.replace(/\.json$/, ''));
    expect(pinned.sort()).toEqual(Object.keys(SCENARIOS).sort());
  });
});
