import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { admitPlan, requireRanges, buildOrder, verifyHead } from './index.mjs';

const { family } = JSON.parse(readFileSync('scripts/family.json', 'utf8'));
export const fixture = () => ({
  schema: 1,
  engineVersion: '13.0.0-rc.0',
  consumers: family
    .filter((row) => row.checks)
    .map((row) => ({
      package: row.package,
      pr: 1,
      head: 'a'.repeat(40),
      siblings: (row.siblings ?? []).map((s) => ({ package: s.dir, pr: 1, head: 'a'.repeat(40) })),
    })),
  packages: [],
  registry: [{ package: 'foottrace', version: '2.0.0-rc.0', integrity: `sha512-${'A'.repeat(86)}==` }],
});
const admit = (plan) => admitPlan(Buffer.from(JSON.stringify(plan)), family, '12.3.0');

describe('closed source-cohort input', () => {
  it('accepts the complete fixed family, exact RC and one repository head', () => {
    expect(admit(fixture()).consumers).toHaveLength(7);
  });
  it.each([
    (p) => {
      p.command = 'skip tests';
    },
    (p) => {
      p.schema = 2;
    },
    (p) => {
      p.engineVersion = '13.0.0';
    },
    (p) => {
      p.engineVersion = '14.0.0-rc.0';
    },
    (p) => {
      p.consumers.pop();
    },
    (p) => {
      p.consumers.push(p.consumers[0]);
    },
    (p) => {
      p.consumers[0].package = 'foreign';
    },
    (p) => {
      p.consumers[0].head = 'main';
    },
    (p) => {
      p.consumers[0].repo = 'someone/else';
    },
    (p) => {
      p.consumers.find((r) => r.siblings.length).siblings = [];
    },
    (p) => {
      p.consumers.find((r) => r.siblings.length).siblings[0].head = 'b'.repeat(40);
    },
    (p) => {
      p.registry = [];
    },
    (p) => {
      p.registry[0].integrity = 'sha512-wrong';
    },
    (p) => {
      p.registry[0].package = 'foreign';
    },
    (p) => {
      p.packages = [{ package: 'foreign', version: '1.0.0', pr: 1, head: 'a'.repeat(40) }];
    },
  ])('refuses malformed, incomplete or conflicting selections', (mutate) => {
    const plan = fixture();
    mutate(plan);
    expect(() => admit(plan)).toThrow();
  });
  it('does not let ordinary stable ranges admit an RC, or old Foottrace pins disappear', () => {
    const chosen = new Map([
      ['footprintjs', { version: '13.0.0-rc.0' }],
      ['foottrace', { version: '2.0.0-rc.0' }],
    ]);
    const names = new Set(chosen.keys());
    expect(() => requireRanges({ peerDependencies: { footprintjs: '^13.0.0' } }, chosen, names)).toThrow();
    expect(() => requireRanges({ dependencies: { foottrace: '^1.16.0' } }, chosen, names)).toThrow();
    expect(() => requireRanges({ peerDependencies: { footprintjs: '^13.0.0-rc.0' } }, chosen, names)).not.toThrow();
    expect(() => requireRanges({ devDependencies: { foottrace: '^1.16.0' } }, chosen, names, false)).not.toThrow();
  });
  it('builds actual producer edges first and refuses a cycle or missing manifest', () => {
    const rows = [{ package: 'lens' }, { package: 'af' }];
    const manifests = new Map([
      ['lens', { peerDependencies: { af: '*' } }],
      ['af', {}],
    ]);
    expect(buildOrder(rows, manifests).map((r) => r.package)).toEqual(['af', 'lens']);
    manifests.get('af').dependencies = { lens: '*' };
    expect(() => buildOrder(rows, manifests)).toThrow('cycle');
    expect(() => buildOrder(rows, new Map())).toThrow('missing');
  });
  it('checks the real fixed PR endpoint and refuses moved, unreadable and foreign heads', async () => {
    const row = { pr: 2, head: 'a'.repeat(40) };
    const body = {
      state: 'open',
      head: { sha: row.head, repo: { full_name: 'footprintjs/agentfootprint' } },
      base: { repo: { full_name: 'footprintjs/agentfootprint' } },
    };
    const get = async (url) => {
      expect(url).toBe('https://api.github.com/repos/footprintjs/agentfootprint/pulls/2');
      return { ok: true, json: async () => body };
    };
    await verifyHead('footprintjs/agentfootprint', row, get);
    body.head.sha = 'b'.repeat(40);
    await expect(verifyHead('footprintjs/agentfootprint', row, get)).rejects.toThrow('moved');
    await expect(
      verifyHead('footprintjs/agentfootprint', row, async () => ({ ok: false, status: 404 })),
    ).rejects.toThrow('404');
  });
});
