/**
 * The range rule wired into the audit (scripts/audit-consumers.mjs · audit, planRange, report, main).
 * Real `declaredRange` and `decideRange`; the clone, lock, registry, relabel and both legs injected.
 * Nothing here reaches the network.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  audit,
  cli,
  declaredRange,
  judge,
  judgeOutOfRange,
  main,
  parseArgs,
  requireBaseVersion,
} from '../../scripts/audit-consumers.mjs';
import { lockOf, peer, PUBLISHED } from '../helpers/consumerRange';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'consumer-range-audit-'));
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
const steps = (install = true, check = true): Step[] => [
  { key: 'install footprintjs', ok: install, seconds: 1 },
  { key: 'npm test', ok: check, seconds: 1, ...(!install ? { skipped: true } : {}) },
];
// Red on the candidate, green on the published footprintjs, and red again on a second run of the
// candidate: a failure that repeats, so it is evidence about the candidate (audit-consumers.mjs · judge).
const RED_ONLY_ON_CANDIDATE = [steps(true, false), steps(), steps(true, false)];
const entry = { package: 'app', repo: 'test/app', branch: 'main', dir: 'app', checks: ['npm test'] };
const CANDIDATE = '/candidate/footprintjs-candidate.tgz';
const ctxOf = (candidateVersion: string, baseVersion?: string, published = '11.2.0') => ({
  candidate: CANDIDATE,
  candidateVersion,
  published,
  ...(baseVersion ? { baseVersion } : {}),
});

/** One consumer: its manifest, its lock and its legs, everything else injected. */
function consumer(manifest: object, lock: object = lockOf({}), legs: Step[][] = [steps()], pins = {}) {
  const queue = [...legs];
  const io = {
    clone: vi.fn((_entry, dir) => {
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
      return null;
    }),
    run: vi.fn(() => ({ ok: true, seconds: 1 })),
    read: vi.fn(() => 'abcd123'),
    latest: vi.fn(() => '14.3.1'),
    advancedImports: vi.fn(() => ({ lines: 0, record: [], other: [], unresolved: false })),
    leg: vi.fn(() => queue.shift() ?? null),
    declaredRange: vi.fn((dirs, pinList, originals) =>
      declaredRange(dirs, pinList, originals, {
        installedTree: () => lock,
        publishedPeers: (pin: string) => (pins as Record<string, object>)[pin] ?? {},
      }),
    ),
    publishedVersions: vi.fn(() => PUBLISHED),
    relabelCandidate: vi.fn((_input, version, folder) => join(folder, `footprintjs-candidate-as-${version}.tgz`)),
  };
  return io;
}
const legSpecs = (io: ReturnType<typeof consumer>) => io.leg.mock.calls.map((call) => call[0]);
const relabelled = (ws: string, version: string) =>
  join(ws, 'app/relabelled', `footprintjs-candidate-as-${version}.tgz`);

describe('row 1: may block, real label — today’s ordinary pull request', () => {
  it.each([
    [[steps()], 'pass'],
    [[steps(true, false), steps(), steps(true, false)], 'BLOCKING'],
    [[steps(true, false), steps(true, false)], 'own failure'],
    [[steps(false, false), steps(false, false)], 'no verdict'],
  ] as const)('%j → %s, judged by judge, on the real candidate and latest', (legs, verdict) => {
    const io = consumer({ peerDependencies: { footprintjs: '^11.1.0' } }, lockOf({}), [...legs]);
    const actual = audit(entry, temp(), ctxOf('11.2.0', '11.2.0'), {}, io);
    expect(actual.verdict).toBe(verdict);
    expect(judge(legs[0], legs[1] ?? null, true, legs[2] ?? null)).toBe(verdict);
    expect(legSpecs(io)).toEqual([CANDIDATE, 'footprintjs@11.2.0', CANDIDATE].slice(0, legs.length));
    expect(io.relabelCandidate).not.toHaveBeenCalled();
    expect(io.publishedVersions).not.toHaveBeenCalled();
    expect(actual.range).toEqual({ mayBlock: true });
    expect(actual.notes).toContain('range: accepts base 11.2.0 and candidate 11.2.0.');
  });
});

