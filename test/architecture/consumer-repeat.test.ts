/**
 * Before a consumer blocks, its failure must repeat (scripts/audit-consumers.mjs · judge,
 * judgeOutOfRange, repeatKeys, repeatOutcome, prepareWorkspace, clone, audit, report, main).
 *
 * WHY: on 12 Nov 2026 a pull request that changed ten lines of one Markdown file was BLOCKING on
 * vizfootprint, because one of its own tests failed by chance on the candidate leg and passed on
 * the published leg (Consumers run 43261862232, job 131335570060). A check red once and green on a
 * second run of the same code says nothing about the candidate. The second run is the whole candidate
 * leg again in a FRESH workspace at the same commits: a check may trust what the published leg left
 * in the first one (`tsc -b`'s build info; second read of #204, B1).
 *
 * Every leg here is injected; consumer-repeat-process.test.ts runs the real script in a child process.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  audit,
  clone,
  declaredRange,
  judge,
  judgeOutOfRange,
  main,
  repeatHome,
  repeatKeys,
  repeatOutcome,
} from '../../scripts/audit-consumers.mjs';
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
/** One leg: the install, then each check's result; every check is skipped when the install is red. */
const legOf = (install: boolean, ...oks: boolean[]): Step[] => [
  { key: 'install footprintjs', ok: install, seconds: 1 },
  ...oks.map((ok, i) =>
    install ? { key: CHECKS[i], ok, seconds: 1 } : { key: CHECKS[i], ok: false, skipped: true, seconds: 0 },
  ),
];
// The 12 Nov shape: the test red on the candidate, everything green on the published footprintjs.
const RED_ONCE = legOf(true, true, false, true);
const GREEN = legOf(true, true, true, true);
// The second run is the whole candidate leg again.
const RED_AGAIN = legOf(true, true, false, true);
const NOT_INSTALLED = legOf(false, false, false, false);

const entry = {
  package: 'app',
  repo: 'test/app',
  branch: 'main',
  dir: 'app',
  checks: CHECKS,
  installStrategy: 'packaged',
};
const CANDIDATE = '/candidate.tgz';
const COMMIT = 'c0ffee0000000000000000000000000000000001';

/**
 * A consumer that may block (no lock: its range is not read, so it is judged as it always was). The
 * log holds every clone (`clone <dir>`, `@<commit>` when one is asked for), command and leg, in order.
 */
