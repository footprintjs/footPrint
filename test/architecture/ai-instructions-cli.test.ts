/** The real CLI must preserve checked files, write complete outputs, and fail before a partial regeneration. */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

const REPO = resolve(__dirname, '../..');
const CLI = join(REPO, 'scripts/ai-instructions/generate.mjs');
const SOURCE = 'ai-instructions/source';
const targets = JSON.parse(readFileSync(join(REPO, SOURCE, 'targets.json'), 'utf8')) as { output: string }[];
const expected = new Map(targets.map(({ output }) => [output, readFileSync(join(REPO, output), 'utf8')]));
const copies: string[] = [];

afterEach(() => {
  for (const path of copies.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Only generated paths are writable copies; links let the checker read the real task pages and API facts. */
function copyOfFiles(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-instructions-cli-'));
  copies.push(root);
  cpSync(join(REPO, 'ai-instructions'), join(root, 'ai-instructions'), { recursive: true });
  cpSync(join(REPO, 'AGENTS.md'), join(root, 'AGENTS.md'));
  for (const linked of ['docs', 'examples', 'src', 'node_modules']) symlinkSync(join(REPO, linked), join(root, linked));
  return root;
}

const outputBytes = (root: string) =>
  new Map(
    targets.map(({ output }) => {
      const path = join(root, output);
      return [output, existsSync(path) ? readFileSync(path, 'utf8') : undefined] as const;
    }),
  );

interface CLIResult {
  status: number | string | undefined | null;
  stdout: string;
  stderr: string;
}

/** The same entry guard as `node generate.mjs`; no private CLI function or exported test seam. */
async function inProcess(args: string[]): Promise<CLIResult> {
  const argv = process.argv;
  const exitCode = process.exitCode;
  const actions = process.env.GITHUB_ACTIONS;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    process.argv = [process.execPath, CLI, ...args];
    process.exitCode = undefined;
    process.env.GITHUB_ACTIONS = 'true';
    vi.resetModules();
    await import(CLI);
    return {
      status: process.exitCode,
      stdout: log.mock.calls.map((parts) => parts.join(' ')).join('\n'),
      stderr: error.mock.calls.map((parts) => parts.join(' ')).join('\n'),
    };
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    if (actions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = actions;
    log.mockRestore();
    error.mockRestore();
  }
}

function childProcess(args: string[]): CLIResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Entry-point and real-process controls must enforce the same filesystem and reporting contract.
describe.each([
  ['entry point', inProcess],
  ['child process', childProcess],
] as const)('AI instruction CLI — %s', (_name, run) => {
  it('generates every missing output and reports its byte count as an estimated token size', async () => {
    const root = copyOfFiles();
    for (const { output } of targets) rmSync(join(root, output));

    const result = await run(['--root', root]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('ai:generate: OK');
    expect(outputBytes(root)).toEqual(expected);
    for (const [output, text] of expected) {
      const summary = result.stdout.split('\n').find((line) => line.startsWith(`  ${output}:`));
      expect(summary).toContain(`${Buffer.byteLength(text)} bytes`);
      expect(summary).toMatch(/about \d+(?:\.\d+)?k tokens \(estimate\)$/);
    }
  }, 20_000);

  it('reports drift and a missing file without rewriting or recreating either during --check', async () => {
    const root = copyOfFiles();
    const agents = join(root, 'AGENTS.md');
    writeFileSync(agents, `${readFileSync(agents, 'utf8')}\nRetain this hand edit for review.\n`);
    rmSync(join(root, 'ai-instructions/clinerules'));
    const before = outputBytes(root);

    const result = await run(['--check', '--root', root]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('AGENTS.md drift:');
    expect(result.stderr).toContain('ai-instructions/clinerules drift:');
    expect(result.stderr).toContain('npm run ai:generate');
    expect(result.stdout).toContain('::warning file=AGENTS.md::drift:');
    expect(result.stdout).toContain('::warning file=ai-instructions/clinerules::drift:');
    expect(outputBytes(root)).toEqual(before);
  }, 20_000);

  it('keeps all existing outputs untouched when a source cannot render, even in write mode', async () => {
    const root = copyOfFiles();
    const path = join(root, SOURCE, 'instructions.md');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n{{snippet:missing-cli-witness}}\n`);
    writeFileSync(join(root, 'AGENTS.md'), 'Keep this output until the source is fixed.\n');
    rmSync(join(root, 'ai-instructions/clinerules'));
    const before = outputBytes(root);

    const result = await run(['--root', root]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ai:generate: FAIL: unknown placeholder {{snippet:missing-cli-witness}}');
    expect(result.stdout).toBe('');
    expect(outputBytes(root)).toEqual(before);
  }, 20_000);
});

it('restores process arguments, exit status, action mode and console methods after entry-point execution', async () => {
  const before = {
    argv: process.argv,
    exitCode: process.exitCode,
    actions: process.env.GITHUB_ACTIONS,
    log: console.log,
    error: console.error,
  };
  const root = mkdtempSync(join(tmpdir(), 'ai-instructions-cli-missing-'));
  copies.push(root);

  const result = await inProcess(['--check', '--root', root]);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain('check:ai-instructions: FAIL:');
  expect(outputBytes(root)).toEqual(new Map(targets.map(({ output }) => [output, undefined])));
  expect(process.argv).toBe(before.argv);
  expect(process.exitCode).toBe(before.exitCode);
  expect(process.env.GITHUB_ACTIONS).toBe(before.actions);
  expect(console.log).toBe(before.log);
  expect(console.error).toBe(before.error);
});
