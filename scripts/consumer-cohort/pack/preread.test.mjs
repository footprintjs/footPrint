import { it, expect, vi } from 'vitest';
const calls = vi.hoisted(() => ({ unbounded: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal();
  return {
    ...fs,
    readFileSync: (path, ...args) => {
      if (
        String(path).endsWith('/oversized-af-profile.tgz') ||
        String(path).endsWith('/oversized-engine-profile.tgz')
      ) {
        calls.unbounded++;
        throw Error('UNBOUNDED_SRI_READ_BEFORE_PROFILE');
      }
      return fs.readFileSync(path, ...args);
    },
  };
});
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pack } from '../../publish-release/archive/fixture.cjs';
vi.mock('../../consumer-relabel.mjs', () => ({
  relabelCandidate: (_input, version, dest) => {
    mkdirSync(dest, { recursive: true });
    const file = join(dest, 'fixture-engine.tgz');
    writeFileSync(file, pack({ name: 'footprintjs', version }));
    return file;
  },
}));
import { produce } from './index.mjs';
it('refuses an oversized registry AF archive before any whole-file SRI read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-preread-'));
  const folder = join(root, 'bundle');
  mkdirSync(folder);
  const manifest = { name: 'footprintjs', version: '12.3.0' };
  writeFileSync(join(folder, 'footprintjs-candidate.tgz'), pack(manifest));
  const af = {
    package: 'agentfootprint',
    version: '14.7.2',
    integrity: 'sha512-' + Buffer.alloc(64).toString('base64'),
  };
  try {
    const result = produce(
      {
        root,
        folder,
        context: { manifest, head: 'head', tree: 'tree' },
        family: [],
        plan: {
          packages: [],
          registry: [af, { package: 'foottrace', version: '2.0.0-rc.0', integrity: af.integrity }],
          engineVersion: '13.0.0-rc.0',
        },
      },
      {
        registryManifest: async (row) => ({
          name: row.package,
          version: row.version,
          dist: { integrity: row.integrity },
        }),
        read: (cmd, args) => {
          expect(cmd).toBe('npm');
          const target = args[args.indexOf('--pack-destination') + 1];
          const file = join(target, 'oversized-af-profile.tgz');
          writeFileSync(file, '');
          truncateSync(file, 32 * 1024 * 1024 + 1);
          return JSON.stringify([{ filename: 'oversized-af-profile.tgz' }]);
        },
        fetch: async () => ({ status: 404 }),
      },
    );
    await expect(result).rejects.toThrow('archive input');
    expect(calls.unbounded).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('bounds the cohort engine input before the unchanged default relabel helper reads it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cohort-engine-preread-'));
  const folder = join(root, 'bundle');
  mkdirSync(folder);
  const manifest = { name: 'footprintjs', version: '12.3.0' };
  const input = join(folder, 'footprintjs-candidate.tgz');
  writeFileSync(input, '');
  truncateSync(input, 16 * 1024 * 1024 + 1);
  try {
    await expect(
      produce({
        root,
        folder,
        context: { manifest },
        family: [],
        plan: { engineVersion: '13.0.0-rc.0', packages: [], registry: [] },
      }),
    ).rejects.toThrow('archive input');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
