/**
 * A child `git` started by a test or script must act on its own `cwd`, even when the suite runs
 * inside a git hook that exports GIT_DIR / GIT_INDEX_FILE (husky's pre-push does).
 *
 *   contract  `isolatedGitEnv()` keeps a hook's repository from leaking into a child `git`
 *   control   the raw environment DOES leak — a fixture commit lands in the hook's repository —
 *             so the contract test bites
 *
 * Only temporary repositories are touched: `hook` stands in for the repository whose hook runs.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { isolatedGitEnv, REPO_LOCAL_GIT_ENV } from '../../scripts/git-env.mjs';

const made: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-env-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository standing in for the one whose hook is running, plus the env that hook exports. */
function hookRepository() {
  const hook = temp();
  run(hook, isolatedGitEnv(), 'init', '-q');
  return { hook, env: { ...process.env, GIT_DIR: join(hook, '.git'), GIT_INDEX_FILE: join(hook, '.git', 'index') } };
}

/** What trace-readiness.test.ts does in its fixtures: init, add, commit. */
function commitFixture(dir: string, env: NodeJS.ProcessEnv) {
  run(dir, env, 'init', '-q');
  run(
    dir,
    env,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'fixture',
  );
}
const commitsIn = (repo: string) => {
  try {
    return Number(run(repo, isolatedGitEnv(), 'rev-list', '--count', '--all'));
  } catch {
    return 0; // no commits yet: rev-list has no refs to count
  }
};

describe('a child git acts on its own cwd', () => {
  it('isolatedGitEnv: init + commit in a fresh folder leave the hook repository untouched', () => {
    const { hook, env } = hookRepository();
    commitFixture(temp(), isolatedGitEnv(env));

    expect(commitsIn(hook)).toBe(0);
    expect(run(hook, isolatedGitEnv(), 'config', '--get', 'core.bare')).toBe('false');
  });

  it('control: under the raw hook environment the fixture commit lands in the hook repository', () => {
    const { hook, env } = hookRepository();
    commitFixture(temp(), env);

    expect(commitsIn(hook)).toBe(1);
  });

  it('drops exactly the repository-location variables and keeps the rest', () => {
    const env = isolatedGitEnv({
      PATH: '/bin',
      GIT_DIR: '/x/.git',
      GIT_INDEX_FILE: '/x/.git/index',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.bare',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_SSH_COMMAND: 'ssh -i k',
    });

    expect(env).toEqual({ PATH: '/bin', GIT_SSH_COMMAND: 'ssh -i k' });
    expect(REPO_LOCAL_GIT_ENV).toContain('GIT_WORK_TREE');
  });
});
