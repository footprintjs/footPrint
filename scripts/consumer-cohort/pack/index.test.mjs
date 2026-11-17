import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pack } from '../../publish-release/archive/fixture.cjs';
import { read } from '../../audit-process.mjs';
import { inspectPacked, verifyBundle } from '../bytes/index.mjs';
import { produce } from './index.mjs';

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('same-run production', () => {
  it('packs an inspected version-only engine copy and exact registry leaf; refuses changed leaf bytes/collisions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cohort-producer-'));
    roots.push(root);
    vi.stubEnv('npm_config_cache', join(root, 'cache'));
    vi.stubEnv('npm_config_offline', 'true');
    const folder = join(root, 'bundle');
    mkdirSync(folder);
    const source = { name: 'footprintjs', version: '12.3.0', dependencies: { foottrace: '^2.0.0-rc.0' } };
    writeFileSync(join(folder, 'footprintjs-candidate.tgz'), pack(source));
    const trace = { name: 'foottrace', version: '2.0.0-rc.0' };
    const traceFile = join(root, 'foottrace-source.tgz');
    writeFileSync(traceFile, pack(trace));
    const traceIdentity = inspectPacked(traceFile, trace);
    const plan = {
      hash: 'plan-fixture',
      engineVersion: '13.0.0-rc.0',
      packages: [],
      registry: [{ package: trace.name, version: trace.version, integrity: traceIdentity.integrity }],
    };
    const context = { head: 'h', base: 'b', checkout: 'm', tree: 't', run: '1', attempt: '1', manifest: source };
    const args = { plan, context, folder, root, family: [{ package: 'footprintjs' }, { package: 'foottrace' }] };
    const services = {
      registryManifest: async () => ({ ...trace, dist: { integrity: traceIdentity.integrity } }),
      fetch: async () => ({ status: 404 }),
      read: (cmd, argv, cwd) => {
        if (cmd === 'npm' && argv[0] === 'pack' && argv[1] === `foottrace@${trace.version}`) {
          const destination = argv[argv.indexOf('--pack-destination') + 1];
          copyFileSync(traceFile, join(destination, 'foottrace-fixture.tgz'));
          return JSON.stringify([{ filename: 'foottrace-fixture.tgz' }]);
        }
        return read(cmd, argv, cwd);
      },
    };
    const receipt = await produce(args, services);
    expect(verifyBundle(receipt, plan, context, folder).size).toBe(2);
    expect(JSON.parse(read('tar', ['-xOzf', join(folder, 'footprintjs.tgz'), 'package/package.json'])).version).toBe(
      '13.0.0-rc.0',
    );
    expect(readFileSync(join(folder, 'footprintjs-candidate.tgz'))).toEqual(pack(source));
    await expect(
      produce(args, {
        ...services,
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ dist: { integrity: 'other' } }) }),
      }),
    ).rejects.toThrow('collision');
    writeFileSync(traceFile, pack({ ...trace, description: 'tampered' }));
    await expect(produce(args, services)).rejects.toThrow('selected SRI');
  }, 30_000);
});
