import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { entry, tar } from '../../publish-release/archive/fixture.cjs';
import { inspectPacked, verifyInstalled } from '../bytes/index.mjs';
import { localRegistry } from '../../../test/helpers/localRegistry.ts';
import { closure, installPaired } from './index.mjs';

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const family = [{ package: 'footprintjs' }, { package: 'foottrace' }];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'paired-real-npm-'));
  roots.push(root);
  vi.stubEnv('npm_config_cache', join(root, 'cache'));
  vi.stubEnv('npm_config_offline', 'true');
  vi.stubEnv('npm_config_ignore_scripts', 'true');
  const make = (name, version, dependencies, code) => {
    const manifest = { name, version, main: 'dist/index.js', ...(dependencies ? { dependencies } : {}) };
    const path = join(root, `${name}.tgz`);
    writeFileSync(
      path,
      gzipSync(tar([entry('package/package.json', JSON.stringify(manifest)), entry('package/dist/index.js', code)])),
    );
    return { ...inspectPacked(path, manifest), path };
  };
  const trace = make('foottrace', '2.0.0-rc.0', null, "module.exports = 'trace2';\n");
  const engine = make(
    'footprintjs',
    '13.0.0-rc.0',
    { foottrace: '^2.0.0-rc.0' },
    "module.exports = require('foottrace');\n",
  );
  const selections = new Map([
    ['footprintjs', engine],
    ['foottrace', trace],
  ]);
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  const manifest = {
    name: 'paired-consumer',
    version: '1.0.0',
    private: true,
    dependencies: { footprintjs: '^13.0.0-rc.0', foottrace: '^2.0.0-rc.0' },
  };
  writeFileSync(join(consumer, 'package.json'), JSON.stringify(manifest));
  return { root, selections, consumer, manifest };
}

describe('real first-install pairing', () => {
  it('installs the actual coherent archive bytes before any ci, then detects runtime tampering', async () => {
    const { selections, consumer, manifest } = fixture();
    const registry = await localRegistry(selections.get('foottrace').path, '2.0.0-rc.0', 'foottrace');
    vi.stubEnv('npm_config_offline', 'false');
    vi.stubEnv('npm_config_registry', registry.url);
    vi.stubEnv('npm_config_fetch_retries', '0');
    vi.stubEnv('npm_config_fetch_timeout', '5000');
    try {
      const used = installPaired(consumer, manifest, selections, family);
      expect(
        execFileSync(process.execPath, ['-e', "console.log(require('footprintjs'))"], {
          cwd: consumer,
          encoding: 'utf8',
        }).trim(),
      ).toBe('trace2');
      expect(() => verifyInstalled(consumer, used, '2.0.0-rc.0')).not.toThrow();
      expect(() => verifyInstalled(consumer, used, '1.16.0')).toThrow('expected one physical');
      writeFileSync(join(consumer, 'node_modules/footprintjs/dist/index.js'), "module.exports = 'wrong';\n");
      expect(() => verifyInstalled(consumer, used, '2.0.0-rc.0')).toThrow('file bytes differ');
    } finally {
      registry.stop();
    }
  }, 30_000);
  it('refuses an original old pin before install and preserves the authored manifest', () => {
    const { selections, consumer, manifest } = fixture();
    manifest.dependencies.foottrace = '^1.16.0';
    writeFileSync(join(consumer, 'package.json'), JSON.stringify(manifest));
    const before = readFileSync(join(consumer, 'package.json'));
    expect(() => installPaired(consumer, manifest, selections, family)).toThrow('refuses');
    expect(readFileSync(join(consumer, 'package.json'))).toEqual(before);
  });
  it('does not infer a runtime migration from a dependency-only development pin', () => {
    const { selections, manifest } = fixture();
    const dep = { name: 'some-family', version: '1.0.0', devDependencies: { foottrace: '^1.16.0' } };
    selections.set('some-family', { version: dep.version, manifest: dep });
    manifest.dependencies['some-family'] = '^1.0.0';
    expect(closure(manifest, selections, [...family, { package: dep.name }]).has(dep.name)).toBe(true);
  });
});
