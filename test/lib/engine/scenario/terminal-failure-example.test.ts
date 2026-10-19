import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { minimalChildEnv } from '../../../helpers/childProcessEnv';

const projectRoot = resolve(__dirname, '../../../..');

describe('built public terminal failure example', () => {
  it('uses native context without joining retry events or calling a model', () => {
    const output = execFileSync(
      process.execPath,
      [
        resolve(projectRoot, 'node_modules/tsx/dist/cli.mjs'),
        resolve(projectRoot, 'examples/errors/04-terminal-failure-context.ts'),
      ],
      { cwd: projectRoot, env: minimalChildEnv(process.env), encoding: 'utf8', stdio: 'pipe', timeout: 10000 },
    );
    const context = JSON.parse(output.split('\n')[0]);
    expect(context).toEqual({ category: 'server', stage: { runId: expect.any(String), runtimeStageId: 'payment#1' } });
    expect(output).toContain('✓ native failure category and identity survive masking; unowned failures stay unknown');
    expect(output).not.toContain('synthetic private payment detail');
  }, 10000);
});
