/**
 * Before a consumer blocks, its failure must repeat (scripts/audit-consumers.mjs · judge,
 * judgeOutOfRange, repeatKeys, repeatOutcome, audit, report, main).
 *
 * WHY: on 12 Nov 2026 a pull request that changed ten lines of one Markdown file was BLOCKING on
 * vizfootprint, because one of its own tests failed by chance on the candidate leg and passed on
 * the published leg (Consumers run 43261862232, job 131335570060). A step red once and green on a
 * second run of the same code says nothing about the candidate.
 *
 * Every leg here is injected; the last describe runs the real script in a child process.
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  audit,
  declaredRange,
  judge,
  judgeOutOfRange,
  main,
  repeatKeys,
  repeatOutcome,
} from '../../scripts/audit-consumers.mjs';
import { isolatedGitEnv } from '../../scripts/git-env.mjs';
import { lockOf, PUBLISHED } from '../helpers/consumerRange';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'consumer-repeat-'));
  roots.push(root);
  return root;
};
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

type Step = { key: string; ok: boolean; seconds: number; skipped?: boolean };
const CHECKS = ['npm run build', 'npm test', 'npm run lint'];
/** One leg: the install, then the first `oks.length` checks; every check is skipped when the install is red. */
const legOf = (install: boolean, ...oks: boolean[]): Step[] => [
  { key: 'install footprintjs', ok: install, seconds: 1 },
  ...oks.map((ok, i) =>
    install ? { key: CHECKS[i], ok, seconds: 1 } : { key: CHECKS[i], ok: false, skipped: true, seconds: 0 },
  ),
];
// The 12 Nov shape: the test red on the candidate, everything green on the published footprintjs.
const RED_ONCE = legOf(true, true, false, true);
const GREEN = legOf(true, true, true, true);

const entry = {
  package: 'app',
  repo: 'test/app',
  branch: 'main',
  dir: 'app',
  checks: CHECKS,
  installStrategy: 'packaged',
};
const CANDIDATE = '/candidate.tgz';

/** A consumer that may block (no lock: its range is not read, so it is judged as it always was). */
function mayBlock(legs: (Step[] | null)[]) {
  const queue = [...legs];
  const log: string[] = [];
  const io = {
    clone: vi.fn((_entry, dir) => {
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', peerDependencies: { footprintjs: '*' } }));
      return null;
    }),
    run: vi.fn((command: string) => {
      log.push(command);
      return { ok: true, seconds: 1 };
    }),
    read: vi.fn(() => 'abcd123'),
    latest: vi.fn(() => '9.48.3'),
    advancedImports: vi.fn(() => ({ lines: 0, record: [], other: [], unresolved: false })),
    leg: vi.fn((spec: string, _dirs, _pins, checks: string[]) => {
      log.push(`install ${spec}`, ...checks);
      return queue.shift() ?? null;
    }),
  };
  return { io, log };
}
const context = { candidate: CANDIDATE, candidateVersion: '10.0.0', published: '9.48.3', record: new Set() };

/** A consumer that reports only: its own range ^11.2.0 refuses base 12.0.0; its code is tested as 11.2.0. */
function reportsOnly(legs: (Step[] | null)[]) {
  const made = mayBlock(legs);
  made.io.clone.mockImplementation((_entry, dir) => {
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app', dependencies: { footprintjs: '^11.2.0' } }));
    return null;
  });
  return {
    ...made,
    io: {
      ...made.io,
      declaredRange: vi.fn((dirs, pins, originals) =>
        declaredRange(dirs, pins, originals, { installedTree: () => lockOf({}), publishedPeers: () => ({}) }),
      ),
      publishedVersions: vi.fn(() => PUBLISHED),
      relabelCandidate: vi.fn((_input, version, folder) => join(folder, `footprintjs-candidate-as-${version}.tgz`)),
    },
  };
}
const ctx12 = {
  candidate: CANDIDATE,
  candidateVersion: '12.0.0',
  baseVersion: '12.0.0',
  published: '12.0.0',
  record: new Set(),
};

