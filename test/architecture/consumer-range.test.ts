/**
 * A consumer blocks a candidate only inside the version range it declares (scripts/consumer-range.mjs,
 * wired by scripts/audit-consumers.mjs · audit). Outside it, its checks run on the candidate's code
 * relabelled as a version it accepts, and the verdict never fails the job.
 *
 * Every registry read, clone, install and relabel is injected: nothing here reaches the network.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  array,
  assert as assertProperty,
  boolean,
  constant,
  constantFrom,
  nat,
  oneof,
  property,
  tuple,
} from 'fast-check';
import semver from 'semver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { audit, declaredRange, judge, judgeOutOfRange, main } from '../../scripts/audit-consumers.mjs';
import { acceptedVersion, rangeLine, rangeOf, refusals, treeDeclarations } from '../../scripts/consumer-range.mjs';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'consumer-range-test-'));
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

// What the registry held on 12 Nov 2026, for the versions that matter here.
const PUBLISHED = ['10.0.0', '11.0.0', '11.0.1', '11.1.0', '11.2.0', '12.0.0-rc.0'];
const lockOf = (packages: Record<string, unknown>) => ({ lockfileVersion: 3, packages: { '': {}, ...packages } });
const peer = (version: string, range: string, optional = false) => ({
  version,
  peerDependencies: { footprintjs: range },
  ...(optional ? { peerDependenciesMeta: { footprintjs: { optional: true } } } : {}),
});

/** The range of one consumer, its manifests, tree and pins given as data. */
function rangeFor(version: string, manifest: object, { lock = lockOf({}), pins = {} as Record<string, object> } = {}) {
  const dir = '/ws/app/app';
  return declaredRange([dir], Object.keys(pins), new Map([[dir, manifest]]), version, {
    installedTree: () => lock,
    publishedPeers: (pin: string) => pins[pin],
  });
}

describe('the five consumers that refused 12.0.0 on 12 Nov 2026', () => {
  const cases = [
    {
      name: 'agentfootprint: its own peer',
      manifest: { peerDependencies: { footprintjs: '^11.1.0' }, devDependencies: { footprintjs: '11.2.0' } },
      options: {},
      line: 'range: refuses 12.0.0 — own peerDependencies ^11.1.0',
    },
    {
      name: 'agentfootprint-lens: its own peer, and the registry pin of agentfootprint',
      manifest: { peerDependencies: { footprintjs: '^11.0.0', agentfootprint: '^14.0.0' } },
      options: {
        // The pin replaces the locked agentfootprint: its locked peer is not read, its published one is.
        lock: lockOf({ 'node_modules/agentfootprint': peer('14.0.0', '^10.0.0') }),
        pins: { 'agentfootprint@14.3.1': { peerDependencies: { footprintjs: '^11.1.0' } } },
      },
      line: 'range: refuses 12.0.0 — own peerDependencies ^11.0.0; agentfootprint@14.3.1 peer ^11.1.0',
    },
    {
      name: 'hcifootprint: agentfootprint@14.0.0, locked twice through two workspace demos',
      manifest: { dependencies: { footprintjs: '^11.0.0 || ^12.0.0' } },
      options: {
        lock: lockOf({
          'demos/chat': { name: 'chat-demo', version: '0.0.0' },
          'node_modules/chat-demo': { resolved: 'demos/chat', link: true },
          'demos/chat/node_modules/agentfootprint': peer('14.0.0', '^11.0.0'),
          'demos/voice/node_modules/agentfootprint': peer('14.0.0', '^11.0.0'),
        }),
      },
      line: 'range: refuses 12.0.0 — agentfootprint@14.0.0 peer ^11.0.0',
    },
    {
      name: 'vizfootprint: the agentfootprint pin, and an OPTIONAL peer behind it',
      manifest: { dependencies: { footprintjs: '^11.0.0 || ^12.0.0' } },
      options: {
        lock: lockOf({ 'node_modules/footprint-storydeck': peer('0.11.0', '^11.0.0', true) }),
        pins: { 'agentfootprint@14.3.1': { peerDependencies: { footprintjs: '^11.1.0' } } },
      },
      line: 'range: refuses 12.0.0 — agentfootprint@14.3.1 peer ^11.1.0; footprint-storydeck@0.11.0 optional peer ^11.0.0',
    },
    {
      name: 'agent-playground: two registry pins',
      manifest: { dependencies: { footprintjs: 'file:../footPrint' } },
      options: {
        pins: {
          'agentfootprint@14.3.1': { peerDependencies: { footprintjs: '^11.1.0' } },
          'agentfootprint-lens@0.80.0': { peerDependencies: { footprintjs: '^11.0.0' } },
        },
      },
      line: 'range: refuses 12.0.0 — agentfootprint@14.3.1 peer ^11.1.0; agentfootprint-lens@0.80.0 peer ^11.0.0',
    },
  ];
  it.each(cases)('$name', ({ manifest, options, line }) => {
    const range = rangeFor('12.0.0', manifest, options);
    expect(range.unread).toBeUndefined();
    expect(range.line).toBe(line);
    expect(acceptedVersion(range.declarations, PUBLISHED)).toBe('11.2.0');
  });
});

