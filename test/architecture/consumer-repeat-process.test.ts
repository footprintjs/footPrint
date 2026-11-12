/**
 * The second candidate run, through the real script as CI runs it (scripts/audit-consumers.mjs).
 *
 * WHY A CHILD PROCESS. The rule is only as good as the script CI runs: `node scripts/audit-consumers.mjs
 * --only <consumer> --candidate <tgz> --base-version <v>` in GitHub Actions. Each test copies the scripts
 * into a throwaway repository root whose `family.json` names local consumers, and runs that copy as CI
 * does (GITHUB_ACTIONS=true, a summary file), with real git and real npm: the candidate is a generated
 * `footprintjs` archive, the consumers' checks are small scripts. The npm on PATH answers `npm view` (the
 * published version) and hands everything else to the real npm.
 *
 * WHY A PUBLISHED LEG IN SOME OF THEM. The second read of #204 (B1) found the hole in the published leg:
 * it ran in the first workspace between the two candidate runs, and agent-playground's `tsc -b` trusted
 * the build info it left there, so a real break came out `flaky`. Those tests need a registry for the
 * published leg: a loopback one (test/helpers/localRegistry.ts), so they run only where a process may
 * listen on 127.0.0.1 (CI). The others are offline (`fallback: false`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isolatedGitEnv } from '../../scripts/git-env.mjs';
import { localRegistry } from '../helpers/localRegistry';

const PROCESS_TEST_MS = 120_000;
const PUBLISHED_VERSION = '1.0.0';
const CANDIDATE_VERSION = '1.0.1';

const roots: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=audit', '-c', 'user.email=audit@example.invalid', ...args], {
    cwd,
    env: isolatedGitEnv(),
    stdio: 'ignore',
  });

/** A local consumer: its files (beside package.json and its lock), its one check, and whether it has a published leg. */
type Consumer = { name: string; files: Record<string, string>; check: string; fallback: boolean };

/** One generated `footprintjs` archive at `version`, packed into `into`. */
function archive(root: string, version: string, into: string, env: NodeJS.ProcessEnv) {
  const pkg = join(root, `pkg-${version}`);
  mkdirSync(pkg);
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'footprintjs', version, main: 'index.js' }));
  writeFileSync(join(pkg, 'index.js'), 'module.exports = {};\n');
  mkdirSync(into, { recursive: true });
  execFileSync('npm', ['pack', '--pack-destination', into], { cwd: pkg, env, stdio: 'ignore' });
  return join(into, `footprintjs-${version}.tgz`);
}

/**
 * A repository root holding a copy of the audit's scripts and a `family.json` of `consumers`, an org
 * folder with each consumer as a git repository, and the candidate. `registry` (a URL) gives the run a
 * published footprintjs; without it npm is offline.
 */
