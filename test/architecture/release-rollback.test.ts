/** Gate 7 must undo every tracked metadata change made by the real npm version command. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const release = readFileSync(resolve(__dirname, '../../scripts/release.sh'), 'utf8');
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe('release changelog gate', () => {
  it.each([
    { title: 'restores both tracked metadata files when the new entry is missing', entry: false },
    { title: 'keeps both bumped metadata files when the new entry exists', entry: true },
  ])(
    '$title',
    ({ entry }) => {
      const starts = [...release.matchAll(/^# .*Gate 7: CHANGELOG entry.*$/gm)];
      const ends = [...release.matchAll(/^# .*Extract release notes.*$/gm)];
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(ends[0].index).toBeGreaterThan(starts[0].index);
      const gate = release.slice(starts[0].index + starts[0][0].length, ends[0].index).trim();
      expect(gate.length).toBeGreaterThan(0);
      const bump = release.split('\n').filter((line) => line.startsWith('npm version '));
      expect(bump).toEqual(['npm version "$BUMP" --no-git-tag-version']);

      const root = mkdtempSync(join(tmpdir(), 'release-rollback-'));
      const repository = join(root, 'repository');
      const hooks = join(root, 'empty-hooks');
      const deadline = Date.now() + 20_000;
      mkdirSync(repository);
      mkdirSync(hooks);
      try {
        const userConfig = join(root, 'user.npmrc');
        const globalConfig = join(root, 'global.npmrc');
        writeFileSync(userConfig, '');
        writeFileSync(globalConfig, '');
        // Allowlist rather than inherit hook GIT_* variables, npm config, or shell startup hooks.
        const env: NodeJS.ProcessEnv = {
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          npm_config_userconfig: userConfig,
          npm_config_globalconfig: globalConfig,
          npm_config_cache: join(root, 'cache'),
          npm_config_registry: 'http://127.0.0.1:1',
          npm_config_offline: 'true',
          npm_config_ignore_scripts: 'true',
          npm_config_audit: 'false',
          npm_config_fund: 'false',
          npm_config_update_notifier: 'false',
        };
        const run = (file: string, args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}) => {
          const timeout = Math.min(10_000, deadline - Date.now());
          if (timeout <= 0) throw new Error('Release rollback fixture exceeded its 20 second budget.');
          const result = spawnSync(file, args, {
            cwd: repository,
            env: { ...env, ...extraEnv },
            input,
            encoding: 'utf8',
            timeout,
            maxBuffer: 64 * 1024,
          });
          expect(result.error).toBeUndefined();
          return result;
        };
        const git = (...args: string[]) => {
          const result = run('git', ['-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${hooks}`, ...args]);
          expect(result.status, result.stderr).toBe(0);
          return result.stdout;
        };
        const manifest = { name: 'release-rollback-fixture', version: '1.0.0', private: true };
        const original = json(manifest);
        const originalLock = json({
          name: manifest.name,
          version: manifest.version,
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: manifest.name, version: manifest.version } },
        });
        const read = (file: string) => readFileSync(join(repository, file), 'utf8');
        writeFileSync(join(repository, 'package.json'), original);
        writeFileSync(join(repository, 'package-lock.json'), originalLock);
        writeFileSync(
          join(repository, 'CHANGELOG.md'),
          `# Changelog\n\n## [${entry ? '1.0.1' : '1.0.0'}]\n\nFixture.\n`,
        );
        git('init', '-q', `--template=${hooks}`);
        git('config', 'core.hooksPath', hooks); // Also disables hooks for the gate's own git checkout.
        git('add', '--', 'package.json', 'package-lock.json', 'CHANGELOG.md');
        git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture');
        expect(git('status', '--porcelain')).toBe('');

        const bumped = run('bash', ['-euo', 'pipefail'], bump[0], { BUMP: 'patch' });
        expect(bumped.status, bumped.stderr).toBe(0);
        const bumpedManifest = read('package.json');
        const bumpedLock = read('package-lock.json');
        expect(bumpedManifest).not.toBe(original);
        expect(bumpedLock).not.toBe(originalLock);
        expect(JSON.parse(bumpedManifest).version).toBe('1.0.1');
        expect(JSON.parse(bumpedLock).version).toBe('1.0.1');
        const bumpedStatus = git('status', '--porcelain');

        // Execute only the actual production gate: no release audit, tagging, push, or publication.
        const result = run('bash', ['-euo', 'pipefail'], gate, { VERSION: '1.0.1' });
        expect(result.status, result.stderr).toBe(entry ? 0 : 1);
        expect(read('package.json')).toBe(entry ? bumpedManifest : original);
        expect(read('package-lock.json')).toBe(entry ? bumpedLock : originalLock);
        expect(git('status', '--porcelain')).toBe(entry ? bumpedStatus : '');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