describe('which declarations count', () => {
  it.each([
    ['^11.1.0', { range: '^11.1.0' }],
    ['11.1.0', { range: '11.1.0' }],
    ['>=11 <13', { range: '>=11 <13' }],
    ['', { range: '' }],
    ['file:../footPrint', null],
    ['link:../footPrint', null],
    ['git+https://github.com/footprintjs/footPrint.git', null],
    ['github:footprintjs/footPrint', null],
    ['footprintjs/footPrint', null],
    ['https://example.invalid/footprintjs.tgz', null],
    ['latest', null],
  ])('%j is %j', (spec, expected) => {
    expect(rangeOf(spec, 'own')).toEqual(expected);
  });

  it.each([[7], [{ range: '^11' }], [null], ['^11.x.banana'], ['npm:footprintjs@^11'], ['^11.0.0 '.repeat(200)]])(
    'refuses to read %j: the caller fails closed',
    (spec) => {
      expect(() => rangeOf(spec, 'own')).toThrow();
    },
  );

  it('devDependencies are a test setup, not a statement: a consumer declaring only them accepts any version', () => {
    const range = rangeFor('12.0.0', { devDependencies: { footprintjs: '^11.0.0' } });
    expect(range.declarations).toEqual([]);
    expect(range.line).toBe('range: accepts 12.0.0');
  });

  it('a prerelease candidate is outside a caret range of its own major, as npm reads it', () => {
    const range = rangeFor('12.0.0-rc.0', { peerDependencies: { footprintjs: '^12.0.0' } });
    expect(range.line).toBe('range: refuses 12.0.0-rc.0 — own peerDependencies ^12.0.0');
    // No released 12.x yet: no published version is accepted, and the audit says so (below).
    expect(acceptedVersion(range.declarations, PUBLISHED)).toBeNull();
  });

  it('an exact pin refuses every other version, and is the version tested', () => {
    const range = rangeFor('11.2.0', { dependencies: { footprintjs: '11.1.0' } });
    expect(range.line).toBe('range: refuses 11.2.0 — own dependencies 11.1.0');
    expect(acceptedVersion(range.declarations, PUBLISHED)).toBe('11.1.0');
  });

  it('a later patch of the current major is inside the range', () => {
    const range = rangeFor(
      '11.2.1',
      { peerDependencies: { footprintjs: '^11.1.0' } },
      {
        lock: lockOf({ 'node_modules/agentfootprint': peer('14.3.1', '^11.1.0') }),
      },
    );
    expect(range.refusing).toEqual([]);
    expect(range.line).toBe('range: accepts 11.2.1');
  });

  it('the accepted version satisfies every declaration, not only the refusing ones', () => {
    const declarations = [
      { who: 'own', field: 'peerDependencies', range: '^11.0.0' },
      { who: 'a@1.0.0', field: 'peer', range: '>=11.1.0 <11.2.0' },
    ];
    expect(refusals(declarations, '12.0.0')).toHaveLength(2);
    expect(acceptedVersion(declarations, PUBLISHED)).toBe('11.1.0');
    expect(rangeLine('12.0.0', [])).toBe('range: accepts 12.0.0');
  });

  it('reads every installed peer, skipping the root, links and what a pin replaces', () => {
    const lock = lockOf({
      'node_modules/a': peer('1.0.0', '^11.0.0'),
      'node_modules/b': { resolved: 'x', link: true, peerDependencies: { footprintjs: '^1.0.0' } },
      'node_modules/pinned': peer('2.0.0', '^9.0.0'),
      'node_modules/@scope/c': peer('3.0.0', 'file:../x'),
    });
    lock.packages[''] = { peerDependencies: { footprintjs: '^1.0.0' } };
    expect(treeDeclarations(lock, new Set(['pinned']))).toEqual([{ who: 'a@1.0.0', field: 'peer', range: '^11.0.0' }]);
  });
});