describe('a green audit runs exactly the commands it ran before the rule (pinned against 12.0.0)', () => {
  it('all green: one install of the consumer, one candidate leg, nothing else', () => {
    const { io, log } = mayBlock([GREEN]);
    const actual = audit({ ...entry, installStrategy: 'linked', setup: 'download-browser' }, temp(), context, {}, io);
    expect(actual.verdict).toBe('pass');
    expect(log).toEqual(['npm install --no-audit --no-fund', `install ${CANDIDATE}`, 'download-browser', ...CHECKS]);
    expect(actual.published).toBeNull();
    expect(actual.repeat).toBeUndefined();
  });

  it.each([
    ['own failure: red on both', [RED_ONCE, RED_ONCE], 'own failure'],
    ['the candidate did not install, the published one did', [legOf(false, false, false, false), GREEN], 'BLOCKING'],
    ['the published leg did not install', [RED_ONCE, legOf(false, false, false, false)], 'no verdict'],
  ])('%s: two legs, no repeat', (_name, legs, verdict) => {
    const { io, log } = mayBlock(legs);
    const actual = audit(entry, temp(), context, {}, io);
    expect(actual.verdict).toBe(verdict);
    expect(log).toEqual([`install ${CANDIDATE}`, ...CHECKS, 'install footprintjs@9.48.3', ...CHECKS]);
    expect(actual.repeat).toBeUndefined();
  });

  it('reports only, all green: one leg', () => {
    const { io, log } = reportsOnly([GREEN]);
    const ws = temp();
    expect(audit(entry, ws, ctx12, {}, io).verdict).toBe('opt-in needed');
    expect(log).toEqual([`install ${join(ws, 'app/relabelled/footprintjs-candidate-as-11.2.0.tgz')}`, ...CHECKS]);
  });
});

describe('the verdict table: the second candidate run decides', () => {
  // The repeat runs the checks up to the last red one: build and test here, not lint.
  const RED_AGAIN = legOf(true, true, false);
  const GREEN_AGAIN = legOf(true, true, true);
  const NOT_INSTALLED_AGAIN = legOf(false, false, false);

  it.each([
    {
      name: 'a repeated check is red again',
      repeat: RED_AGAIN,
      mayBlockVerdict: 'BLOCKING',
      reportsOnlyVerdict: 'needs migration',
    },
    {
      name: 'every repeated check is green',
      repeat: GREEN_AGAIN,
      mayBlockVerdict: 'flaky',
      reportsOnlyVerdict: 'flaky',
    },
    {
      name: 'the candidate cannot be installed again',
      repeat: NOT_INSTALLED_AGAIN,
      mayBlockVerdict: 'no verdict',
      reportsOnlyVerdict: 'needs migration',
    },
    {
      name: 'the repeat did not run at all',
      repeat: null,
      mayBlockVerdict: 'no verdict',
      reportsOnlyVerdict: 'needs migration',
    },
  ])(
    '$name: may block → $mayBlockVerdict; reports only → $reportsOnlyVerdict',
    ({ repeat, mayBlockVerdict, reportsOnlyVerdict }) => {
      expect(judge(RED_ONCE, GREEN, true, repeat)).toBe(mayBlockVerdict);
      expect(judgeOutOfRange(RED_ONCE, GREEN, true, repeat)).toBe(reportsOnlyVerdict);
      // fallback: false — no published leg, every red check is repeated.
      expect(judge(RED_ONCE, null, false, repeat)).toBe(mayBlockVerdict);
      expect(judgeOutOfRange(RED_ONCE, null, false, repeat)).toBe(reportsOnlyVerdict);
    },
  );

  it.each([
    ['may block', mayBlock, context, CANDIDATE, 'footprintjs@9.48.3', 'BLOCKING', 'no verdict'],
    ['reports only', reportsOnly, ctx12, 'relabelled', 'footprintjs@11.2.0', 'needs migration', 'needs migration'],
  ] as const)(
    '%s, through the audit: every row',
    (_kind, consumer, ctx, spec, published, redVerdict, notCarriedOut) => {
      for (const [repeat, verdict] of [
        [RED_AGAIN, redVerdict],
        [GREEN_AGAIN, 'flaky'],
        [NOT_INSTALLED_AGAIN, notCarriedOut],
      ] as const) {
        const { io, log } = consumer([RED_ONCE, GREEN, repeat]);
        const ws = temp();
        const actual = audit(entry, ws, ctx, {}, io);
        const tested = spec === 'relabelled' ? join(ws, 'app/relabelled/footprintjs-candidate-as-11.2.0.tgz') : spec;
        expect(actual.verdict, verdict).toBe(verdict);
        expect(log).toEqual([
          `install ${tested}`,
          ...CHECKS,
          `install ${published}`,
          ...CHECKS,
          `install ${tested}`,
          'npm run build',
          'npm test',
        ]);
        expect(actual.repeat).toEqual(repeat);
        expect(actual.repeated).toEqual(['npm test']);
      }
    },
  );

  it('fallback: false — the same repeat before it blocks; no published leg', () => {
    for (const [repeat, verdict] of [
      [RED_AGAIN, 'BLOCKING'],
      [GREEN_AGAIN, 'flaky'],
      [NOT_INSTALLED_AGAIN, 'no verdict'],
    ] as const) {
      const { io, log } = mayBlock([RED_ONCE, repeat]);
      const actual = audit({ ...entry, fallback: false }, temp(), context, {}, io);
      expect(actual.verdict).toBe(verdict);
      expect(actual.published).toBeNull();
      expect(log).toEqual([`install ${CANDIDATE}`, ...CHECKS, `install ${CANDIDATE}`, 'npm run build', 'npm test']);
    }
  });
});

