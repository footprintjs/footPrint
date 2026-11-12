/**
 * scripts/consumer-range.mjs: the two questions, answered from data.
 *   1. May this consumer block? Its statements to users (manifests, registry pins) against the BASE.
 *   2. Under which label is the candidate's code installed? Every declaration in its install graph.
 * The audit's wiring is in consumer-range-audit.test.ts. Nothing here reaches the network.
 */
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
import { describe, expect, it } from 'vitest';

import { declaredRange } from '../../scripts/audit-consumers.mjs';
import { auditPeerProblem } from '../../scripts/consumer-install.mjs';
import {
  acceptedVersion,
  decideRange,
  pinName,
  rangeLine,
  rangeOf,
  refusals,
  releaseOf,
  treeDeclarations,
} from '../../scripts/consumer-range.mjs';
import { lockOf, peer, PUBLISHED, rangeFor } from '../helpers/consumerRange';

function decided(manifest: unknown, options: Parameters<typeof rangeFor>[1], base: string, candidate: string) {
  const found = rangeFor(manifest, options);
  expect(found.unread).toBeUndefined();
  return { found, decision: decideRange(found.declarations, base, candidate) };
}

const SHAPES = {
  agentfootprint: {
    manifest: { peerDependencies: { footprintjs: '^11.1.0' }, devDependencies: { footprintjs: '11.2.0' } },
    options: {},
  },
  'agentfootprint-lens': {
    manifest: { peerDependencies: { footprintjs: '^11.0.0', agentfootprint: '^14.0.0' } },
    options: {
      // The pin replaces the locked agentfootprint: its locked peer is not read, its published one is.
      lock: lockOf({ 'node_modules/agentfootprint': peer('14.0.0', '^10.0.0') }),
      pins: { 'agentfootprint@14.3.1': { peerDependencies: { footprintjs: '^11.1.0' } } },
    },
  },
  hcifootprint: {
    manifest: { dependencies: { footprintjs: '^11.0.0 || ^12.0.0' } },
    options: {
      lock: lockOf({
        'demos/chat': { name: 'chat-demo', version: '0.0.0' },
        'node_modules/chat-demo': { resolved: 'demos/chat', link: true },
        'demos/chat/node_modules/agentfootprint': peer('14.0.0', '^11.0.0'),
        'demos/voice/node_modules/agentfootprint': peer('14.0.0', '^11.0.0'),
      }),
    },
  },
  vizfootprint: {
    manifest: { dependencies: { footprintjs: '^11.0.0 || ^12.0.0' } },
    options: {
      lock: lockOf({ 'node_modules/footprint-storydeck': peer('0.11.0', '^11.0.0', true) }),
      pins: { 'agentfootprint@14.3.1': { peerDependencies: { footprintjs: '^11.1.0' } } },
    },
  },
  'agent-playground': {
    manifest: { dependencies: { footprintjs: 'file:../footPrint' } },
    options: {
      pins: {
        'agentfootprint@14.3.1': { peerDependencies: { footprintjs: '^11.1.0' } },
        'agentfootprint-lens@0.80.0': { peerDependencies: { footprintjs: '^11.0.0' } },
      },
    },
  },
};