describe('row 2: may block, relabelled — a break still blocks', () => {
  it('the 12.0.0 heading pull request on base 11.2.0: red only on the candidate’s code is BLOCKING', () => {
    const io = consumer({ peerDependencies: { footprintjs: '^11.1.0' } }, lockOf({}), RED_ONLY_ON_CANDIDATE);
    const ws = temp();
    const actual = audit(entry, ws, ctxOf('12.0.0', '11.2.0'), {}, io);
    expect(actual.verdict).toBe('BLOCKING');
    expect(legSpecs(io)).toEqual([relabelled(ws, '11.2.0'), 'footprintjs@11.2.0', relabelled(ws, '11.2.0')]);
    expect(actual.range).toEqual({ mayBlock: true, accepted: '11.2.0', optIn: true });
  });

  // The reader's cheat.mjs, exactly: no base given, so the base is the candidate's own 12.0.0.
  it.each([
    [
      'a dev-only tree peer',
      { name: 'app', peerDependencies: { footprintjs: '>=11' }, devDependencies: { 'old-helper': '1.0.0' } },
      lockOf({ 'node_modules/old-helper': { ...peer('1.0.0', '^11.0.0'), dev: true } }),
    ],
    [
      'a workspace demo peer (the hcifootprint shape)',
      { name: 'app', dependencies: { footprintjs: '^11.0.0 || ^12.0.0' }, workspaces: ['demos/*'] },
      lockOf({
        'demos/chat': { name: 'chat-demo' },
        'demos/chat/node_modules/agentfootprint': peer('14.0.0', '^11.0.0'),
      }),
    ],
    ['control, no tree peer', { name: 'app', peerDependencies: { footprintjs: '>=11' } }, lockOf({})],
  ])('B1: %s — still BLOCKING', (_name, manifest, lock) => {
    const io = consumer(manifest, lock, RED_ONLY_ON_CANDIDATE);
    expect(audit(entry, temp(), ctxOf('12.0.0'), {}, io).verdict).toBe('BLOCKING');
  });

  it('B1, a stale dev peer no published version satisfies: the real candidate, judged as before', () => {
    const lock = lockOf({ 'node_modules/x': { ...peer('1.0.0', '^10.0.0'), dev: true } });
    const io = consumer({ peerDependencies: { footprintjs: '>=11' } }, lock, RED_ONLY_ON_CANDIDATE);
    const actual = audit(entry, temp(), ctxOf('12.0.0'), {}, io);
    expect(actual.verdict).toBe('BLOCKING');
    expect(legSpecs(io)).toEqual([CANDIDATE, 'footprintjs@11.2.0', CANDIDATE]);
    expect(io.relabelCandidate).not.toHaveBeenCalled();
  });

  // The reader's cheat3.mjs: the PR's own label must not decide who may block it.
  it.each(['11.2.0', '99.0.0', '11.2.1-x'])('B2: candidate label %s on base 11.2.0 is BLOCKING', (label) => {
    const io = consumer({ peerDependencies: { footprintjs: '^11.1.0' } }, lockOf({}), RED_ONLY_ON_CANDIDATE);
    expect(audit(entry, temp(), ctxOf(label, '11.2.0'), {}, io).verdict).toBe('BLOCKING');
  });

  it('B2, a minor rc on main: base and candidate 11.3.0-rc.0 still block', () => {
    const io = consumer({ peerDependencies: { footprintjs: '>=11' } }, lockOf({}), RED_ONLY_ON_CANDIDATE);
    const ws = temp();
    const actual = audit(entry, ws, ctxOf('11.3.0-rc.0', '11.3.0-rc.0'), {}, io);
    expect(actual.verdict).toBe('BLOCKING');
    expect(legSpecs(io)[0]).toBe(relabelled(ws, '11.2.0'));
  });

  it('M11: the published leg installs the accepted version, not latest', () => {
    const io = consumer({ dependencies: { footprintjs: '11.1.0' } }, lockOf({}), RED_ONLY_ON_CANDIDATE);
    const ws = temp();
    const actual = audit(entry, ws, ctxOf('12.0.0', '11.1.0', '12.0.0'), {}, io);
    expect(actual.verdict).toBe('BLOCKING');
    expect(legSpecs(io)).toEqual([relabelled(ws, '11.1.0'), 'footprintjs@11.1.0', relabelled(ws, '11.1.0')]);
  });

  it('M18: the label satisfies every declaration, including those that accept the candidate', () => {
    const lock = lockOf({ 'node_modules/a': peer('1.0.0', '^11.0.0') });
    const io = consumer({ peerDependencies: { footprintjs: '>=11.1.0 <11.2.0 || >=12.0.0' } }, lock);
    const ws = temp();
    audit(entry, ws, ctxOf('12.0.0', '12.0.0'), {}, io);
    expect(io.relabelCandidate).toHaveBeenCalledWith(CANDIDATE, '11.1.0', join(ws, 'app/relabelled'));
  });

  it('a relabelled archive that fails its check: no verdict, nothing installed', () => {
    const io = consumer({ peerDependencies: { footprintjs: '^11.1.0' } });
    io.relabelCandidate.mockImplementation(() => {
      throw new Error('the relabelled archive changed package/dist/index.js');
    });
    const actual = audit(entry, temp(), ctxOf('12.0.0', '11.2.0'), {}, io);
    expect(actual.verdict).toBe('no verdict');
    expect(io.leg).not.toHaveBeenCalled();
    expect(actual.notes.at(-1)).toContain('could not relabel the candidate as 11.2.0');
    expect(actual.range).toEqual({ mayBlock: true });
  });
});