describe('what the second run repeats', () => {
  it('the same candidate, dirs, pins, notes and install options as the first run; exactly once, even when red again', () => {
    const { io } = mayBlock([RED_ONCE, GREEN, legOf(true, true, false), GREEN, GREEN]);
    audit(entry, temp(), context, {}, io);
    expect(io.leg).toHaveBeenCalledTimes(3);
    const [first, , again] = io.leg.mock.calls;
    expect(again[3]).toEqual(['npm run build', 'npm test']);
    for (const i of [0, 1, 2, 4, 5, 6, 7]) expect(again[i], `argument ${i}`).toBe(first[i]);
  });

  it('only checks red on the candidate and green on the published leg are judged; one red on both is not repeated', () => {
    // build red on both (its own failure), test red only on the candidate, lint green.
    const candidate = legOf(true, false, false, true);
    const published = legOf(true, false, true, true);
    expect(repeatKeys(candidate, published)).toEqual(['npm test']);
    // build runs again as the step before test, and must do what it did the first time: red.
    expect(judge(candidate, published, true, legOf(true, false, true))).toBe('flaky');
    expect(judge(candidate, published, true, legOf(true, false, false))).toBe('BLOCKING');
  });

  it('a check red on both and nothing else red: own failure, no repeat', () => {
    expect(repeatKeys(RED_ONCE, RED_ONCE)).toEqual([]);
    expect(judge(RED_ONCE, RED_ONCE, true, legOf(true, true, true))).toBe('own failure');
  });

  it('a candidate that did not install is not repeated: its checks never ran, so nothing was red once', () => {
    const notInstalled = legOf(false, false, false, false);
    expect(repeatKeys(notInstalled, GREEN)).toEqual([]);
    expect(judge(notInstalled, GREEN)).toBe('BLOCKING');
    expect(judgeOutOfRange(notInstalled, GREEN)).toBe('needs migration');
    expect(repeatKeys(notInstalled, null, false)).toEqual([]);
  });

  it('several checks red only on the candidate: all of them, up to the last; one red again blocks', () => {
    const candidate = legOf(true, false, true, false);
    expect(repeatKeys(candidate, GREEN)).toEqual(['npm run build', 'npm run lint']);
    expect(judge(candidate, GREEN, true, legOf(true, true, true, true))).toBe('flaky');
    expect(judge(candidate, GREEN, true, legOf(true, true, true, false))).toBe('BLOCKING');
    expect(judge(candidate, GREEN, true, legOf(true, false, true, true))).toBe('BLOCKING');
  });
});