describe('the five consumers that refused 12.0.0 on 12 Nov 2026', () => {
  // The heading pull request: base 11.2.0, candidate 12.0.0. Every one may block, and is tested as 11.2.0.
  it.each([
    [
      'agentfootprint',
      'range: accepts base 11.2.0, so it can block. Refuses 12.0.0 (own peerDependencies ^11.1.0): must opt in before 12.0.0 is the newest version. Tested as 11.2.0.',
    ],
    [
      'agentfootprint-lens',
      'range: accepts base 11.2.0, so it can block. Refuses 12.0.0 (own peerDependencies ^11.0.0; agentfootprint@14.3.1 peer ^11.1.0): must opt in before 12.0.0 is the newest version. Tested as 11.2.0.',
    ],
    [
      'hcifootprint',
      'range: accepts base 11.2.0, so it can block. Its install graph refuses 12.0.0 (agentfootprint@14.0.0 peer ^11.0.0). Tested as 11.2.0.',
    ],
    [
      'vizfootprint',
      'range: accepts base 11.2.0, so it can block. Refuses 12.0.0 (agentfootprint@14.3.1 peer ^11.1.0): must opt in before 12.0.0 is the newest version. Its install graph refuses 12.0.0 (footprint-storydeck@0.11.0 optional peer ^11.0.0). Tested as 11.2.0.',
    ],
    [
      'agent-playground',
      'range: accepts base 11.2.0, so it can block. Refuses 12.0.0 (agentfootprint@14.3.1 peer ^11.1.0; agentfootprint-lens@0.80.0 peer ^11.0.0): must opt in before 12.0.0 is the newest version. Tested as 11.2.0.',
    ],
  ] as const)('%s, on the heading pull request', (name, line) => {
    const { manifest, options } = SHAPES[name];
    const { found, decision } = decided(manifest, options, '11.2.0', '12.0.0');
    expect(decision.mayBlock).toBe(true);
    const accepted = acceptedVersion(found.declarations, PUBLISHED);
    expect(accepted).toBe('11.2.0');
    expect(rangeLine({ base: '11.2.0', candidate: '12.0.0', decision, testedAs: accepted })).toBe(line);
  });

  it.each([
    ['agentfootprint', false],
    ['agentfootprint-lens', false],
    // B1: its demos refuse 12, but its own statement accepts it: it keeps its power to block 12.
    ['hcifootprint', true],
    // Its pin is a statement: the published agentfootprint it ships with refuses 12.
    ['vizfootprint', false],
    ['agent-playground', false],
  ] as const)('%s, after 12.0.0 is merged (base 12.0.0): may block = %s', (name, mayBlock) => {
    const { manifest, options } = SHAPES[name];
    expect(decided(manifest, options, '12.0.0', '12.0.0').decision.mayBlock).toBe(mayBlock);
  });

  it('a consumer still on ^11.2.0 after 12.0.0 is merged reports only, in plain words', () => {
    const { decision } = decided({ dependencies: { footprintjs: '^11.2.0' } }, {}, '12.0.0', '12.0.0');
    expect(rangeLine({ base: '12.0.0', candidate: '12.0.0', decision, testedAs: '11.2.0' })).toBe(
      'range: refuses base 12.0.0 (own dependencies ^11.2.0): reports only. Tested as 11.2.0.',
    );
  });

  it('a consumer that accepts both says so in one sentence', () => {
    const { decision } = decided({ peerDependencies: { footprintjs: '^12.0.0' } }, {}, '12.0.0', '12.0.0');
    expect(rangeLine({ base: '12.0.0', candidate: '12.0.0', decision })).toBe(
      'range: accepts base 12.0.0 and candidate 12.0.0.',
    );
  });
});