describe('row 3: reports only, relabelled — base 12.0.0, a consumer still on ^11.2.0', () => {
  it.each([
    [[steps()], 'opt-in needed'],
    [[steps(true, false), steps(), steps(true, false)], 'needs migration'],
    [[steps(false, false), steps()], 'needs migration'],
    [[steps(true, false), steps(true, false)], 'own failure'],
    [[steps(false, false), steps(false, false)], 'no verdict'],
  ] as const)('%j → %s', (legs, verdict) => {
    const io = consumer({ dependencies: { footprintjs: '^11.2.0' } }, lockOf({}), [...legs]);
    const ws = temp();
    const actual = audit(entry, ws, ctxOf('12.0.0', '12.0.0', '12.0.0'), {}, io);
    expect(actual.verdict).toBe(verdict);
    expect(judgeOutOfRange(legs[0], legs[1] ?? null, true, legs[2] ?? null)).toBe(verdict);
    expect(legSpecs(io)).toEqual(
      [relabelled(ws, '11.2.0'), 'footprintjs@11.2.0', relabelled(ws, '11.2.0')].slice(0, legs.length),
    );
    expect(actual.notes).toContain(
      'range: refuses base 12.0.0 (own dependencies ^11.2.0): reports only. Tested as 11.2.0.',
    );
  });

  it('fallback: false — red on the candidate’s code is a migration, not a block', () => {
    const io = consumer({ dependencies: { footprintjs: '^11.2.0' } }, lockOf({}), [
      steps(true, false),
      steps(true, false),
    ]);
    expect(audit({ ...entry, fallback: false }, temp(), ctxOf('12.0.0', '12.0.0'), {}, io).verdict).toBe(
      'needs migration',
    );
    // No published leg; the second call is the candidate again.
    expect(io.leg).toHaveBeenCalledTimes(2);
  });

  it('no published version satisfies every declaration: own failure, nothing installed', () => {
    const io = consumer({ dependencies: { footprintjs: '^11.2.0' } });
    io.publishedVersions.mockReturnValue(['10.0.0', '12.0.0']);
    const actual = audit(entry, temp(), ctxOf('12.0.0', '12.0.0'), {}, io);
    expect(actual.verdict).toBe('own failure');
    expect(io.leg).not.toHaveBeenCalled();
    expect(actual.range).toEqual({ mayBlock: false, noAccepted: true });
  });
});