describe('fail closed: flaky needs every repeated check to have RUN and been green', () => {
  const skipped = (step: Step) => ({ ...step, ok: false, skipped: true });
  it.each([
    ['the install red again', legOf(false, false, false)],
    ['a repeated check skipped', [...legOf(true, true), skipped(legOf(true, true, true)[2])]],
    [
      'a repeated check marked ok but skipped',
      [...legOf(true, true), { ...legOf(true, true, true)[2], skipped: true }],
    ],
    ['a check missing', legOf(true, true)],
    ['a check more than planned', legOf(true, true, true, true)],
    ['checks in another order', [legOf(true)[0], legOf(true, true, true)[2], legOf(true, true)[1]]],
    ['a step before the red one did not do what it did the first time', legOf(true, false, true)],
    ['an ok that is not a boolean', [...legOf(true, true), { key: 'npm test', ok: 'yes', seconds: 1 }]],
    ['no steps', []],
    ['nothing', undefined],
  ])('%s → no verdict (reports only: needs migration), never flaky', (_name, repeat) => {
    expect(repeatOutcome(RED_ONCE, ['npm test'], repeat as Step[])).toBe('not carried out');
    expect(judge(RED_ONCE, GREEN, true, repeat as Step[])).toBe('no verdict');
    expect(judgeOutOfRange(RED_ONCE, GREEN, true, repeat as Step[])).toBe('needs migration');
  });

  it('the audit says why there is no verdict', () => {
    const { io } = mayBlock([RED_ONCE, GREEN, legOf(false, false, false)]);
    const actual = audit(entry, temp(), context, {}, io);
    expect(actual.verdict).toBe('no verdict');
    expect(actual.notes).toContain(
      'second candidate run: not carried out (the candidate did not install again, or a check did not run as it did the first time), so the red checks were not confirmed',
    );
  });

  it('a repeat that throws stops the audit, as a first leg that throws does: it is never flaky', () => {
    const { io } = mayBlock([RED_ONCE, GREEN]);
    io.leg
      .mockImplementationOnce(() => RED_ONCE)
      .mockImplementationOnce(() => GREEN)
      .mockImplementationOnce(() => {
        throw new Error('npm crashed');
      });
    expect(() => audit(entry, temp(), context, {}, io)).toThrow('npm crashed');
  });
});

describe('what a run says about a repeat', () => {
  const base = { entry, sha: 'abc', seconds: 2, notes: ['range: …'] };
  it.each([
    { githubActions: undefined, warning: '  WARNING: ', error: '  ERROR: ' },
    { githubActions: 'true', warning: '::warning title=app: flaky::', error: '::error title=app: BLOCKING::' },
  ])(
    'flaky is a warning that names the check; BLOCKING names both runs ($githubActions)',
    async ({ githubActions, warning, error }) => {
      vi.stubEnv('GITHUB_ACTIONS', githubActions);
      vi.resetModules();
      const { report } = await import('../../scripts/audit-consumers.mjs');
      const summary = join(temp(), 'summary.md');
      vi.stubEnv('GITHUB_STEP_SUMMARY', summary);
      const runs = { candidate: RED_ONCE, published: GREEN, repeated: ['npm test'] };
      report({ ...base, ...runs, verdict: 'flaky', repeat: legOf(true, true, true) }, context);
      report({ ...base, ...runs, verdict: 'BLOCKING', repeat: legOf(true, true, false) }, context);
      report({ ...base, verdict: 'pass', candidate: GREEN, published: null }, context);
      const lines = vi.mocked(console.log).mock.calls.map(([line]) => line);
      expect(lines).toContain(
        `${warning}red once on the candidate, green on a second run of the same code: npm test. Not blocking; a check that fails by chance hides real failures, so fix it in test/app`,
      );
      expect(lines).toContain(
        `${error}red only on the candidate: npm test; red again on a second run of the same candidate: npm test`,
      );
      expect(lines).toContain(
        '  npm test                     candidate RED 1 s      published green 1 s    candidate again green 1 s',
      );
      expect(lines).toContain(
        '  npm run lint                 candidate green 1 s    published green 1 s    candidate again —',
      );
      // The pass: two columns, as before.
      expect(lines).toContain('  npm test                     candidate green 1 s    published —');
      const text = readFileSync(summary, 'utf8');
      expect(text).toContain('### app: flaky');
      expect(text).toContain('| Step | Candidate | Published | Candidate again |\n|---|---|---|---|');
      expect(text).toContain('| `npm test` | RED 1 s | green 1 s | green 1 s |');
      expect(text).toContain('| `npm run lint` | green 1 s | green 1 s | — |');
      const pass = text.slice(text.indexOf('### app: pass'));
      expect(pass).toContain('| Step | Candidate | Published |\n|---|---|---|\n');
      expect(pass).not.toContain('again');
    },
  );

  it('exit code 0 for flaky, 1 for BLOCKING and no verdict; the closing lines name the flaky consumers', () => {
    const runOne = (legs: (Step[] | null)[]) => {
      const { io } = mayBlock(legs);
      return main(['--only', 'hcifootprint', '--candidate', '/candidate.tgz'], {
        read: vi.fn(() => '{"version":"10.0.0"}'),
        latest: vi.fn(() => '9.48.3'),
        recordSymbolsAt: vi.fn(() => new Set()),
        audit: (selected: object, ws: string, ctx: object, opts: object) => audit(selected, ws, ctx, opts, io),
        report: vi.fn(),
      });
    };
    const flaky = runOne([RED_ONCE, GREEN, legOf(true, true, true)]);
    expect(flaky).toMatchObject({ exitCode: 0, results: [{ verdict: 'flaky' }] });
    const lines = vi.mocked(console.log).mock.calls.map(([line]) => line);
    expect(lines).toContain('\nno consumer blocks this candidate.');
    expect(lines).toContain(
      '1 consumer(s) flaky (red once on the candidate, green on a second run of the same code): hcifootprint.',
    );
    expect(runOne([RED_ONCE, GREEN, legOf(true, true, false)])).toMatchObject({
      exitCode: 1,
      results: [{ verdict: 'BLOCKING' }],
    });
    expect(runOne([RED_ONCE, GREEN, legOf(false, false, false)])).toMatchObject({
      exitCode: 1,
      results: [{ verdict: 'no verdict' }],
    });
    vi.mocked(console.log).mockClear();
    runOne([GREEN]);
    expect(vi.mocked(console.log).mock.calls.some(([line]) => String(line).includes('flaky'))).toBe(false);
  });
});

