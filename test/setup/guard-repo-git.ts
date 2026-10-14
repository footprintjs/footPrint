import { execFileSync } from 'node:child_process';

/**
 * Vitest globalSetup: no test may change the real repo's git config or HEAD.
 *
 * A test that runs git with the hook's GIT_DIR once set `core.bare=true` on the
 * real checkout. This records `git config --local --list` and HEAD before the
 * run and fails the run, naming what changed, if either differs after it.
 */
const ROOT = process.cwd();

// A hook exports GIT_DIR and friends; read the repo at ROOT, not whatever they point at.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

const git = (...args: string[]): string => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', env });

const configLines = (): string[] => git('config', '--local', '--list').split('\n').filter(Boolean);

interface Snapshot {
  config: string[];
  head: string;
}

const snapshot = (): Snapshot => ({ config: configLines(), head: git('rev-parse', 'HEAD').trim() });

export default function setup(): () => void {
  const before = snapshot();
  return () => {
    const after = snapshot();
    const problems: string[] = [];
    for (const line of after.config)
      if (!before.config.includes(line)) problems.push(`git config added or changed: ${line}`);
    for (const line of before.config)
      if (!after.config.includes(line)) problems.push(`git config removed or changed: ${line}`);
    if (before.head !== after.head) problems.push(`HEAD moved: ${before.head} -> ${after.head}`);
    if (problems.length > 0) {
      // Vitest only logs a failing teardown and still exits 0; the exit code is what fails CI and the pre-push hook.
      process.once('exit', () => {
        process.exitCode = 1;
      });
      throw new Error(`A test changed the real repo (${ROOT}):\n  ${problems.join('\n  ')}`);
    }
  };
}
