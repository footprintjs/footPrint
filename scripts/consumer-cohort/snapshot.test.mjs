import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('pre-build source observation', () => {
  it('reads real ordered parents even at the shallow Actions merge boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'cohort-git-'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
    const git = (cwd, ...args) =>
      execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
        cwd,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    try {
      git(root, 'init', '-b', 'main');
      writeFileSync(join(root, 'package.json'), '{"name":"footprintjs","version":"12.3.0"}');
      git(root, 'add', 'package.json');
      git(root, 'commit', '-m', 'base');
      git(root, 'switch', '-c', 'feature');
      writeFileSync(join(root, 'feature'), 'source');
      git(root, 'add', 'feature');
      git(root, 'commit', '-m', 'feature');
      const head = git(root, 'rev-parse', 'HEAD');
      git(root, 'switch', 'main');
      writeFileSync(join(root, 'main'), 'base advance');
      git(root, 'add', 'main');
      git(root, 'commit', '-m', 'advance');
      const base = git(root, 'rev-parse', 'HEAD');
      git(root, 'merge', '--no-ff', 'feature', '-m', 'test merge');
      const checkout = git(root, 'rev-parse', 'HEAD');
      const shallow = join(root, 'shallow');
      git(root, 'clone', '--depth', '1', `file://${root}`, shallow);
      expect(git(shallow, 'show', '-s', '--format=%P', 'HEAD')).toBe('');
      const event = join(root, 'event.json');
      const output = join(root, 'observed.json');
      writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: head }, base: { sha: base } } }));
      const args = [resolve('scripts/consumer-cohort/snapshot.mjs'), output];
      const ci = {
        ...env,
        GITHUB_EVENT_PATH: event,
        GITHUB_REPOSITORY: 'footprintjs/footPrint',
        GITHUB_SHA: checkout,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
      };
      execFileSync(process.execPath, args, { cwd: shallow, env: ci });
      expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
        head,
        base,
        checkout,
        parents: [base, head],
        run: '123',
      });
      expect(() =>
        execFileSync(process.execPath, args, { cwd: shallow, env: { ...ci, GITHUB_SHA: head }, stdio: 'pipe' }),
      ).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