describe('fail closed: what cannot be read leaves the consumer inside its range', () => {
  const refusing = { peerDependencies: { footprintjs: '^11.0.0' } };
  it.each([
    ['a manifest field that is not an object', { peerDependencies: '^11.0.0' }, {}],
    ['a range that is a number', { peerDependencies: { footprintjs: 11 } }, {}],
    ['a range that does not parse', { dependencies: { footprintjs: '^11.x.banana' } }, {}],
    ['a manifest that is not an object', null, {}],
    ['a lock with no packages map', refusing, { lock: { packages: [] } }],
    ['a lock entry that is not an object', refusing, { lock: lockOf({ 'node_modules/a': 'x' }) }],
    ['a locked peer that is not a text', refusing, { lock: lockOf({ 'node_modules/a': peer('1.0.0', 7 as never) }) }],
    ['a registry pin whose manifest is not an object', refusing, { pins: { 'a@1.0.0': 'x' as never } }],
  ])('%s', (_name, manifest, options) => {
    const range = rangeFor('12.0.0', manifest as object, options);
    expect(range.unread).toMatch(/^range: not read \(.+\); judged inside its range$/);
    expect(range.refusing).toBeUndefined();
  });

  it('a registry or lock read that throws', () => {
    const dir = '/ws/app/app';
    const manifests = new Map([[dir, refusing]]);
    const throws = () => {
      throw new Error('registry unavailable');
    };
    for (const services of [
      { installedTree: throws, publishedPeers: () => ({}) },
      { installedTree: () => lockOf({}), publishedPeers: throws },
    ]) {
      const range = declaredRange([dir], ['a@1.0.0'], manifests, '12.0.0', services);
      expect(range.unread).toContain('registry unavailable');
    }
  });
});

// ── the audit ────────────────────────────────────────────────────────────────

const entry = { package: 'app', repo: 'test/app', branch: 'main', dir: 'app', checks: ['npm test'] };
const context = { candidate: '/candidate/footprintjs-candidate.tgz', candidateVersion: '12.0.0', published: '11.2.0' };
const steps = (install = true, check = true) => [
  { key: 'install footprintjs', ok: install, seconds: 1 },
  { key: 'npm test', ok: check, seconds: 1, ...(!install ? { skipped: true } : {}) },
];
const OUT = { declarations: [{ who: 'own', field: 'peerDependencies', range: '^11.1.0' }] };
const outOfRange = {
  ...OUT,
  refusing: OUT.declarations,
  line: 'range: refuses 12.0.0 — own peerDependencies ^11.1.0',
};
const inRange = { declarations: [], refusing: [], line: 'range: accepts 12.0.0' };

function services(range: object) {
  return {
    clone: vi.fn((_entry, dir) => {
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
      return null;
    }),
    run: vi.fn(() => ({ ok: true, seconds: 1 })),
    read: vi.fn(() => 'abcd123'),
    latest: vi.fn(() => '14.3.1'),
    advancedImports: vi.fn(() => ({ lines: 0, record: [], other: [], unresolved: false })),
    leg: vi.fn(() => steps()),
    declaredRange: vi.fn(() => range),
    publishedVersions: vi.fn(() => PUBLISHED),
    relabelCandidate: vi.fn((_input, version, folder) => join(folder, `footprintjs-candidate-as-${version}.tgz`)),
  };
}