describe('row 4: reports only, real label — a candidate below the base', () => {
  it('installs the real candidate and judges without blocking', () => {
    const io = consumer({ dependencies: { footprintjs: '^11.2.0' } }, lockOf({}), RED_ONLY_ON_CANDIDATE);
    const actual = audit(entry, temp(), ctxOf('11.2.0', '12.0.0', '12.0.0'), {}, io);
    expect(actual.verdict).toBe('needs migration');
    expect(legSpecs(io)).toEqual([CANDIDATE, 'footprintjs@12.0.0', CANDIDATE]);
    expect(io.relabelCandidate).not.toHaveBeenCalled();
  });
});

describe('fail closed: what cannot be read', () => {
  it('a lock that cannot be read: it may block, the real candidate, and BLOCKING stays BLOCKING', () => {
    const io = consumer({ dependencies: { footprintjs: '^11.2.0' } }, { packages: [] }, RED_ONLY_ON_CANDIDATE);
    const actual = audit(entry, temp(), ctxOf('12.0.0', '12.0.0'), {}, io);
    expect(actual.verdict).toBe('BLOCKING');
    expect(legSpecs(io)).toEqual([CANDIDATE, 'footprintjs@11.2.0', CANDIDATE]);
    expect(io.relabelCandidate).not.toHaveBeenCalled();
    expect(actual.notes.join('\n')).toMatch(/range: not read/);
  });

  const versionsDown = (io: ReturnType<typeof consumer>) =>
    io.publishedVersions.mockImplementation(() => {
      throw new Error('registry unavailable');
    });

  it('a version list that cannot be read keeps the may-block answer: reports only stays reports only', () => {
    const io = consumer({ dependencies: { footprintjs: '^11.2.0' } }, lockOf({}), RED_ONLY_ON_CANDIDATE);
    versionsDown(io);
    const actual = audit(entry, temp(), ctxOf('12.0.0', '12.0.0', '12.0.0'), {}, io);
    expect(actual.verdict).toBe('needs migration');
    expect(legSpecs(io)).toEqual([CANDIDATE, 'footprintjs@12.0.0', CANDIDATE]);
    expect(io.relabelCandidate).not.toHaveBeenCalled();
    expect(actual.range).toEqual({ mayBlock: false, versionsUnread: true });
    expect(actual.notes.join('\n')).toContain('Published versions not read (registry unavailable)');
  });

  it('a version list that cannot be read: a consumer that may block is judged as before, on the real candidate', () => {
    const io = consumer({ peerDependencies: { footprintjs: '^11.1.0' } }, lockOf({}), RED_ONLY_ON_CANDIDATE);
    versionsDown(io);
    const actual = audit(entry, temp(), ctxOf('12.0.0', '11.2.0'), {}, io);
    expect(actual.verdict).toBe('BLOCKING');
    expect(legSpecs(io)).toEqual([CANDIDATE, 'footprintjs@11.2.0', CANDIDATE]);
  });
});

