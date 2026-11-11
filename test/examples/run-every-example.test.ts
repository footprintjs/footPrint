/**
 * Every example runs. `tsc -p examples/tsconfig.json` only type-checks them, and a broken example can
 * type-check: this test runs each `examples/**\/*.ts` file in its own child process, the way a reader
 * would, and expects exit code 0 and no line starting with `REGRESSION` (the examples' own guards).
 *
 * The examples import `footprintjs`, which resolves to `dist/`, so this test runs only from
 * `npm run test:every-example` (vitest.every-example.config.ts), after a build. It never builds.
 * It has its own run because five example processes at a time starve a timed test that shares
 * the worker pool. A new example is picked up without a test edit.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, resolve as resolvePath, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { minimalChildEnv } from '../helpers/childProcessEnv.js';

const ROOT = resolvePath(__dirname, '../..');
const EXAMPLES = join(ROOT, 'examples');
const TIMEOUT_MS = 60_000;

/**
 * Examples that cannot run unattended (a key, a network service or user input), each with its reason.
 * Keep it as small as the truth allows. The files `examples/tsconfig.json` excludes are skipped too:
 * they import an external SDK this repository does not install.
 */
const CANNOT_RUN_UNATTENDED: ReadonlyMap<string, string> = new Map<string, string>([]);

/** The files `examples/tsconfig.json` leaves out, as repo paths. */
function excludedByTsconfig(): Set<string> {
  const config = JSON.parse(readFileSync(join(EXAMPLES, 'tsconfig.json'), 'utf8')) as { exclude?: string[] };
  return new Set((config.exclude ?? []).map((file) => posix.join('examples', file)));
}

/** Every example to run: each `.ts` file under `examples/`, not a declaration file, not excluded. */
function examples(): string[] {
  const excluded = excludedByTsconfig();
  return readdirSync(EXAMPLES, { recursive: true, encoding: 'utf8' })
    .map((file) => posix.join('examples', file.split(sep).join('/')))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .filter((file) => !excluded.has(file) && !CANNOT_RUN_UNATTENDED.has(file))
    .sort();
}

interface Outcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Runs one example from the repo root, as `read-sources-example.test.ts` does, but without blocking. */
function runExample(file: string): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve('tsx/cli'), file], {
      cwd: ROOT,
      env: minimalChildEnv(process.env),
      timeout: TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

const FOUND = examples();

describe('the example list', () => {
  it('has a built package to run against', () => {
    expect(existsSync(join(ROOT, 'dist/index.js')), 'dist missing: run npm run build first').toBe(true);
  });

  it('finds the examples, so an empty glob cannot pass', () => {
    expect(FOUND.length).toBeGreaterThan(100);
  });

  it('skips only files that exist', () => {
    for (const file of [...CANNOT_RUN_UNATTENDED.keys(), ...excludedByTsconfig()])
      expect(existsSync(join(ROOT, file)), file).toBe(true);
  });
});

describe.concurrent('every example runs', () => {
  it.each(FOUND)(
    '%s',
    async (file) => {
      const { status, signal, stdout, stderr } = await runExample(file);
      const output = `${stdout}\n${stderr}`;
      expect({ status, signal }, output).toEqual({ status: 0, signal: null });
      expect(
        output.split('\n').filter((line) => line.startsWith('REGRESSION')),
        output,
      ).toEqual([]);
    },
    TIMEOUT_MS + 5_000,
  );
});
