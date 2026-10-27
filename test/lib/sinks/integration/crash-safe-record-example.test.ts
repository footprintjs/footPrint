/**
 * Example 01, RUN — `examples/runtime-features/crash-safe-record/01-sink-and-incomplete-run.ts` asserts its own
 * invariants (a file-sink run reads back complete with the live commits; a run still in flight reads incomplete,
 * with its landed commit and the attempts of the stage that never committed; no redacted value reaches the sink)
 * and exits non-zero on any violation; this test shells out to it and reads the exit code and the closing line.
 *
 * Test types: Integration (the example against the BUILT package).
 *
 * The example imports `footprintjs`, which resolves to `dist/`, so this runs only from `npm run test:examples`
 * (vitest.examples.config.ts builds first); it never builds itself.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { captureHistoryExample } from '../../../../examples/runtime-features/crash-safe-record/02-capture-history.js';
import { exactReadHistoryExample } from '../../../../examples/runtime-features/crash-safe-record/03-exact-read-history.js';

const projectRoot = resolve(__dirname, '../../../..');
const example = resolve(projectRoot, 'examples/runtime-features/crash-safe-record/01-sink-and-incomplete-run.ts');

describe('examples/runtime-features/crash-safe-record/01-sink-and-incomplete-run.ts', () => {
  it('runs cleanly: stored, incomplete when unfinished, never a secret', () => {
    if (!existsSync(resolve(projectRoot, 'dist/sinks.js'))) {
      throw new Error('dist/ is missing — run this through `npm run test:examples`, which builds first.');
    }
    const output = execFileSync('npx', ['tsx', example], { encoding: 'utf8', stdio: 'pipe', timeout: 30_000 });
    expect(output).toContain('✓ the record outlives the run: stored, incomplete when unfinished, never a secret');
    expect(output).toContain('complete: false (no closing entry), commits landed: 1');
    expect(output).toContain('attempts of the stage that never committed: #1 failed, #2 failed');
  }, 30_000);
});

it('runs the public capture-history example locally with the built package', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fp-history-example-'));
  try {
    await captureHistoryExample(join(directory, 'record.jsonl'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('runs the public exact-source history example against the built package', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fp-source-history-example-'));
  try {
    const stored = await exactReadHistoryExample(join(directory, 'record.jsonl'));
    expect(stored.status).toBe('acknowledged');
    if (stored.status !== 'acknowledged') throw new Error('Source history was not acknowledged');
    expect(stored.history.capture.version).toBe(2);
    expect(stored.history.readSources?.persistence).toBe('memory-only');
    expect(stored.history.readSources?.record?.occurrences.map((row) => row.source.kind)).toEqual([
      'base',
      'committed',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('runs the indexed public scope-loading example against the built package', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fp-indexed-example-'));
  try {
    const { indexedScopeExample } = await import(
      '../../../../examples/runtime-features/crash-safe-record/04-indexed-scope-loading.js'
    );
    const result = await indexedScopeExample(join(directory, 'record.jsonl'));
    expect(result.capture).toBe('acknowledged');
    expect(result.scopes).toBe(1);
    expect(result.confidence).toBe('incomplete');
    expect(result.selectedBytes).toBeLessThan(result.preparationBytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