function mayBlock(legs: (Step[] | null)[], manifest: object = { name: 'app', peerDependencies: { footprintjs: '*' } }) {
  const queue = [...legs];
  const log: string[] = [];
  const io = {
    clone: vi.fn((spec: { dir: string; commit?: string }, dir: string): string | null => {
      log.push(`clone ${spec.dir}${spec.commit ? `@${spec.commit}` : ''}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
      return null;
    }),
    run: vi.fn((command: string) => {
      log.push(command);
      return { ok: true, seconds: 1 };
    }),
    read: vi.fn((_command: string, args: string[]) => (args.includes('--short') ? 'c0ffee0' : COMMIT)),
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
  const made = mayBlock(legs, { name: 'app', dependencies: { footprintjs: '^11.2.0' } });
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
/** `main` for one consumer, its audit run on `io`; `homes` collects each consumer's second-run workspace. */
const mainWith = (io: ReturnType<typeof mayBlock>['io'], argv: string[] = [], homes: string[] = []) =>
  main(['--only', 'hcifootprint', '--candidate', '/candidate.tgz', ...argv], {
    read: vi.fn(() => '{"version":"10.0.0"}'),
    latest: vi.fn(() => '9.48.3'),
    recordSymbolsAt: vi.fn(() => new Set()),
    audit: (selected: { package: string }, ws: string, ctx: object, opts: object) => {
      homes.push(repeatHome(ws, selected));
      return audit(selected, ws, ctx, opts, io);
    },
    report: vi.fn(),
  });

describe('a green audit runs exactly the commands it ran before the rule', () => {
  it('all green: one clone, one install of the consumer, one candidate leg, nothing else', () => {
    const { io, log } = mayBlock([GREEN]);
    const actual = audit({ ...entry, installStrategy: 'linked', setup: 'download-browser' }, temp(), context, {}, io);
    expect(actual.verdict).toBe('pass');
    expect(log).toEqual([
      'clone app',
      'npm install --no-audit --no-fund',
      `install ${CANDIDATE}`,
      'download-browser',
      ...CHECKS,
    ]);
    expect(actual.published).toBeNull();
    expect(actual.repeat).toBeUndefined();
  });

  it.each([
    ['own failure: red on both', [RED_ONCE, RED_ONCE], 'own failure'],
    ['the candidate did not install, the published one did', [NOT_INSTALLED, GREEN], 'BLOCKING'],
    ['the published leg did not install', [RED_ONCE, NOT_INSTALLED], 'no verdict'],
  ])('%s: two legs, no repeat', (_name, legs, verdict) => {
    const { io, log } = mayBlock(legs);
    const actual = audit(entry, temp(), context, {}, io);
    expect(actual.verdict).toBe(verdict);
    expect(log).toEqual(['clone app', `install ${CANDIDATE}`, ...CHECKS, 'install footprintjs@9.48.3', ...CHECKS]);
    expect(actual.repeat).toBeUndefined();
  });

  it('reports only, all green: one leg', () => {
    const { io, log } = reportsOnly([GREEN]);
    const ws = temp();
    expect(audit(entry, ws, ctx12, {}, io).verdict).toBe('opt-in needed');
    expect(log).toEqual([
      'clone app',
      `install ${join(ws, 'app/relabelled/footprintjs-candidate-as-11.2.0.tgz')}`,
      ...CHECKS,
    ]);
  });
});

describe('the verdict table: the second candidate run decides', () => {
  it.each([
    {
      name: 'a repeated check is red again',
      repeat: RED_AGAIN,
      mayBlockVerdict: 'BLOCKING',
      reportsOnlyVerdict: 'needs migration',
    },
    { name: 'every repeated check is green', repeat: GREEN, mayBlockVerdict: 'flaky', reportsOnlyVerdict: 'flaky' },
    {
      name: 'the candidate cannot be installed again',
      repeat: NOT_INSTALLED,
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
        [GREEN, 'flaky'],
        [NOT_INSTALLED, notCarriedOut],
      ] as const) {
        const { io, log } = consumer([RED_ONCE, GREEN, repeat]);
        const ws = temp();
        const actual = audit(entry, ws, ctx, {}, io);
        const tested = spec === 'relabelled' ? join(ws, 'app/relabelled/footprintjs-candidate-as-11.2.0.tgz') : spec;
        expect(actual.verdict, verdict).toBe(verdict);
        // The second run: a new clone at the audited commit, then the whole candidate leg again.
        expect(log).toEqual([
          'clone app',
          `install ${tested}`,
          ...CHECKS,
          `install ${published}`,
          ...CHECKS,
          `clone app@${COMMIT}`,
          `install ${tested}`,
          ...CHECKS,
        ]);
        expect(actual.repeat).toEqual(repeat);
        expect(actual.repeated).toEqual(['npm test']);
      }
    },
  );

  it('fallback: false — the same repeat before it blocks; no published leg', () => {
    for (const [repeat, verdict] of [
      [RED_AGAIN, 'BLOCKING'],
      [GREEN, 'flaky'],
      [NOT_INSTALLED, 'no verdict'],
    ] as const) {
      const { io, log } = mayBlock([RED_ONCE, repeat]);
      const actual = audit({ ...entry, fallback: false }, temp(), context, {}, io);
      expect(actual.verdict).toBe(verdict);
      expect(actual.published).toBeNull();
      expect(log).toEqual([
        'clone app',
        `install ${CANDIDATE}`,
        ...CHECKS,
        `clone app@${COMMIT}`,
        `install ${CANDIDATE}`,
        ...CHECKS,
      ]);
    }
  });
});

describe('the second run stands in a fresh workspace, at the commits the first one audited', () => {
  it('new dirs, manifests and install options; the same candidate, pins, checks and notes; exactly once', () => {
    const { io } = mayBlock([RED_ONCE, GREEN, RED_AGAIN, GREEN, GREEN]);
    const ws = temp();
    audit({ ...entry, registry: ['agentfootprint'] }, ws, context, {}, io);
    expect(io.leg).toHaveBeenCalledTimes(3);
    const [first, , again] = io.leg.mock.calls;
    for (const i of [0, 2, 3, 4]) expect(again[i], `argument ${i}`).toBe(first[i]);
    expect(again[2]).toEqual(['agentfootprint@9.48.3']);
    // Nothing of the first workspace: its dirs, its manifests, its install options.
    expect(first[1]).toEqual([join(ws, 'app/app')]);
    expect(again[1]).toEqual([join(repeatHome(ws, entry), 'app')]);
    expect(again[5]).toEqual(again[1]);
    expect(again[6]).not.toBe(first[6]);
    expect([...again[6].keys()]).toEqual(again[1]);
    expect(again[7]).not.toBe(first[7]);
    expect(again[7]).toMatchObject({ strategy: 'packaged', sourceOnly: [] });
    // Beside the first workspace, not inside it: no folder above the fresh checkout is the first one's.
    expect(repeatHome(ws, entry).startsWith(join(ws, 'app') + '/')).toBe(false);
  });

  it('every checkout, siblings too, is cloned again at the commit read from the first workspace', () => {
    const { io, log } = mayBlock([RED_ONCE, GREEN, RED_AGAIN]);
    const ws = temp();
    audit(
      { ...entry, siblings: [{ repo: 'test/agent', branch: 'main', dir: 'agent', sourceOnly: true }] },
      ws,
      context,
      {},
      io,
    );
    expect(log.filter((line) => line.startsWith('clone'))).toEqual([
      'clone app',
      'clone agent',
      `clone app@${COMMIT}`,
      `clone agent@${COMMIT}`,
    ]);
    expect(io.read).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], join(ws, 'app/app'));
    expect(io.read).toHaveBeenCalledWith('git', ['rev-parse', 'HEAD'], join(ws, 'app/agent'));
    expect(io.leg.mock.calls[2][7].sourceOnly).toEqual([join(repeatHome(ws, entry), 'agent')]);
  });

  it.each([
    ['may block', 'no verdict', mayBlock, context],
    ['reports only', 'needs migration', reportsOnly, ctx12],
  ] as const)(
    '%s: a fresh workspace that cannot be made at the audited commit → %s',
    (_kind, verdict, consumer, ctx) => {
      const { io } = consumer([RED_ONCE, GREEN]);
      const firstClone = io.clone.getMockImplementation() ?? (() => null);
      io.clone.mockImplementation((spec: { dir: string; commit?: string }, dir: string) =>
        spec.commit ? `could not check out test/app at the audited commit ${spec.commit}` : firstClone(spec, dir),
      );
      const actual = audit(entry, temp(), ctx, {}, io);
      expect(actual.verdict).toBe(verdict);
      expect(io.leg).toHaveBeenCalledTimes(2);
      expect(actual.repeat).toBeNull();
      expect(actual.notes).toContain(
        `second candidate run: not carried out: a fresh workspace could not be made (could not check out test/app at the audited commit ${COMMIT})`,
      );
    },
  );

  it('main removes the second workspace with the first, and --keep keeps both', () => {
    const kept: string[] = [];
    roots.push(mainWith(mayBlock([RED_ONCE, GREEN, RED_AGAIN]).io, ['--keep'], kept).workspace);
    expect(existsSync(join(kept[0], 'hcifootprint/package.json'))).toBe(true);
    const removed: string[] = [];
    expect(mainWith(mayBlock([RED_ONCE, GREEN, RED_AGAIN]).io, [], removed).exitCode).toBe(1);
    expect(existsSync(removed[0])).toBe(false);
  });
});

describe('clone at a commit: the second run proves where it stands', () => {
  const services = (heads: string[]) => {
    const queue = [...heads];
    return {
      run: vi.fn(() => ({ ok: true })),
      read: vi.fn(() => (queue.length > 1 ? queue.shift() : queue[0]) as string),
    };
  };
  const spec = { ...entry, commit: COMMIT };
  const MOVED = '0'.repeat(40);

  it('already at the commit: the clone only, nothing fetched', () => {
    const io = services([COMMIT]);
    expect(clone(spec, '/ws/app', { local: false }, io)).toBeNull();
    expect(io.run).toHaveBeenCalledTimes(1);
  });

  it('the branch moved on (from GitHub): the commit is fetched and checked out, then HEAD is read back', () => {
    const io = services([MOVED, COMMIT]);
    expect(clone(spec, '/ws/app', { local: false }, io)).toBeNull();
    expect(io.run.mock.calls[1]).toEqual([
      `git fetch --quiet --depth 1 origin '${COMMIT}' && git checkout --quiet --detach '${COMMIT}'`,
      '/ws/app',
    ]);
  });

  it('the branch moved on (--local): checked out from the local clone, no fetch, no staleness line', () => {
    const org = temp();
    mkdirSync(join(org, 'app/.git'), { recursive: true });
    const io = services([MOVED, COMMIT]);
    expect(clone(spec, '/ws/app', { local: true, org }, io)).toBeNull();
    expect(io.run.mock.calls[1]).toEqual([`git checkout --quiet --detach '${COMMIT}'`, '/ws/app']);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('a commit that can no longer be reached: a note, so the run is not carried out', () => {
    expect(clone(spec, '/ws/app', { local: false }, services([MOVED]))).toBe(
      `could not check out test/app at the audited commit ${COMMIT}`,
    );
  });
});

describe('what the second run judges', () => {
  it('only checks red on the candidate and green on the published leg are judged; one red on both is not', () => {
    // build red on both (its own failure), test red only on the candidate, lint green.
    const candidate = legOf(true, false, false, true);
    const published = legOf(true, false, true, true);
    expect(repeatKeys(candidate, published)).toEqual(['npm test']);
    // build runs again and must do what it did the first time: red.
    expect(judge(candidate, published, true, legOf(true, false, true, true))).toBe('flaky');
    expect(judge(candidate, published, true, legOf(true, false, false, true))).toBe('BLOCKING');
  });

  it('a check red on both and nothing else red: own failure, no repeat', () => {
    expect(repeatKeys(RED_ONCE, RED_ONCE)).toEqual([]);
    expect(judge(RED_ONCE, RED_ONCE, true, GREEN)).toBe('own failure');
  });

  it('a candidate that did not install is not repeated: its checks never ran, so nothing was red once', () => {
    expect(repeatKeys(NOT_INSTALLED, GREEN)).toEqual([]);
    expect(judge(NOT_INSTALLED, GREEN)).toBe('BLOCKING');
    expect(judgeOutOfRange(NOT_INSTALLED, GREEN)).toBe('needs migration');
    expect(repeatKeys(NOT_INSTALLED, null, false)).toEqual([]);
  });

  it('several checks red only on the candidate: one red again blocks', () => {
    const candidate = legOf(true, false, true, false);
    expect(repeatKeys(candidate, GREEN)).toEqual(['npm run build', 'npm run lint']);
    expect(judge(candidate, GREEN, true, GREEN)).toBe('flaky');
    expect(judge(candidate, GREEN, true, legOf(true, true, true, false))).toBe('BLOCKING');
    expect(judge(candidate, GREEN, true, legOf(true, false, true, true))).toBe('BLOCKING');
  });
});

describe('fail closed: flaky needs every check of the second run to have RUN, the repeated ones green', () => {
  const at = (i: number, step: object) => GREEN.map((s, k) => (k === i ? { ...s, ...step } : s));
  const holed = [...GREEN];
  delete holed[2];
  it.each([
    ['the install red again', NOT_INSTALLED],
    // The guard on the install itself (N5): a red install whose checks (somehow) ran green.
    ['the install red, its checks green and not skipped', at(0, { ok: false })],
    ['the install step under another key', at(0, { key: 'install' })],
    ['a repeated check skipped', at(2, { ok: false, skipped: true })],
    ['a repeated check marked ok but skipped', at(2, { skipped: true })],
    ['a check missing', legOf(true, true, true)],
    ['a check more than planned', [...GREEN, { key: 'npm run extra', ok: true, seconds: 1 }]],
    ['checks in another order', [GREEN[0], GREEN[2], GREEN[1], GREEN[3]]],
    ['a check before the red one did not do what it did the first time', legOf(true, false, true, true)],
    ['a check after the red one did not do what it did the first time', legOf(true, true, true, false)],
    ['an ok that is not a boolean', at(2, { ok: 'yes' })],
    // N4: `every` and `some` skip holes.
    ['a hole where a check should be', holed],
    ['no steps', []],
    ['nothing', undefined],
  ])('%s → no verdict (reports only: needs migration), never flaky', (_name, repeat) => {
    expect(repeatOutcome(RED_ONCE, ['npm test'], repeat as Step[])).toBe('not carried out');
    expect(judge(RED_ONCE, GREEN, true, repeat as Step[])).toBe('no verdict');
    expect(judgeOutOfRange(RED_ONCE, GREEN, true, repeat as Step[])).toBe('needs migration');
  });

  it('the audit says why there is no verdict', () => {
    const { io } = mayBlock([RED_ONCE, GREEN, NOT_INSTALLED]);
    const actual = audit(entry, temp(), context, {}, io);
    expect(actual.verdict).toBe('no verdict');
    expect(actual.notes).toContain(
      'second candidate run: not carried out (the candidate did not install again, or a check did not run as it did the first time), so the red checks were not confirmed',
    );
  });

  it('a repeat that throws stops the audit, as a first leg that throws does: it is never flaky', () => {
    const { io } = mayBlock([]);
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
  const reportWith = async (githubActions: string | undefined) => {
    vi.stubEnv('GITHUB_ACTIONS', githubActions);
    vi.resetModules();
    const { report } = await import('../../scripts/audit-consumers.mjs');
    const summary = join(temp(), 'summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summary);
    return { report, summary, lines: () => vi.mocked(console.log).mock.calls.map(([line]) => String(line)) };
  };

  it.each([
    { githubActions: undefined, warning: '  WARNING: ', error: '  ERROR: ' },
    { githubActions: 'true', warning: '::warning title=app: flaky::', error: '::error title=app: BLOCKING::' },
  ])(
    'flaky is a warning that names the check; BLOCKING names both runs ($githubActions)',
    async ({ githubActions, warning, error }) => {
      const { report, summary, lines } = await reportWith(githubActions);
      const runs = { candidate: RED_ONCE, published: GREEN, repeated: ['npm test'] };
      report({ ...base, ...runs, verdict: 'flaky', repeat: GREEN }, context);
      report({ ...base, ...runs, verdict: 'BLOCKING', repeat: RED_AGAIN }, context);
      report({ ...base, verdict: 'pass', candidate: GREEN, published: null }, context);
      expect(lines()).toContain(
        `${warning}red once on the candidate, green on a second run of the same code: npm test. Not blocking; a check that fails and passes on the same code hides real failures, so fix it in test/app`,
      );
      expect(lines()).toContain(
        `${error}red only on the candidate: npm test; red again on a second run of the same candidate in a fresh workspace: npm test`,
      );
      expect(lines()).toContain(
        '  npm test                     candidate RED 1 s      published green 1 s    candidate again green 1 s',
      );
      // The pass: two columns, as before.
      expect(lines()).toContain('  npm test                     candidate green 1 s    published —');
      const text = readFileSync(summary, 'utf8');
      expect(text).toContain('### app: flaky');
      expect(text).toContain('| Step | Candidate | Published | Candidate again |\n|---|---|---|---|');
      expect(text).toContain('| `npm test` | RED 1 s | green 1 s | green 1 s |');
      const pass = text.slice(text.indexOf('### app: pass'));
      expect(pass).toContain('| Step | Candidate | Published |\n|---|---|---|\n');
      expect(pass).not.toContain('again');
    },
  );

  it('N1: a reports-only second run that was not carried out is never called red again', async () => {
    const { report, lines } = await reportWith('true');
    const r = { ...base, candidate: RED_ONCE, published: GREEN, repeated: ['npm test'], range: { mayBlock: false } };
    report({ ...r, verdict: 'needs migration', repeat: NOT_INSTALLED }, context);
    report({ ...r, verdict: 'needs migration', repeat: null }, context);
    report({ ...r, verdict: 'needs migration', repeat: RED_AGAIN }, context);
    const warnings = lines().filter((line) => line.startsWith('::warning'));
    for (const notCarriedOut of warnings.slice(0, 2)) {
      expect(notCarriedOut).toContain(
        '; a second run of the same candidate was not carried out, so this is not confirmed',
      );
      expect(notCarriedOut).not.toContain('red again');
    }
    expect(warnings[2]).toContain('; red again on a second run of the same candidate in a fresh workspace: npm test');
  });

  it('N2: BLOCKING names only the checks red again, and says which were green', async () => {
    const { report, lines } = await reportWith('true');
    const repeated = { candidate: legOf(true, false, false, true), published: GREEN, repeat: RED_AGAIN };
    report({ ...base, ...repeated, verdict: 'BLOCKING', repeated: ['npm run build', 'npm test'] }, context);
    expect(lines()).toContain(
      '::error title=app: BLOCKING::red only on the candidate: npm run build, npm test; red again on a second run of the same candidate in a fresh workspace: npm test; green on that run: npm run build',
    );
  });

  it('N3: flaky does not hide an own failure beside it', async () => {
    const { report, lines } = await reportWith('true');
    const runs = {
      candidate: legOf(true, false, false, true),
      published: legOf(true, false, true, true),
      repeat: legOf(true, false, true, true),
    };
    report({ ...base, ...runs, verdict: 'flaky', repeated: ['npm test'] }, context);
    expect(lines()).toContain(
      '::warning title=app: flaky::red once on the candidate, green on a second run of the same code: npm test. Red on the published 9.48.3 too, its own failure: npm run build. Not blocking; a check that fails and passes on the same code hides real failures, so fix it in test/app',
    );
  });

  it('exit code 0 for flaky, 1 for BLOCKING and no verdict; the closing lines name the flaky consumers', () => {
    expect(mainWith(mayBlock([RED_ONCE, GREEN, GREEN]).io)).toMatchObject({
      exitCode: 0,
      results: [{ verdict: 'flaky' }],
    });
    const lines = vi.mocked(console.log).mock.calls.map(([line]) => line);
    expect(lines).toContain('\nno consumer blocks this candidate.');
    expect(lines).toContain(
      '1 consumer(s) flaky (red once on the candidate, green on a second run of the same code): hcifootprint.',
    );
    expect(mainWith(mayBlock([RED_ONCE, GREEN, RED_AGAIN]).io)).toMatchObject({
      exitCode: 1,
      results: [{ verdict: 'BLOCKING' }],
    });
    expect(mainWith(mayBlock([RED_ONCE, GREEN, NOT_INSTALLED]).io)).toMatchObject({
      exitCode: 1,
      results: [{ verdict: 'no verdict' }],
    });
    vi.mocked(console.log).mockClear();
    mainWith(mayBlock([GREEN]).io);
    expect(vi.mocked(console.log).mock.calls.some(([line]) => String(line).includes('flaky'))).toBe(false);
  });
});