describe('R1: a statement that accepts a prerelease base as written may block', () => {
  it.each(['12.0.0-rc.0', '>=12.0.0-rc.0 <12.0.0'])(
    'own %s on base and candidate 12.0.0-rc.0, red only on the candidate: BLOCKING',
    (range) => {
      const io = consumer({ peerDependencies: { footprintjs: range } }, lockOf({}), RED_ONLY_ON_CANDIDATE);
      const actual = audit(entry, temp(), ctxOf('12.0.0-rc.0', '12.0.0-rc.0'), {}, io);
      expect(actual.verdict).toBe('BLOCKING');
      expect(actual.notes).toContain(
        'range: accepts base 12.0.0-rc.0 (as written or as 12.0.0) and candidate 12.0.0-rc.0.',
      );
    },
  );
});

describe('opt-in is a fact about statements', () => {
  it('a consumer on ^12.0.0 refusing an rc candidate only as a prerelease is not told to opt in', () => {
    const io = consumer({ peerDependencies: { footprintjs: '^12.0.0' } }, lockOf({}), [
      steps(false, false),
      steps(false, false),
    ]);
    const actual = audit(entry, temp(), ctxOf('12.0.0-rc.1', '12.0.0-rc.0'), {}, io);
    const line = actual.notes.find((note) => note.startsWith('range:'));
    expect(line).toBe(
      'range: accepts base 12.0.0-rc.0 (as written or as 12.0.0), so it can block. Refuses 12.0.0-rc.1 only as a prerelease (own peerDependencies ^12.0.0): it accepts 12.0.0. No published version satisfies every declaration: the candidate as is.',
    );
    expect(line).not.toContain('opt in');
  });

  it('relabelled for an rc candidate it accepts by its release: not on the must-opt-in list', () => {
    const io = consumer({ peerDependencies: { footprintjs: '^12.0.0' } });
    io.publishedVersions.mockReturnValue([...PUBLISHED, '12.0.0']);
    const actual = audit(entry, temp(), ctxOf('12.1.0-rc.0', '12.0.0'), {}, io);
    expect(actual.range).toEqual({ mayBlock: true, accepted: '12.0.0', optIn: false });
  });
});

