import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { matchesGlob, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { defaultInclude } from 'vitest/config';

import { runExample } from '../../../examples/runtime-features/pause-resume/durable-sqlite/host.cjs';
import { minimalChildEnv } from '../../helpers/childProcessEnv.js';

const NODE_CHECKS = ['store.node-check.cjs', 'identity.node-check.cjs', 'codes.node-check.cjs'];

describe('native checkpoint with the private transactional host example', () => {
  it('keeps Node runner checks out of default Vitest discovery when examples are copied', () => {
    const directory = resolve(__dirname, '../../../examples/runtime-features/pause-resume/durable-sqlite');
    const files = readdirSync(directory, { recursive: true });
    const discovered = (names: string[]) =>
      names.filter((name) => defaultInclude.some((pattern) => matchesGlob(`src/samples/${name}`, pattern)));
    expect(discovered(files)).toEqual([]);
    expect(discovered(['store.test.cjs', 'identity.test.cjs', 'codes.test.cjs'])).toHaveLength(3);
    expect(files.filter((name) => name.endsWith('.node-check.cjs')).sort()).toEqual([...NODE_CHECKS].sort());
  });

  it('runs the adjacent store contract and actual broken-policy variants', () => {
    const directory = resolve(__dirname, '../../../examples/runtime-features/pause-resume/durable-sqlite');
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', ...NODE_CHECKS.map((name) => resolve(directory, name))],
      {
        env: minimalChildEnv(process.env),
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 256 * 1024,
      },
    );
    expect({ status: result.status, signal: result.signal }).toEqual({ status: 0, signal: null });
    expect(Number(result.stdout.match(/# pass (\d+)/)?.[1] ?? 0)).toBe(29);
    expect(result.stdout).toMatch(/# fail 0/);
    expect(result.stdout).toMatch(/# skipped 0/);
  });

  it('resumes in fresh workers and retains refusal and replay boundaries', async () => {
    const report = await runExample({ mode: 'source' });
    expect(report.mode).toBe('source');
    expect(report.cases.map((entry) => entry.case)).toEqual([
      'reply',
      'timer',
      'checkpoint-program-sdk-format-refusals',
      'crash-after-native-effect',
      'stale-after-native-effect',
      'expiry-next-pause-native-failure',
    ]);
    expect(report.cases[0]).toMatchObject({ freshProcess: true, newNativeRunId: true, retainedPausedLink: true });
    expect(report.cases[3]).toMatchObject({
      physicalSyntheticEffects: 2,
      logicalTasks: 1,
      exactlyOnceOutsideExecution: false,
    });
    expect(report.privateScratchRemoved).toBe(true);
    expect(report.ownedChildrenExited).toBeGreaterThan(30);
    expect(JSON.stringify(report)).not.toContain('PRIVATE-NATIVE-CHECKPOINT-SENTINEL');
  }, 120_000);
});