describe('inside its range: the audit is what it was', () => {
  it.each([
    [steps(), null, 'pass'],
    [steps(true, false), steps(), 'BLOCKING'],
    [steps(true, false), steps(true, false), 'own failure'],
    [steps(false, false), steps(false, false), 'no verdict'],
  ])('candidate %j, published %j → %s', (candidate, published, verdict) => {
    const io = services(inRange);
    io.leg.mockReturnValueOnce(candidate).mockReturnValueOnce(published as never);
    const actual = audit(entry, temp(), context, {}, io);
    expect(actual.verdict).toBe(verdict);
    expect(judge(candidate, published)).toBe(verdict);
    expect(io.leg.mock.calls[0][0]).toBe(context.candidate);
    if (published) expect(io.leg.mock.calls[1][0]).toBe('footprintjs@11.2.0');
    expect(io.relabelCandidate).not.toHaveBeenCalled();
    expect(io.publishedVersions).not.toHaveBeenCalled();
    expect(actual.range).toBeUndefined();
    expect(actual.notes).toContain('range: accepts 12.0.0');
  });

  it('cannot be cheated: a range that accepts, a test red only on the candidate, still BLOCKING', () => {
    const io = services(inRange);
    io.leg.mockReturnValueOnce(steps(true, false)).mockReturnValueOnce(steps());
    expect(audit(entry, temp(), context, {}, io).verdict).toBe('BLOCKING');
  });

  it.each([
    ['a range that could not be read', { unread: 'range: not read (bad); judged inside its range' }, false],
    ['a version list that could not be read', outOfRange, true],
  ])('fails closed on %s: the candidate as is, and BLOCKING stays BLOCKING', (_name, range, versionsFail) => {
    const io = services(range);
    if (versionsFail)
      io.publishedVersions.mockImplementation(() => {
        throw new Error('registry unavailable');
      });
    io.leg.mockReturnValueOnce(steps(false, false)).mockReturnValueOnce(steps());
    const actual = audit(entry, temp(), context, {}, io);
    expect(actual.verdict).toBe('BLOCKING');
    expect(io.leg.mock.calls.map((call) => call[0])).toEqual([context.candidate, 'footprintjs@11.2.0']);
    expect(io.relabelCandidate).not.toHaveBeenCalled();
    expect(actual.notes.join('\n')).toMatch(/range: (not read|published versions not read)/);
  });
});

describe('outside its range: tested on the candidate code, never blocking', () => {
  it.each([
    [steps(), null, 'opt-in needed'],
    [steps(true, false), steps(), 'needs migration'],
    [steps(false, false), steps(), 'needs migration'],
    [steps(true, false), steps(true, false), 'own failure'],
    [steps(false, false), steps(false, false), 'no verdict'],
  ])('relabelled %j, published accepted %j → %s', (candidate, published, verdict) => {
    const io = services(outOfRange);
    io.leg.mockReturnValueOnce(candidate).mockReturnValueOnce(published as never);
    const ws = temp();
    const actual = audit(entry, ws, context, {}, io);
    expect(actual.verdict).toBe(verdict);
    expect(judgeOutOfRange(candidate, published)).toBe(verdict);
    expect(io.relabelCandidate).toHaveBeenCalledWith(context.candidate, '11.2.0', join(ws, 'app/relabelled'));
    expect(io.leg.mock.calls[0][0]).toBe(join(ws, 'app/relabelled/footprintjs-candidate-as-11.2.0.tgz'));
    if (published) expect(io.leg.mock.calls[1][0]).toBe('footprintjs@11.2.0');
    expect(actual.range).toEqual({ refusing: outOfRange.refusing, accepted: '11.2.0' });
    expect(actual.notes).toContain('range: refuses 12.0.0 — own peerDependencies ^11.1.0');
  });

  it('fallback: false — red on the candidate code is a migration, not a block', () => {
    const io = services(outOfRange);
    io.leg.mockReturnValueOnce(steps(true, false));
    expect(audit({ ...entry, fallback: false }, temp(), context, {}, io).verdict).toBe('needs migration');
    expect(io.leg).toHaveBeenCalledOnce();
  });

  it('no published version satisfies every range: own failure, and nothing is installed', () => {
    const io = services(outOfRange);
    io.publishedVersions.mockReturnValue(['10.0.0', '12.0.0-rc.0']);
    const actual = audit(entry, temp(), context, {}, io);
    expect(actual.verdict).toBe('own failure');
    expect(io.leg).not.toHaveBeenCalled();
    expect(actual.notes.at(-1)).toBe(
      'no published footprintjs satisfies every range it declares: own peerDependencies ^11.1.0',
    );
  });

  it('a relabelled archive that fails its check: no verdict', () => {
    const io = services(outOfRange);
    io.relabelCandidate.mockImplementation(() => {
      throw new Error('the relabelled archive changed package/dist/index.js');
    });
    const actual = audit(entry, temp(), context, {}, io);
    expect(actual.verdict).toBe('no verdict');
    expect(io.leg).not.toHaveBeenCalled();
    expect(actual.notes.at(-1)).toContain('could not relabel the candidate as 11.2.0');
    expect(actual.range).toEqual({ refusing: outOfRange.refusing });
  });

  it('exit code 0 for opt-in needed and needs migration; the last line names who must opt in', () => {
    const runOne = (legs: unknown[][]) => {
      const io = services(outOfRange);
      for (const result of legs) io.leg.mockReturnValueOnce(result as never);
      return main(['--only', 'hcifootprint', '--candidate', '/candidate.tgz'], {
        read: vi.fn(() => '{"version":"12.0.0"}'),
        latest: vi.fn(() => '11.2.0'),
        recordSymbolsAt: vi.fn(() => new Set()),
        audit: (selected: object, ws: string, ctx: object, opts: object) => audit(selected, ws, ctx, opts, io),
        report: vi.fn(),
      });
    };
    const optIn = runOne([steps()]);
    expect(optIn.exitCode).toBe(0);
    expect(optIn.results[0].verdict).toBe('opt-in needed');
    const migration = runOne([steps(true, false), steps()]);
    expect(migration.exitCode).toBe(0);
    expect(migration.results[0].verdict).toBe('needs migration');
    const lines = vi.mocked(console.log).mock.calls.map(([line]) => line);
    expect(lines).toContain('1 consumer(s) are outside their declared range for 12.0.0 and must opt in: hcifootprint.');
  });
});

