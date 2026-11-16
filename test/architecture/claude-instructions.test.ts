import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const instructions = readFileSync(resolve(__dirname, '../../CLAUDE.md'), 'utf8');

describe('the contributor instruction entry point', () => {
  it('stays within 200 lines', () => {
    expect(instructions.trimEnd().split(/\r?\n/).length).toBeLessThanOrEqual(200);
  });

  it('cannot hide a book inside a few long lines', () => {
    expect(Buffer.byteLength(instructions, 'utf8')).toBeLessThanOrEqual(20_000);
    expect(Math.max(...instructions.split(/\r?\n/).map((line) => line.length))).toBeLessThanOrEqual(500);
  });
});