describe('question 1 reads statements only; question 2 reads everything', () => {
  it('a dev-only and a workspace-only refusal never take away the power to block (B1)', () => {
    const lock = lockOf({
      'node_modules/old-helper': { ...peer('1.0.0', '^11.0.0'), dev: true },
      'demos/chat/node_modules/agentfootprint': peer('14.0.0', '^11.0.0'),
    });
    const { decision } = decided({ peerDependencies: { footprintjs: '>=11' } }, { lock }, '12.0.0', '12.0.0');
    expect(decision.mayBlock).toBe(true);
    expect(decision.candidateRefusing.map((d) => d.who)).toEqual(['old-helper@1.0.0', 'agentfootprint@14.0.0']);
  });

  it('the base decides, never the candidate label (B2)', () => {
    for (const candidate of ['11.2.0', '99.0.0', '11.2.1-x']) {
      const { decision } = decided({ peerDependencies: { footprintjs: '^11.1.0' } }, {}, '11.2.0', candidate);
      expect(decision.mayBlock, candidate).toBe(true);
    }
  });

  it('a prerelease base is asked about by its release; the candidate label is read npm’s way', () => {
    expect(releaseOf('11.3.0-rc.0')).toBe('11.3.0');
    const minor = decided({ peerDependencies: { footprintjs: '^11.1.0' } }, {}, '11.3.0-rc.0', '11.3.0-rc.0');
    expect(minor.decision.mayBlock).toBe(true);
    // npm does not install 11.3.0-rc.0 for ^11.1.0: the code is relabelled.
    expect(minor.decision.candidateRefusing).toHaveLength(1);
    const major = decided({ peerDependencies: { footprintjs: '^12.0.0' } }, {}, '12.0.0-rc.0', '12.0.0-rc.0');
    expect(major.decision.mayBlock).toBe(true);
    const behind = decided({ peerDependencies: { footprintjs: '^11.1.0' } }, {}, '12.0.0-rc.0', '12.0.0-rc.0');
    expect(behind.decision.mayBlock).toBe(false);
  });

  it('R1: a statement that accepts the prerelease base as written, but not its release, may block', () => {
    for (const range of ['12.0.0-rc.0', '>=12.0.0-rc.0 <12.0.0', '12.0.0-rc.0 - 12.0.0-rc.5']) {
      const { decision } = decided({ peerDependencies: { footprintjs: range } }, {}, '12.0.0-rc.0', '12.0.0-rc.0');
      expect(decision.mayBlock, range).toBe(true);
      expect(rangeLine({ base: '12.0.0-rc.0', candidate: '12.0.0-rc.0', decision })).toBe(
        'range: accepts base 12.0.0-rc.0 (as written or as 12.0.0) and candidate 12.0.0-rc.0.',
      );
    }
    // Neither reading accepts it: still reports only, and the line names both versions asked.
    const { decision } = decided({ peerDependencies: { footprintjs: '^11.1.0' } }, {}, '12.0.0-rc.0', '12.0.0-rc.0');
    expect(rangeLine({ base: '12.0.0-rc.0', candidate: '12.0.0-rc.0', decision })).toBe(
      'range: refuses base 12.0.0-rc.0 (as written or as 12.0.0) (own peerDependencies ^11.1.0): reports only.',
    );
  });

  it('a statement that refuses the base but accepts a lower candidate: reports only, real label (row 4)', () => {
    const { decision } = decided({ dependencies: { footprintjs: '^11.2.0' } }, {}, '12.0.0', '11.2.0');
    expect(decision.mayBlock).toBe(false);
    expect(decision.candidateRefusing).toEqual([]);
    expect(rangeLine({ base: '12.0.0', candidate: '11.2.0', decision })).toBe(
      'range: refuses base 12.0.0 (own dependencies ^11.2.0): reports only. Accepts candidate 11.2.0.',
    );
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

  it('one pin-name parser for the plan and the range', () => {
    expect(pinName('agentfootprint@14.3.1')).toBe('agentfootprint');
    expect(pinName('@audit/scoped-pin@1.2.3')).toBe('@audit/scoped-pin');
    for (const bad of ['broken-pin', '@scope-only', 7]) expect(() => pinName(bad)).toThrow('invalid named audit pin');
  });

  it('the strict path reads a peer through the same reader, refusing what it refused before', () => {
    const problem = (range: unknown) =>
      auditPeerProblem({ peerDependencies: { footprintjs: range } }, new Map([['footprintjs', '11.2.0']]));
    expect(problem('^11.0.0')).toBeNull();
    expect(problem('^10.0.0')).toContain('incompatible');
    for (const range of ['file:../x', 'latest', 7, '^11.x.banana']) expect(problem(range)).toContain('invalid');
  });

  it('devDependencies are a test setup, not a statement: a consumer declaring only them accepts any version', () => {
    const { decision } = decided({ devDependencies: { footprintjs: '^11.0.0' } }, {}, '12.0.0', '12.0.0');
    expect(decision).toMatchObject({ mayBlock: true, candidateRefusing: [] });
  });

  it('an exact pin refuses every other version, and is the version tested', () => {
    const { found, decision } = decided({ dependencies: { footprintjs: '11.1.0' } }, {}, '11.1.0', '11.2.0');
    expect(decision.mayBlock).toBe(true);
    expect(acceptedVersion(found.declarations, PUBLISHED)).toBe('11.1.0');
  });

  it('a later patch of the current major is inside every range', () => {
    const lock = lockOf({ 'node_modules/agentfootprint': peer('14.3.1', '^11.1.0') });
    const { decision } = decided({ peerDependencies: { footprintjs: '^11.1.0' } }, { lock }, '11.2.0', '11.2.1');
    expect(decision).toMatchObject({ mayBlock: true, candidateRefusing: [] });
  });

  it('the accepted version satisfies every declaration, not only the refusing ones', () => {
    const declarations = [
      { who: 'own', field: 'peerDependencies', range: '>=11.1.0 <11.2.0 || >=12.0.0', statement: true },
      { who: 'a@1.0.0', field: 'peer', range: '^11.0.0', statement: false },
    ];
    expect(refusals(declarations, '12.0.0')).toHaveLength(1);
    expect(acceptedVersion(declarations, PUBLISHED)).toBe('11.1.0');
  });

  it('reads every installed peer, skipping the root, links and what a pin replaces', () => {
    const lock = lockOf({
      'node_modules/a': peer('1.0.0', '^11.0.0'),
      'node_modules/b': { resolved: 'x', link: true, peerDependencies: { footprintjs: '^1.0.0' } },
      'node_modules/pinned': peer('2.0.0', '^9.0.0'),
      'node_modules/@scope/c': peer('3.0.0', 'file:../x'),
    });
    lock.packages[''] = { peerDependencies: { footprintjs: '^1.0.0' } };
    expect(treeDeclarations(lock, new Set(['pinned']))).toEqual([
      { who: 'a@1.0.0', field: 'peer', range: '^11.0.0', statement: false },
    ]);
  });
});

describe('fail closed: what cannot be read is reported as unread', () => {
  const refusing = { peerDependencies: { footprintjs: '^11.0.0' } };
  it.each([
    ['a manifest field that is not an object', { peerDependencies: '^11.0.0' }, {}],
    ['a range that is a number', { peerDependencies: { footprintjs: 11 } }, {}],
    ['a range that does not parse', { dependencies: { footprintjs: '^11.x.banana' } }, {}],
    ['a manifest that is not an object', null, {}],
    ['a lock with no packages map', refusing, { lock: { packages: [] } }],
    ['a lock entry that is not an object', refusing, { lock: lockOf({ 'node_modules/a': 'x' }) }],
    ['a locked peer that is not a text', refusing, { lock: lockOf({ 'node_modules/a': peer('1.0.0', 7 as never) }) }],
    ['a registry pin whose manifest is not an object', refusing, { pins: { 'a@1.0.0': 'x' } }],
  ])('%s', (_name, manifest, options) => {
    const found = rangeFor(manifest, options);
    expect(found.unread).toMatch(/\S/);
    expect(found.declarations).toBeUndefined();
  });

  it('a registry or lock read that throws', () => {
    const throws = () => {
      throw new Error('registry unavailable');
    };
    const manifests = new Map([['/d', refusing]]);
    for (const services of [
      { installedTree: throws, publishedPeers: () => ({}) },
      { installedTree: () => lockOf({}), publishedPeers: throws },
    ])
      expect(declaredRange(['/d'], ['a@1.0.0'], manifests, services).unread).toContain('registry unavailable');
  });

  it('a base or candidate that is not a version throws (the audit then judges as before)', () => {
    expect(() => decideRange([], 'not-a-version', '12.0.0')).toThrow();
    expect(() => decideRange([], '12.0.0', 'not-a-version')).toThrow();
  });
});

describe('property: the two questions read different facts', () => {
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

  it('may block ⇔ every statement accepts the base or its release; relabel ⇔ some declaration refuses the candidate', () => {
    assertProperty(
      property(
        version,
        version,
        array(tuple(field, spec), { maxLength: 4 }),
        array(range, { maxLength: 3 }),
        (base, candidate, own, installed) => {
          const manifest: Record<string, Record<string, string>> = {};
          for (const [name, value] of own) manifest[name] = { footprintjs: value };
          const lock = lockOf(Object.fromEntries(installed.map((r, i) => [`node_modules/p${i}`, peer('1.0.0', r)])));
          const { decision } = decided(manifest, { lock }, base, candidate);
          const statements = Object.entries(manifest)
            .filter(([name]) => name !== 'devDependencies')
            .map(([, value]) => value.footprintjs)
            .filter((value) => semver.validRange(value) !== null && !value.startsWith('file:'));
          const release = `${semver.major(base)}.${semver.minor(base)}.${semver.patch(base)}`;
          expect(decision.mayBlock).toBe(
            statements.every((r) => semver.satisfies(base, r) || semver.satisfies(release, r)),
          );
          expect(decision.candidateRefusing.length > 0).toBe(
            [...statements, ...installed].some((r) => !semver.satisfies(candidate, r)),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});