describe('the base version reaches the script', () => {
  it('--base-version is validated, and defaults to the candidate’s own version', () => {
    expect(parseArgs(['--base-version', '11.2.0']).baseVersion).toBe('11.2.0');
    expect(parseArgs([]).baseVersion).toBeNull();
    for (const bad of ['v11.2.0', '11.2', 'latest', '11.2.0\n::error::x'])
      expect(() => parseArgs(['--base-version', bad])).toThrow('--base-version');
  });

  it('exit code 0 for reports-only verdicts, 1 for BLOCKING; the closing lines name who must opt in and who reports only', () => {
    const runOne = (manifest: object, legs: Step[][], argv: string[]) => {
      const io = consumer(manifest, lockOf({}), legs);
      return main(['--only', 'hcifootprint', '--candidate', '/candidate.tgz', ...argv], {
        read: vi.fn(() => '{"version":"12.0.0"}'),
        latest: vi.fn(() => '12.0.0'),
        recordSymbolsAt: vi.fn(() => new Set()),
        audit: (selected: object, ws: string, ctx: object, opts: object) => audit(selected, ws, ctx, opts, io),
        report: vi.fn(),
      });
    };
    const behind = { dependencies: { footprintjs: '^11.2.0' } };
    expect(runOne(behind, [steps()], []).results[0].verdict).toBe('opt-in needed');
    const migration = runOne(behind, RED_ONLY_ON_CANDIDATE, []);
    expect(migration).toMatchObject({ exitCode: 0, results: [{ verdict: 'needs migration' }] });
    const lines = vi.mocked(console.log).mock.calls.map(([line]) => line);
    expect(lines).toContain('1 consumer(s) must opt in to 12.0.0: hcifootprint.');
    expect(lines).toContain('1 consumer(s) report only (their ranges refuse base 12.0.0): hcifootprint.');
    // The heading pull request: base 11.2.0. The same consumer may block, and a break blocks.
    vi.mocked(console.log).mockClear();
    const heading = runOne(behind, RED_ONLY_ON_CANDIDATE, ['--base-version', '11.2.0']);
    expect(heading).toMatchObject({ exitCode: 1, results: [{ verdict: 'BLOCKING' }] });
    expect(vi.mocked(console.log).mock.calls.map(([line]) => line)).toContain(
      'every consumer can block this candidate (none refuses base 11.2.0).',
    );
  });

  it('a consumer relabelled only for its install graph (a demo) is not listed as must opt in', () => {
    const demo = lockOf({ 'demos/chat/node_modules/agentfootprint': peer('14.0.0', '^11.0.0') });
    const io = consumer({ dependencies: { footprintjs: '^11.0.0 || ^12.0.0' } }, demo, [steps()]);
    const run = main(['--only', 'hcifootprint', '--candidate', '/candidate.tgz', '--base-version', '12.0.0'], {
      read: vi.fn(() => '{"version":"12.0.0"}'),
      latest: vi.fn(() => '12.0.0'),
      recordSymbolsAt: vi.fn(() => new Set()),
      audit: (selected: object, ws: string, ctx: object, opts: object) => audit(selected, ws, ctx, opts, io),
      report: vi.fn(),
    });
    expect(run.results[0]).toMatchObject({
      verdict: 'pass',
      range: { mayBlock: true, accepted: '11.2.0', optIn: false },
    });
    expect(vi.mocked(console.log).mock.calls.map(([line]) => line)).toContain('no consumer must opt in to 12.0.0.');
  });

  it('R2: on a pull request the audit refuses to run without --base-version, before any work', () => {
    const services = { run: vi.fn(), read: vi.fn(), latest: vi.fn(), audit: vi.fn(), report: vi.fn() };
    const argv = ['--only', 'hcifootprint', '--candidate', '/candidate.tgz'];
    expect(() => cli(argv, { GITHUB_EVENT_NAME: 'pull_request' }, services)).toThrow(
      "On a pull request the consumer audit needs --base-version (the version of the branch it merges into): without it the pull request's own version label would decide which consumers may block it.",
    );
    expect(services.read).not.toHaveBeenCalled();
    expect(() =>
      requireBaseVersion(parseArgs([...argv, '--base-version', '11.2.0']), { GITHUB_EVENT_NAME: 'pull_request' }),
    ).not.toThrow();
    for (const event of ['workflow_dispatch', undefined])
      expect(() => requireBaseVersion(parseArgs(argv), { GITHUB_EVENT_NAME: event })).not.toThrow();
  });

  it('R2: the script itself, run as CI runs it, refuses a pull request without its base', () => {
    // WHY A CHILD PROCESS. The guard lives in `cli()`, and CI is protected only because the script's last
    // line calls `cli()` and not `main()`. Every other test calls a function, so that one line could go
    // back to `main()` with all of them green. This runs the file the way consumers.yml does.
    const script = resolve(__dirname, '../../scripts/audit-consumers.mjs');
    const args = ['--only', 'hcifootprint', '--candidate', '/no/such/candidate.tgz'];
    const run = (event: string | undefined, extra: string[] = []) =>
      spawnSync(process.execPath, [script, ...args, ...extra], {
        encoding: 'utf8',
        timeout: 60_000,
        env: { PATH: process.env.PATH ?? '', ...(event ? { GITHUB_EVENT_NAME: event } : {}) },
      });
    const refused = run('pull_request');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('On a pull request the consumer audit needs --base-version');
    // With the base given the guard lets it through: it then fails later, on the missing archive,
    // and never with the guard's sentence.
    expect(run('pull_request', ['--base-version', '12.0.0']).stderr).not.toContain('needs --base-version');
  });

  it('a consumer with no accepted version or a failed relabel is not listed as must opt in', () => {
    const io = consumer({ dependencies: { footprintjs: '^11.2.0' } });
    io.publishedVersions.mockReturnValue(['12.0.0']);
    const run = main(['--only', 'hcifootprint', '--candidate', '/candidate.tgz'], {
      read: vi.fn(() => '{"version":"12.0.0"}'),
      latest: vi.fn(() => '12.0.0'),
      recordSymbolsAt: vi.fn(() => new Set()),
      audit: (selected: object, ws: string, ctx: object, opts: object) => audit(selected, ws, ctx, opts, io),
      report: vi.fn(),
    });
    expect(run.results[0].verdict).toBe('own failure');
    expect(vi.mocked(console.log).mock.calls.map(([line]) => line)).toContain('no consumer must opt in to 12.0.0.');
  });
});

