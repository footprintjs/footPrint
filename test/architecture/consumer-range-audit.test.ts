/**
 * The range rule wired into the audit (scripts/audit-consumers.mjs · audit, planRange, report, main).
 * Real `declaredRange` and `decideRange`; the clone, lock, registry, relabel and both legs injected.
 * Nothing here reaches the network.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { audit, declaredRange, judge, judgeOutOfRange, main, parseArgs } from '../../scripts/audit-consumers.mjs';
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
const RED_ONLY_ON_CANDIDATE = [steps(true, false), steps()];
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
    [[steps(true, false), steps()], 'BLOCKING'],
    [[steps(true, false), steps(true, false)], 'own failure'],
    [[steps(false, false), steps(false, false)], 'no verdict'],
  ] as const)('%j → %s, judged by judge, on the real candidate and latest', (legs, verdict) => {
    const io = consumer({ peerDependencies: { footprintjs: '^11.1.0' } }, lockOf({}), [...legs]);
    const actual = audit(entry, temp(), ctxOf('11.2.0', '11.2.0'), {}, io);
    expect(actual.verdict).toBe(verdict);
    expect(judge(legs[0], legs[1] ?? null)).toBe(verdict);
    expect(legSpecs(io)).toEqual(legs.length > 1 ? [CANDIDATE, 'footprintjs@11.2.0'] : [CANDIDATE]);
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
    expect(legSpecs(io)).toEqual([relabelled(ws, '11.2.0'), 'footprintjs@11.2.0']);
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
    expect(legSpecs(io)).toEqual([CANDIDATE, 'footprintjs@11.2.0']);
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
    expect(legSpecs(io)).toEqual([relabelled(ws, '11.1.0'), 'footprintjs@11.1.0']);
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
    [[steps(true, false), steps()], 'needs migration'],
    [[steps(false, false), steps()], 'needs migration'],
    [[steps(true, false), steps(true, false)], 'own failure'],
    [[steps(false, false), steps(false, false)], 'no verdict'],
  ] as const)('%j → %s', (legs, verdict) => {
    const io = consumer({ dependencies: { footprintjs: '^11.2.0' } }, lockOf({}), [...legs]);
    const ws = temp();
    const actual = audit(entry, ws, ctxOf('12.0.0', '12.0.0', '12.0.0'), {}, io);
    expect(actual.verdict).toBe(verdict);
    expect(judgeOutOfRange(legs[0], legs[1] ?? null)).toBe(verdict);
    expect(legSpecs(io)).toEqual(
      legs.length > 1 ? [relabelled(ws, '11.2.0'), 'footprintjs@11.2.0'] : [relabelled(ws, '11.2.0')],
    );
    expect(actual.notes).toContain(
      'range: refuses base 12.0.0 (own dependencies ^11.2.0): reports only. Tested as 11.2.0.',
    );
  });

  it('fallback: false — red on the candidate’s code is a migration, not a block', () => {
    const io = consumer({ dependencies: { footprintjs: '^11.2.0' } }, lockOf({}), [steps(true, false)]);
    expect(audit({ ...entry, fallback: false }, temp(), ctxOf('12.0.0', '12.0.0'), {}, io).verdict).toBe(
      'needs migration',
    );
    expect(io.leg).toHaveBeenCalledOnce();
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
    expect(legSpecs(io)).toEqual([CANDIDATE, 'footprintjs@12.0.0']);
    expect(io.relabelCandidate).not.toHaveBeenCalled();
  });
});

describe('fail closed: what cannot be read leaves the consumer judged as before', () => {
  it.each([
    ['a lock that cannot be read', { packages: [] }, false],
    ['a version list that cannot be read', lockOf({}), true],
  ])(
    '%s: the real candidate, and BLOCKING stays BLOCKING even for a reports-only consumer',
    (_name, lock, versionsFail) => {
      const io = consumer({ dependencies: { footprintjs: '^11.2.0' } }, lock, RED_ONLY_ON_CANDIDATE);
      if (versionsFail)
        io.publishedVersions.mockImplementation(() => {
          throw new Error('registry unavailable');
        });
      const actual = audit(entry, temp(), ctxOf('12.0.0', '12.0.0'), {}, io);
      expect(actual.verdict).toBe('BLOCKING');
      expect(legSpecs(io)).toEqual([CANDIDATE, 'footprintjs@11.2.0']);
      expect(io.relabelCandidate).not.toHaveBeenCalled();
      expect(actual.notes.join('\n')).toMatch(/not read/);
    },
  );
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
    const lines = vi.mocked(console.log).mock.calls.map(([line]) => line);
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
