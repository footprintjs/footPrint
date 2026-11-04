import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

// The package gate builds dist first; an unbuilt checkout must refuse this profile.
it('admits this package’s actual offline npm pack under the closed archive profile', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'fp-pack-profile-'));
  const { inspectArchive, parseManifest } = createRequire(resolve('scripts/publish-release/archive.test.ts'))(
    './archive/inspector.cjs',
  );
  try {
    const source = parseManifest(readFileSync(resolve('package.json')));
    const output = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', temporary],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          npm_config_cache: join(temporary, 'cache'),
          npm_config_userconfig: join(temporary, 'user.npmrc'),
          npm_config_globalconfig: join(temporary, 'global.npmrc'),
          npm_config_update_notifier: 'false',
        },
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        stdio: 'pipe',
      },
    );
    const packages = JSON.parse(output);
    expect(packages).toHaveLength(1);
    const filename = `footprintjs-${source.version}.tgz`;
    expect(packages[0].filename).toBe(filename);
    const result = inspectArchive(readFileSync(join(temporary, filename)), {
      package: 'footprintjs',
      version: source.version,
      sourceManifest: source,
    });
    expect(result.files.some((file: { path: string }) => file.path === 'package/AGENTS.md')).toBe(true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