describe('what a run says', () => {
  it.each([
    { githubActions: undefined, notice: '  NOTICE: ', warning: '  WARNING: ', error: '  ERROR: ' },
    {
      githubActions: 'true',
      notice: '::notice title=app: opt-in needed::',
      warning: '::warning title=app: needs migration::',
      error: '::error title=app: BLOCKING::',
    },
  ])('annotations and the summary table ($githubActions)', async ({ githubActions, notice, warning, error }) => {
    vi.stubEnv('GITHUB_ACTIONS', githubActions);
    vi.resetModules();
    const { report } = await import('../../scripts/audit-consumers.mjs');
    const summary = join(temp(), 'summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summary);
    const ctx = ctxOf('12.0.0', '12.0.0', '12.0.0');
    const base = { entry, sha: 'abc', seconds: 2, notes: ['range: …'], range: { mayBlock: false, accepted: '11.2.0' } };
    report({ ...base, verdict: 'opt-in needed', candidate: steps(), published: null }, ctx);
    report({ ...base, verdict: 'needs migration', candidate: steps(true, false), published: steps() }, ctx);
    report({ ...base, verdict: 'needs migration', candidate: steps(false, false), published: steps() }, ctx);
    report(
      {
        ...base,
        range: { mayBlock: true, accepted: '11.2.0' },
        verdict: 'BLOCKING',
        candidate: steps(true, false),
        published: steps(),
      },
      ctx,
    );
    report(
      {
        ...base,
        range: { mayBlock: false, versionsUnread: true },
        verdict: 'needs migration',
        candidate: steps(false, false),
        published: steps(),
      },
      ctx,
    );
    const lines = vi.mocked(console.log).mock.calls.map(([line]) => line);
    expect(lines).toContain(
      `${warning}its range refuses the base, so not blocking; red on the candidate's code (install or checks) and green on the published 12.0.0: install footprintjs, npm test (the published version list could not be read, so its code was NOT tested under a version its ranges accept: the real candidate was installed as is)`,
    );
    expect(lines).toContain(
      `${notice}its range refuses the base, so not blocking; green on the candidate's code as 11.2.0: widen the range to take 12.0.0`,
    );
    expect(lines).toContain(
      `${warning}its range refuses the base, so not blocking; red on the candidate's code as 11.2.0 (install or checks) and green on the published 11.2.0: npm test`,
    );
    // Finding 4: the only red step was installing the relabelled archive.
    expect(lines).toContain(
      `${warning}its range refuses the base, so not blocking; red on the candidate's code as 11.2.0 (install or checks) and green on the published 11.2.0: install footprintjs, npm test (the relabelled archive as 11.2.0 did not install, so no check ran: this may be the audit, not the code; see the log)`,
    );
    expect(lines).toContain(`${error}red only on the candidate's code as 11.2.0: npm test`);
    expect(lines.some((line) => line.includes('candidate code as 11.2.0 RED 1 s'))).toBe(true);
    const text = readFileSync(summary, 'utf8');
    expect(text).toContain('### app: opt-in needed');
    expect(text).toContain('| Step | Candidate code as 11.2.0 | Published 11.2.0 |');
    expect(text).toContain('candidate 12.0.0 tested as 11.2.0 · published 11.2.0');
  });
});