// WHY A CHILD PROCESS. The rule is only as good as the script CI runs: `node scripts/audit-consumers.mjs
// --only <consumer> --candidate <tgz> --base-version <v>` in GitHub Actions. This copies the scripts into a
// throwaway repository root whose `family.json` names one local consumer, and runs that copy as CI does
// (GITHUB_ACTIONS=true, a summary file), with real git and real npm, offline: the candidate is a
// generated `footprintjs` archive, and the consumer's one check counts its runs in a file. The entry says
// `fallback: false`, so no published footprintjs has to be fetched; the npm on PATH answers `npm view`
// (the published version, which only the closing lines print) and hands everything else to the real npm.
describe('the script, run as CI runs it', () => {
  const PROCESS_TEST_MS = 120_000;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=audit', '-c', 'user.email=audit@example.invalid', ...args], {
      cwd,
      env: isolatedGitEnv(),
      stdio: 'ignore',
    });

  /** A repository root holding the audit's scripts, one consumer that fails its first `failFirst` runs, and a candidate. */
  function setUp(failFirst: number) {
    // The real path: the script runs only when it is the file node was started with (macOS's /tmp is a link).
    const root = realpathSync(temp());
    const repo = join(root, 'footPrint');
    cpSync(resolve('scripts'), join(repo, 'scripts'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(repo, 'node_modules'));
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'footprintjs', dependencies: { foottrace: '*' } }),
    );
    const counter = join(root, 'runs.txt');
    const check = `node count.cjs ${counter} ${failFirst}`;
    writeFileSync(
      join(repo, 'scripts/family.json'),
      JSON.stringify({
        family: [
          {
            package: 'app',
            repo: 'test/app',
            branch: 'main',
            dir: 'app',
            install: 'true',
            fallback: false,
            checks: [check],
          },
        ],
      }),
    );

    const org = join(root, 'org');
    const app = join(org, 'app');
    mkdirSync(app, { recursive: true });
    const manifest = { name: 'app', version: '0.0.0', private: true, dependencies: { footprintjs: '^1.0.0' } };
    writeFileSync(join(app, 'package.json'), JSON.stringify(manifest));
    writeFileSync(
      join(app, 'package-lock.json'),
      JSON.stringify({ name: 'app', version: '0.0.0', lockfileVersion: 3, requires: true, packages: { '': manifest } }),
    );
    writeFileSync(
      join(app, 'count.cjs'),
      "const fs = require('fs');\nconst [file, failFirst] = process.argv.slice(2);\n" +
        "const runs = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;\n" +
        'fs.writeFileSync(file, String(runs));\nprocess.exit(runs <= Number(failFirst) ? 1 : 0);\n',
    );
    git(app, 'init', '-q', '-b', 'main');
    git(app, 'add', '.');
    git(app, 'commit', '-q', '-m', 'consumer');

    const env = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? root,
      TMPDIR: tmpdir(),
      npm_config_cache: join(root, 'npm-cache'),
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
    };
    const pkg = join(root, 'pkg');
    mkdirSync(pkg);
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'footprintjs', version: '1.0.0', main: 'index.js' }),
    );
    writeFileSync(join(pkg, 'index.js'), 'module.exports = {};\n');
    execFileSync('npm', ['pack', '--pack-destination', root], { cwd: pkg, env, stdio: 'ignore' });

    const bin = join(root, 'bin');
    mkdirSync(bin);
    const realNpm = execFileSync('bash', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'npm'),
      `#!/bin/bash\n[[ "$1" == view ]] && { echo 1.0.0; exit 0; }\nexec "${realNpm}" "$@"\n`,
      {
        mode: 0o755,
      },
    );

    const summary = join(root, 'summary.md');
    const ran = () => {
      const child = spawnSync(
        process.execPath,
        [
          join(repo, 'scripts/audit-consumers.mjs'),
          '--local',
          '--org',
          org,
          '--only',
          'app',
          '--candidate',
          join(root, 'footprintjs-1.0.0.tgz'),
          '--base-version',
          '1.0.0',
        ],
        {
          encoding: 'utf8',
          timeout: PROCESS_TEST_MS - 10_000,
          env: { ...env, PATH: `${bin}:${env.PATH}`, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
        },
      );
      const lines = child.stdout.split('\n');
      return {
        status: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
        // Every command the audit ran through its one runner, in order (CI wraps each in a group).
        commands: lines.filter((line) => line.startsWith('::group::')).map((line) => line.slice('::group::'.length)),
        runs: existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0,
        summary: () => readFileSync(summary, 'utf8'),
      };
    };
    return { ran, check };
  }
  /** The candidate's install command, as the audit printed it (its archive path is the run's own). */
  const installCommand = (stdout: string) =>
    (stdout.split('\n').find((line) => line.startsWith('::group::npm install')) ?? '').slice('::group::'.length);

  it(
    'a green consumer: the commands of today, once each, exit 0',
    () => {
      const { ran, check } = setUp(0);
      const result = ran();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.runs).toBe(1);
      expect(result.commands).toEqual([
        expect.stringMatching(/^git clone --quiet /),
        'true',
        installCommand(result.stdout),
        check,
      ]);
      expect(result.stdout).toMatch(/\napp: pass \(/);
      expect(result.summary()).toContain('| Step | Candidate | Published |');
    },
    PROCESS_TEST_MS,
  );

  it(
    'a check that fails once and passes on the second run: flaky, exit 0, the commands run twice',
    () => {
      const { ran, check } = setUp(1);
      const result = ran();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.runs).toBe(2);
      const install = installCommand(result.stdout);
      expect(result.commands).toEqual([
        expect.stringMatching(/^git clone --quiet /),
        'true',
        install,
        check,
        install,
        check,
      ]);
      expect(result.stdout).toMatch(/\napp: flaky \(/);
      expect(result.stdout).toContain(
        `::warning title=app: flaky::red once on the candidate, green on a second run of the same code: ${check}.`,
      );
      expect(result.stdout).toContain(
        '1 consumer(s) flaky (red once on the candidate, green on a second run of the same code): app.',
      );
      expect(result.summary()).toContain('### app: flaky');
      expect(result.summary()).toContain('| Step | Candidate | Published | Candidate again |');
    },
    PROCESS_TEST_MS,
  );

  it(
    'a check that fails twice: BLOCKING, exit 1, and exactly one repeat',
    () => {
      const { ran } = setUp(99);
      const result = ran();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.runs).toBe(2);
      expect(result.stdout).toMatch(/\napp: BLOCKING \(/);
      expect(result.stdout).toContain(
        '::error title=app: BLOCKING::red on the candidate (fallback: false — no published leg)',
      );
      expect(result.stdout).toContain('; red again on a second run of the same candidate: ');
    },
    PROCESS_TEST_MS,
  );
});
