import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { minimalChildEnv } from '../../../helpers/childProcessEnv';

const projectRoot = resolve(__dirname, '../../../..');

describe('built public terminal failure example', () => {
  it.each([
    ['CommonJS', false],
    ['CommonJS', true],
    ['ESM', false],
    ['ESM', true],
  ] as const)('keeps unresolved effects unknown from %s into the other module format (policy=%s)', (format, policy) => {
    const script = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import * as esm from 'footprintjs';
      const cjs = createRequire(import.meta.url)('footprintjs');
      const origin = ${format === 'CommonJS' ? 'cjs' : 'esm'};
      const host = ${format === 'CommonJS' ? 'esm' : 'cjs'};
      const raw = new origin.UnknownEffectError({system:'synthetic',attempts:1,
        cause:Object.assign(new Error('synthetic private cause'),{code:'ECONNRESET'})});
      assert.equal(raw instanceof host.UnknownEffectError, false);
      let builder = host.flowChart('Mixed',()=>{throw raw;},'mixed');
      if (${policy}) builder = builder.retry({attempts:1,timeoutMs:1000});
      const executor = new host.FlowChartExecutor(builder.setLogger({info(){},log(){},debug(){},warn(){},error(){}}).build());
      await assert.rejects(executor.run(), error => error === raw);
      assert.equal(executor.getFailureContext().category, 'unknown');
      assert.equal(executor.getFailureContext().stage.runtimeStageId, 'mixed#0');
      console.log('mixed-module unknown effect PASS');
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: projectRoot,
      env: minimalChildEnv(process.env),
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(output).toContain('mixed-module unknown effect PASS');
  });

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