describe('what a run says about a consumer outside its range', () => {
  it.each([
    { githubActions: undefined, prefix: '  NOTICE: ', warn: '  WARNING: ' },
    {
      githubActions: 'true',
      prefix: '::notice title=app: opt-in needed::',
      warn: '::warning title=app: needs migration::',
    },
  ])('annotations and the summary table ($githubActions)', async ({ githubActions, prefix, warn }) => {
    vi.stubEnv('GITHUB_ACTIONS', githubActions);
    vi.resetModules();
    const { report } = await import('../../scripts/audit-consumers.mjs');
    const summary = join(temp(), 'summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summary);
    const base = { entry, sha: 'abc', seconds: 2, notes: [outOfRange.line], range: { accepted: '11.2.0' } };
    report({ ...base, verdict: 'opt-in needed', candidate: steps(), published: null }, context);
    report({ ...base, verdict: 'needs migration', candidate: steps(true, false), published: steps() }, context);
    const lines = vi.mocked(console.log).mock.calls.map(([line]) => line);
    expect(lines).toContain(
      `${prefix}outside its range, so not blocking; green on the candidate's code as 11.2.0: widen the range to take 12.0.0`,
    );
    expect(lines).toContain(
      `${warn}outside its range, so not blocking; red on the candidate's code as 11.2.0 and green on the published 11.2.0: npm test`,
    );
    expect(lines.some((line) => line.includes('candidate code as 11.2.0 RED 1 s'))).toBe(true);
    const text = readFileSync(summary, 'utf8');
    expect(text).toContain('### app: opt-in needed');
    expect(text).toContain('### app: needs migration');
    expect(text).toContain('| Step | Candidate code as 11.2.0 | Published 11.2.0 |');
    expect(text).toContain('candidate 12.0.0 tested as 11.2.0 · published 11.2.0');
  });
});

describe('property: out of range is exactly "some collected range refuses"', () => {
  const version = tuple(nat(13), nat(4), nat(4), boolean()).map(
    ([a, b, c, pre]) => `${a}.${b}.${c}${pre ? '-rc.0' : ''}`,
  );
  const range = oneof(
    version.map((v) => `^${v}`),
    version.map((v) => `~${v}`),
    version,
    tuple(version, version).map(([a, b]) => `>=${a} <${b}`),
    tuple(version, version).map(([a, b]) => `^${a} || ^${b}`),
  );
  const spec = oneof(range, constant('file:../footPrint'), constant('latest'));
  const field = constantFrom('dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies');

  it('holds for generated manifests, trees and versions', () => {
    assertProperty(
      property(
        version,
        array(tuple(field, spec), { maxLength: 4 }),
        array(range, { maxLength: 3 }),
        (candidate, own, installed) => {
          const manifest: Record<string, Record<string, string>> = {};
          for (const [name, value] of own) manifest[name] = { footprintjs: value };
          const lock = lockOf(Object.fromEntries(installed.map((r, i) => [`node_modules/p${i}`, peer('1.0.0', r)])));
          const result = rangeFor(candidate, manifest, { lock });
          const collected = [
            ...Object.entries(manifest)
              .filter(([name]) => name !== 'devDependencies')
              .map(([, value]) => value.footprintjs)
              .filter((value) => semver.validRange(value) !== null && !value.startsWith('file:')),
            ...installed,
          ];
          expect(result.unread).toBeUndefined();
          expect(result.refusing.length > 0).toBe(collected.some((r) => !semver.satisfies(candidate, r)));
        },
      ),
      { numRuns: 300 },
    );
  });
});
