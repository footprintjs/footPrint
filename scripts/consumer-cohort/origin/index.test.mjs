import { describe, expect, it } from 'vitest';
import { sourceStrategy, sourceOrigin, verifySourceOrigin, needsCollisionCheck } from './index.mjs';
const row = { package: 'agentfootprint', pr: 383, head: 'a'.repeat(40), version: '15.0.0-rc.0' };
const recipe = { repo: 'footprintjs/agentfootprint' };
const manifest = { name: row.package, version: '14.7.2', peerDependencies: { footprintjs: '^13.0.0-rc.0' } };
const original = Buffer.from(JSON.stringify(manifest) + '\n');
const projected = { ...manifest, version: row.version };
describe('source origin and native version strategy', () => {
  it('admits only the AF native one-bump RC and unchanged authored versions', () => {
    expect(sourceStrategy(row.package, manifest.version, row.version)).toBe('agentfootprint-native-rc-after-build');
    expect(sourceStrategy('footprint-storydeck', '0.13.3', '0.13.3')).toBe('authored');
    for (const [name, version] of [
      ['agentfootprint', '16.0.0-rc.0'],
      ['agentfootprint', '15.0.0'],
      ['agentfootprint', '15.0.0-beta.0'],
      ['agentfootprint', '15.0.0-rc.0+tag'],
      ['agentfootprint-lens', '15.0.0-rc.0'],
    ])
      expect(() => sourceStrategy(name, manifest.version, version)).toThrow('no reviewed');
  });
  it('binds original bytes, fixed PR/head/tree and code-derived strategy to the projected manifest', () => {
    const origin = {
      ...sourceOrigin(recipe.repo, row, 'b'.repeat(40), original),
      installManifestHash: 'c'.repeat(64),
      installLockHash: 'd'.repeat(64),
    };
    expect(verifySourceOrigin(origin, recipe, row, projected)).toEqual(manifest);
    for (const change of [
      { repo: 'other/repo' },
      { pr: 1 },
      { head: 'c'.repeat(40) },
      { tree: 'main' },
      { kind: 'registry' },
      { installLockHash: undefined },
      { installManifestHash: 'wrong' },
      { strategy: 'authored' },
      { sourceVersion: '15.0.0-rc.0' },
      { archiveVersion: '14.7.2' },
      { sourceManifestText: JSON.stringify({ ...manifest, description: 'changed' }) },
    ])
      expect(() => verifySourceOrigin({ ...origin, ...change }, recipe, row, projected)).toThrow();
    expect(() =>
      verifySourceOrigin(origin, recipe, row, { ...projected, peerDependencies: { footprintjs: '*' } }),
    ).toThrow('projection');
  });
  it('distinguishes stable authored SOURCE labels from registry bytes, retaining every RC collision check', () => {
    expect(
      needsCollisionCheck({
        version: '0.13.3',
        origin: { kind: 'source', strategy: 'authored', sourceVersion: '0.13.3' },
      }),
    ).toBe(false);
    expect(
      needsCollisionCheck({
        version: '15.0.0-rc.0',
        origin: { kind: 'source', strategy: 'authored', sourceVersion: '15.0.0-rc.0' },
      }),
    ).toBe(true);
    expect(needsCollisionCheck({ version: '0.13.3' })).toBe(true);
  });
});