function setUp(consumers: Consumer[], registry: string | null = null) {
  // The real path: the script runs only when it is the file node was started with (macOS's /tmp is a link).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-repeat-process-')));
  roots.push(root);
  const repo = join(root, 'footPrint');
  cpSync(resolve('scripts'), join(repo, 'scripts'), { recursive: true });
  symlinkSync(resolve('node_modules'), join(repo, 'node_modules'));
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'footprintjs', dependencies: { foottrace: '*' } }));
  const family = consumers.map(({ name, check, fallback }) => ({
    package: name,
    repo: `test/${name}`,
    branch: 'main',
    dir: name,
    install: 'true',
    fallback,
    checks: [check],
  }));
  writeFileSync(join(repo, 'scripts/family.json'), JSON.stringify({ family }));

  const org = join(root, 'org');
  for (const { name, files } of consumers) {
    const app = join(org, name);
    mkdirSync(app, { recursive: true });
    const manifest = { name, version: '0.0.0', private: true, dependencies: { footprintjs: `^${PUBLISHED_VERSION}` } };
    writeFileSync(join(app, 'package.json'), JSON.stringify(manifest));
    writeFileSync(
      join(app, 'package-lock.json'),
      JSON.stringify({ name, version: '0.0.0', lockfileVersion: 3, requires: true, packages: { '': manifest } }),
    );
    writeFileSync(join(app, '.gitignore'), 'node_modules/\n.check-cache\n');
    for (const [file, text] of Object.entries(files)) writeFileSync(join(app, file), text);
    git(app, 'init', '-q', '-b', 'main');
    git(app, 'add', '.');
    git(app, 'commit', '-q', '-m', 'consumer');
  }

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? root,
    TMPDIR: tmpdir(),
    npm_config_cache: join(root, 'npm-cache'),
    npm_config_update_notifier: 'false',
    ...(registry ? { npm_config_registry: registry } : { npm_config_offline: 'true' }),
  };
  const candidate = archive(root, CANDIDATE_VERSION, join(root, 'candidate'), env);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const realNpm = execFileSync('bash', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/bash\n[[ "$1" == view ]] && { echo ${PUBLISHED_VERSION}; exit 0; }\nexec "${realNpm}" "$@"\n`,
    { mode: 0o755 },
  );

  const summary = join(root, 'summary.md');
  /** Audit one consumer as CI does. */
  const ran = (name: string) => {
    const child = spawnSync(
      process.execPath,
      [
        join(repo, 'scripts/audit-consumers.mjs'),
        '--local',
        '--org',
        org,
        '--only',
        name,
        '--candidate',
        candidate,
        '--base-version',
        CANDIDATE_VERSION,
      ],
      {
        encoding: 'utf8',
        timeout: PROCESS_TEST_MS - 10_000,
        env: { ...env, PATH: `${bin}:${env.PATH}`, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
      },
    );
    return {
      status: child.status,
      stdout: child.stdout,
      output: child.stdout + child.stderr,
      // Every command the audit ran through its one runner, in order (CI wraps each in a group).
      commands: child.stdout
        .split('\n')
        .filter((line) => line.startsWith('::group::'))
        .map((line) => line.slice('::group::'.length)),
      summary: () => readFileSync(summary, 'utf8'),
    };
  };
  return { root, org, ran };
}

/** A check that counts its runs in `file` (outside every checkout) and fails the first `failFirst` of them. */
const counting = (root: string, failFirst: number) => ({
  files: {
    'count.cjs':
      "const fs = require('fs');\nconst [file, failFirst] = process.argv.slice(2);\n" +
      "const runs = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;\n" +
      'fs.writeFileSync(file, String(runs));\nprocess.exit(runs <= Number(failFirst) ? 1 : 0);\n',
  },
  check: `node count.cjs ${join(root, 'runs.txt')} ${failFirst}`,
});
const runsOf = (root: string) =>
  existsSync(join(root, 'runs.txt')) ? Number(readFileSync(join(root, 'runs.txt'), 'utf8')) : 0;
const clones = (commands: string[]) => commands.filter((command) => command.startsWith('git clone --quiet '));

describe('offline: no published leg (fallback: false)', () => {
  /** The root is made before the consumer, because the counting check's file lives in it. */
  function countingConsumer(failFirst: number) {
    const holder = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-repeat-runs-')));
    roots.push(holder);
    const { files, check } = counting(holder, failFirst);
    return { holder, check, ...setUp([{ name: 'app', files, check, fallback: false }]) };
  }

  it(
    'a green consumer: the commands of today, once each, exit 0',
    () => {
      const { ran, holder, check } = countingConsumer(0);
      const result = ran('app');
      expect(result.status, result.output).toBe(0);
      expect(runsOf(holder)).toBe(1);
      expect(result.commands).toEqual([
        expect.stringMatching(/^git clone --quiet /),
        'true',
        expect.stringMatching(/^npm install --no-save --no-audit --no-fund '.*footprintjs-1\.0\.1\.tgz'$/),
        check,
      ]);
      expect(result.stdout).toMatch(/\napp: pass \(/);
      expect(result.summary()).toContain('| Step | Candidate | Published |\n|---|---|---|\n');
    },
    PROCESS_TEST_MS,
  );

  it(
    'a check that fails once and passes on the second run: flaky, exit 0, the whole leg again in a new clone',
    () => {
      const { ran, holder, check } = countingConsumer(1);
      const result = ran('app');
      expect(result.status, result.output).toBe(0);
      expect(runsOf(holder)).toBe(2);
      const [cloneFirst, install, candidate] = result.commands;
      expect(result.commands).toEqual([
        cloneFirst,
        install,
        candidate,
        check,
        expect.any(String),
        install,
        candidate,
        check,
      ]);
      // A new clone, into the second workspace: never the first one again.
      const [first, again] = clones(result.commands);
      expect(again).not.toBe(first);
      expect(again).toMatch(/\/again\/app\/app'$/);
      expect(result.stdout).toMatch(/\napp: flaky \(/);
      expect(result.stdout).toContain(
        `::warning title=app: flaky::red once on the candidate, green on a second run of the same code: ${check}.`,
      );
      expect(result.stdout).toContain(
        '1 consumer(s) flaky (red once on the candidate, green on a second run of the same code): app.',
      );
      expect(result.summary()).toContain('| Step | Candidate | Published | Candidate again |');
    },
    PROCESS_TEST_MS,
  );

  it(
    'a check that fails twice: BLOCKING, exit 1, and exactly one second run',
    () => {
      const { ran, holder } = countingConsumer(99);
      const result = ran('app');
      expect(result.status, result.output).toBe(1);
      expect(runsOf(holder)).toBe(2);
      expect(result.stdout).toMatch(/\napp: BLOCKING \(/);
      expect(result.stdout).toContain(
        '::error title=app: BLOCKING::red on the candidate (fallback: false — no published leg)',
      );
      expect(result.stdout).toContain('; red again on a second run of the same candidate in a fresh workspace: ');
    },
    PROCESS_TEST_MS,
  );

  it(
    'the branch moves on while the audit runs: the second run stands at the commit the first one audited',
    () => {
      // The check fails, and on its first run pushes a commit to the consumer's branch that would make
      // it pass. A second run that cloned the branch again would test that commit and say `flaky`.
      const holder = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-repeat-org-')));
      roots.push(holder);
      const moved = join(holder, 'moved.cjs');
      const { ran, org } = setUp([{ name: 'app', files: {}, check: `node ${moved}`, fallback: false }]);
      const origin = join(org, 'app');
      writeFileSync(
        moved,
        "const fs = require('fs');\nconst { execFileSync } = require('child_process');\n" +
          "if (fs.existsSync('pass')) process.exit(0);\n" +
          `const origin = ${JSON.stringify(origin)};\n` +
          "if (!fs.existsSync(origin + '/pass')) {\n" +
          "  fs.writeFileSync(origin + '/pass', '');\n" +
          "  const git = (...args) => execFileSync('git', ['-C', origin, '-c', 'user.name=a', '-c', 'user.email=a@example.invalid', ...args]);\n" +
          "  git('add', 'pass');\n  git('commit', '-q', '-m', 'moved on');\n}\nprocess.exit(1);\n",
      );
      const audited = execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        env: isolatedGitEnv(),
      }).trim();
      const result = ran('app');
      expect(result.status, result.output).toBe(1);
      expect(result.stdout).toMatch(/\napp: BLOCKING \(/);
      // The branch did move, and the second clone was put back on the audited commit.
      expect(
        execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: isolatedGitEnv() }).trim(),
      ).not.toBe(audited);
      expect(result.commands).toContain(`git checkout --quiet --detach '${audited}'`);
    },
    PROCESS_TEST_MS,
  );
});

// These start a loopback registry: they fail where a process may not listen on 127.0.0.1, and CI runs them.
describe('with a published leg between the two candidate runs (fallback: true, a loopback registry)', () => {
  async function withRegistry(consumers: Consumer[]) {
    const holder = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-repeat-published-')));
    roots.push(holder);
    const published = archive(holder, PUBLISHED_VERSION, join(holder, 'published'), {
      ...process.env,
      npm_config_cache: join(holder, 'npm-cache'),
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
    });
    const registry = await localRegistry(published, PUBLISHED_VERSION);
    stops.push(registry.stop);
    return setUp(consumers, registry.url);
  }

  it(
    "a check green only on what the published leg left behind (the reader's B1): BLOCKING, exit 1; a check that really fails once: flaky, exit 0",
    async () => {
      // `cached` trusts a file an earlier run left in its checkout, as `tsc -b` trusts its build info:
      // red on the candidate's footprintjs, green on the published one, which leaves the file.
      const cached = {
        name: 'cached',
        fallback: true,
        check: 'node cached.cjs',
        files: {
          'cached.cjs':
            "const fs = require('fs');\nif (fs.existsSync('.check-cache')) process.exit(0);\n" +
            "const { version } = JSON.parse(fs.readFileSync('node_modules/footprintjs/package.json', 'utf8'));\n" +
            `if (version === ${JSON.stringify(CANDIDATE_VERSION)}) process.exit(1);\n` +
            "fs.writeFileSync('.check-cache', 'ok');\n",
        },
      };
      const holder = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-repeat-runs-')));
      roots.push(holder);
      const chance = { name: 'chance', fallback: true, ...counting(holder, 1) };
      const { ran } = await withRegistry([cached, chance]);

      const broken = ran('cached');
      expect(broken.status, broken.output).toBe(1);
      expect(broken.stdout).toMatch(/\ncached: BLOCKING \(/);
      expect(broken.stdout).toContain(
        '::error title=cached: BLOCKING::red only on the candidate: node cached.cjs; red again on a second run of the same candidate in a fresh workspace: node cached.cjs',
      );
      expect(broken.commands).toContain(
        `npm install --no-save --no-audit --no-fund 'footprintjs@${PUBLISHED_VERSION}'`,
      );
      expect(clones(broken.commands)).toHaveLength(2);

      const flaky = ran('chance');
      expect(flaky.status, flaky.output).toBe(0);
      expect(runsOf(holder)).toBe(3);
      expect(flaky.stdout).toMatch(/\nchance: flaky \(/);
      expect(clones(flaky.commands)).toHaveLength(2);
    },
    PROCESS_TEST_MS,
  );
});
