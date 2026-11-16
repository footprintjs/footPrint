import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCohort } from './index.mjs';
import { admitPlan } from './plan/index.mjs';

describe('fixed baseline audit chart', () => {
  it('chooses the real pack/audit stages and rejects invalid mode before effects', async () => {
    const family = JSON.parse(readFileSync('scripts/family.json', 'utf8')).family;
    const plan = {
      schema: 1,
      engineVersion: '13.0.0-rc.0',
      consumers: family
        .filter((r) => r.checks)
        .map((r) => ({
          package: r.package,
          pr: 1,
          head: 'a'.repeat(40),
          siblings: (r.siblings ?? []).map((s) => ({ package: s.dir, pr: 1, head: 'a'.repeat(40) })),
        })),
      packages: [],
      registry: [{ package: 'foottrace', version: '2.0.0-rc.0', integrity: `sha512-${'A'.repeat(86)}==` }],
    };
    let produced = 0;
    const input = {
      mode: 'pack',
      family,
      planBytes: Buffer.from(JSON.stringify(plan)),
      context: { manifest: { version: '12.3.0' } },
    };
    const result = await runCohort(input, {
      admitPlan,
      produce: async () => {
        produced++;
      },
    });
    expect(result.completed).toBe(true);
    expect(produced).toBe(1);
    input.mode = 'unknown';
    await expect(
      runCohort(input, {
        admitPlan,
        produce: async () => {
          produced++;
        },
      }),
    ).rejects.toThrow('unsupported');
    input.mode = 'pack';
    input.planBytes = Buffer.from('{}');
    await expect(
      runCohort(input, {
        admitPlan,
        produce: async () => {
          produced++;
        },
      }),
    ).rejects.toThrow();
    expect(produced).toBe(1);
  });
});
