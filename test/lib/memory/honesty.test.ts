/**
 * honesty.ts — the ONE vocabulary for what a reader cannot see (F4a).
 *
 *   unit      the registry is frozen and closed; every explanation is ONE sentence; `note` keeps the shape
 *             the five slice builders always built (members AND key order)
 *   boundary  the TYPES, asked of the real compiler: a code the registry does not hold FAILS TO COMPILE,
 *             and the public unions are exactly the members they were — they did not widen
 *   scenario  the five slice notes still say today's bytes; every honesty signal the library produces is
 *             on the registry; the `/trace` door hands out the very registry and keeps `note` to itself;
 *             a redacted run still speaks both placeholders at the five places that used to spell them
 *
 * The bytes below were taken from the library at 9.31.0, before the notes went through `note()` and the
 * placeholders moved here. Nothing in this file changed a runtime string.
 */
import { join, resolve } from 'path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import { decide, flowChart, FlowChartExecutor } from '../../../src';
import * as advancedDoor from '../../../src/advanced';
import * as detachDoor from '../../../src/detach';
import * as rootDoor from '../../../src/index';
import { HONESTY_CODES, LOG_PLACEHOLDER, note, SCOPE_PLACEHOLDER } from '../../../src/lib/memory/honesty';
import { REDACTED } from '../../../src/lib/memory/redaction';
import type { CommitBundle } from '../../../src/lib/memory/types';
import {
  conservativeEdgesNote,
  preRunOriginNote,
  readsNotRecordedNote,
  truncatedNote,
  unknownKeyNote,
} from '../../../src/lib/slice/keyIndex';
import * as recordersDoor from '../../../src/recorders';
import * as traceDoor from '../../../src/trace';
import { causalChain, stateAt } from '../../../src/trace';
import * as zodDoor from '../../../src/zod';

const REPO = resolve(__dirname, '../../..');

/** The five codes a slice's notes speak, the two a fold's basis speaks, and the two signals that carry no code. */
const SLICE_CODES = ['conservative-fed-edges', 'pre-run-origin', 'reads-not-recorded', 'unknown-key', 'truncated'];
const FOLD_BASES = ['initial+log', 'log-only'];
const SIGNALS_WITHOUT_A_CODE_FIELD = ['log-gap', 'incomplete-sources'];

// ════════════════════════════════════════════════════════════════════════════
// unit — the registry
// ════════════════════════════════════════════════════════════════════════════

describe('HONESTY_CODES — unit', () => {
  const codes = HONESTY_CODES as Record<string, string>;

  it('is frozen: no code can be added, changed or removed at run time', () => {
    expect(Object.isFrozen(HONESTY_CODES)).toBe(true);
    expect(() => {
      codes['unknown-key'] = 'something else';
    }).toThrow(TypeError);
    expect(() => {
      codes['a-new-code'] = 'a sentence.';
    }).toThrow(TypeError);
    expect(() => {
      delete codes.truncated;
    }).toThrow(TypeError);
  });

  it('holds exactly the nine codes the library speaks — five slice notes, two fold bases, two codeless signals', () => {
    expect(Object.keys(HONESTY_CODES).sort()).toEqual(
      [...SLICE_CODES, ...FOLD_BASES, ...SIGNALS_WITHOUT_A_CODE_FIELD].sort(),
    );
  });

  it('every explanation is ONE non-empty sentence: starts a sentence, ends it, and ends it once', () => {
    for (const [code, sentence] of Object.entries(HONESTY_CODES)) {
      expect(sentence.length, `${code}: empty`).toBeGreaterThan(0);
      expect(sentence, `${code}: stray whitespace`).toBe(sentence.trim());
      expect(sentence, `${code}: more than one line`).not.toMatch(/\n/);
      expect(sentence, `${code}: does not start a sentence`).toMatch(/^[A-Z]/);
      expect(sentence, `${code}: does not end with a period`).toMatch(/\.$/);
      expect(sentence.match(/[.!?](\s|$)/g), `${code}: more than one sentence`).toHaveLength(1);
    }
  });

  it('no two codes share a sentence (a copy-paste would make two signals read alike)', () => {
    const sentences = Object.values(HONESTY_CODES);
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});

describe('note — unit', () => {
  it('builds the literal the slice builders always built: the same members AND the same key order (code, then detail)', () => {
    const built = note('unknown-key', 'some detail');
    expect(built).toEqual({ code: 'unknown-key', detail: 'some detail' });
    expect(Object.keys(built)).toEqual(['code', 'detail']);
    expect(JSON.stringify(built)).toBe('{"code":"unknown-key","detail":"some detail"}');
  });

  it('is pure: a fresh object per call, nothing shared, nothing added', () => {
    const a = note('truncated', 'x');
    const b = note('truncated', 'x');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    a.detail = 'changed';
    expect(note('truncated', 'x').detail).toBe('x');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// boundary — the types, asked of the real compiler
// ════════════════════════════════════════════════════════════════════════════

/**
 * Each case is ONE line of a virtual file that lives (in memory only) beside honesty.ts, so it
 * imports the real modules; the compiler reads it with the repo's own tsconfig. `expectTypeOf`
 * would be a no-op under vitest (esbuild strips types) and nothing in the suite type-checks
 * `test/`, so the compile-time guarantee is asked of the compiler itself, here, in the suite.
 */
const HEADER = [
  "import type { FoldBasis } from '../time-travel/types.js';",
  "import type { HonestyNoteCode, HonestyNote } from '../slice/types.js';",
  "import { HONESTY_CODES, note } from './honesty.js';",
  "import type { HonestyCode, RegisteredCode } from './honesty.js';",
  "type Today = 'conservative-fed-edges' | 'pre-run-origin' | 'reads-not-recorded' | 'unknown-key' | 'truncated';",
  "type TodayBasis = 'initial+log' | 'log-only';",
];

const CASES: Record<string, string> = {
  // RegisteredCode — the gate every vocabulary-of-codes union goes through
  registeredMembersCompile: "type A = RegisteredCode<'unknown-key' | 'truncated'>;",
  aMisspeltMemberFails: "type B = RegisteredCode<'unknown-keyy'>;",
  oneBadMemberPoisonsTheUnion: "type C = RegisteredCode<'unknown-key' | 'nonsense'>;",
  // the declared unions sit inside the registry …
  sliceCodesAreRegistered: 'const a: HonestyCode = null as unknown as HonestyNoteCode;',
  foldBasesAreRegistered: 'const b: HonestyCode = null as unknown as FoldBasis;',
  // … and are exactly the members they were: mutually assignable with today's literal unions …
  sliceUnionIsToday:
    'const c: Today = null as unknown as HonestyNoteCode; const d: HonestyNoteCode = null as unknown as Today;',
  foldUnionIsToday:
    'const e: TodayBasis = null as unknown as FoldBasis; const f: FoldBasis = null as unknown as TodayBasis;',
  // … and did NOT widen to every registered code
  sliceUnionRefusesALogGap: "const g: HonestyNoteCode = 'log-gap';",
  sliceUnionRefusesABasis: "const h: HonestyNoteCode = 'log-only';",
  foldUnionRefusesASliceCode: "const i: FoldBasis = 'truncated';",
  // note — typed by the registry, and only a slice code makes a HonestyNote
  noteKeepsItsCodeType: "const j: { code: 'unknown-key'; detail: string } = note('unknown-key', 'x');",
  noteRefusesAnUnregisteredCode: "note('nonsense', 'x');",
  aSliceNoteCanBeBuilt: "const k: HonestyNote = note('pre-run-origin', 'x');",
  aNonSliceCodeIsNotASliceNote: "const l: HonestyNote = note('log-gap', 'x');",
  // the registry itself, as a type
  lookupByARegisteredCodeIsAString:
    "const m: string = HONESTY_CODES['unknown-key']; const n: string = HONESTY_CODES['log-only'];",
  lookupByAnUnregisteredCodeFails: "HONESTY_CODES['nonsense'];",
  theRegistryIsReadonlyToo: "HONESTY_CODES['unknown-key'] = 'x';",
};

describe('the types — asked of the real compiler', () => {
  const PROBE = join(REPO, 'src/lib/memory/__honesty-probe__.ts');
  const names = Object.keys(CASES);
  const byCase = new Map<string, string[]>();

  beforeAll(() => {
    const parsed = ts.parseJsonConfigFileContent(
      ts.readConfigFile(join(REPO, 'tsconfig.json'), ts.sys.readFile).config,
      ts.sys,
      REPO,
    );
    const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, types: [] };
    const source = [...HEADER, ...names.map((name) => CASES[name])].join('\n');
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const readFile = host.readFile.bind(host);
    host.getSourceFile = (file, languageVersion, ...rest) =>
      file === PROBE
        ? ts.createSourceFile(file, source, languageVersion)
        : getSourceFile(file, languageVersion, ...rest);
    host.fileExists = (file) => file === PROBE || fileExists(file);
    host.readFile = (file) => (file === PROBE ? source : readFile(file));

    const program = ts.createProgram([PROBE], options, host);
    const probe = program.getSourceFile(PROBE)!;
    for (const d of ts.getPreEmitDiagnostics(program, probe)) {
      // one case per line, after the header: the line says which case the compiler is talking about
      const line = probe.getLineAndCharacterOfPosition(d.start ?? 0).line - HEADER.length;
      const name = names[line] ?? `(header, line ${line + HEADER.length + 1})`;
      byCase.set(name, [...(byCase.get(name) ?? []), `TS${d.code}`]);
    }
  }, 120_000);

  it('the probe itself is sound: the header compiles, so every verdict below is about its own line', () => {
    expect([...byCase].filter(([name]) => name.startsWith('(header'))).toEqual([]);
  });

  it('a code the registry holds compiles in RegisteredCode, in a subset check, and as a lookup key', () => {
    for (const name of [
      'registeredMembersCompile',
      'sliceCodesAreRegistered',
      'foldBasesAreRegistered',
      'noteKeepsItsCodeType',
      'aSliceNoteCanBeBuilt',
      'lookupByARegisteredCodeIsAString',
    ]) {
      expect(byCase.get(name), name).toBeUndefined();
    }
  });

  it('a code the registry does NOT hold fails to compile — in RegisteredCode (TS2344), in note (TS2345), as a key (TS7053)', () => {
    expect(byCase.get('aMisspeltMemberFails')).toEqual(['TS2344']);
    expect(byCase.get('oneBadMemberPoisonsTheUnion')).toEqual(['TS2344']);
    expect(byCase.get('noteRefusesAnUnregisteredCode')).toEqual(['TS2345']);
    expect(byCase.get('lookupByAnUnregisteredCodeFails')).toEqual(['TS7053']);
  });

  it("the public unions are exactly today's members: mutually assignable with the literal unions, and not widened", () => {
    expect(byCase.get('sliceUnionIsToday'), 'HonestyNoteCode ≡ the five').toBeUndefined();
    expect(byCase.get('foldUnionIsToday'), 'FoldBasis ≡ the two').toBeUndefined();
    expect(byCase.get('sliceUnionRefusesALogGap')).toEqual(['TS2322']);
    expect(byCase.get('sliceUnionRefusesABasis')).toEqual(['TS2322']);
    expect(byCase.get('foldUnionRefusesASliceCode')).toEqual(['TS2322']);
    expect(byCase.get('aNonSliceCodeIsNotASliceNote')).toEqual(['TS2322']);
  });

  it('the registry is readonly at compile time as well as frozen at run time (TS2540)', () => {
    expect(byCase.get('theRegistryIsReadonlyToo')).toEqual(['TS2540']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// scenario — the bytes did not move
// ════════════════════════════════════════════════════════════════════════════

describe('the five slice notes — the bytes the library built before they went through note()', () => {
  const index = (keys: string[]) => ({ writesByKey: new Map(), readsByKey: new Map(), knownKeys: new Set(keys) });
  const twelve = Array.from({ length: 12 }, (_, i) => `key${String(i).padStart(2, '0')}`);

  const NOTES = {
    unknownFew: {
      built: unknownKeyNote(index(['b', 'a']), 'recipId'),
      code: 'unknown-key',
      detail:
        "unknown key 'recipId' — this commit log has no write and no recorded read of it. Known keys: a, b. If the key is real, check that the commit log and the reads provider come from the SAME scope (a subflow has its own).",
    },
    unknownNone: {
      built: unknownKeyNote(index([]), 'x'),
      code: 'unknown-key',
      detail:
        "unknown key 'x' — this commit log has no write and no recorded read of it. Known keys: (none). If the key is real, check that the commit log and the reads provider come from the SAME scope (a subflow has its own).",
    },
    unknownMany: {
      built: unknownKeyNote(index(twelve), 'typo'),
      code: 'unknown-key',
      detail:
        "unknown key 'typo' — this commit log has no write and no recorded read of it. Known keys: key00, key01, key02, key03, key04, key05, key06, key07, key08, key09 (+2 more). If the key is real, check that the commit log and the reads provider come from the SAME scope (a subflow has its own).",
    },
    readsNotRecorded: {
      built: readsNotRecordedNote(),
      code: 'reads-not-recorded',
      detail:
        "reads were not recorded (readTracking may be 'off') — 'nothing read this value' is UNKNOWABLE here, not true.",
    },
    preRunOrigin: {
      built: preRunOriginNote('creditTier'),
      code: 'pre-run-origin',
      detail:
        "'creditTier' has no write before this point — the value came from initial state, frozen run input (args), or a closure. The reads listed did see it; who put it there is outside the commit log.",
    },
    conservative: {
      built: conservativeEdgesNote('creditTier'),
      code: 'conservative-fed-edges',
      detail:
        "some 'fed' edges are CONSERVATIVE (stage-level): those writes carry no per-write read provenance, so a stage that read 'creditTier' and wrote another key may not actually have used it. Run with writeProvenance: 'reads-prefix' to get exact edges.",
    },
    truncatedDepth: {
      built: truncatedNote(true, false),
      code: 'truncated',
      detail: 'walk truncated (maxDepth reached) — more consumers of this value exist beyond this horizon.',
    },
    truncatedNodes: {
      built: truncatedNote(false, true),
      code: 'truncated',
      detail: 'walk truncated (maxNodes reached) — more consumers of this value exist beyond this horizon.',
    },
    truncatedBoth: {
      built: truncatedNote(true, true),
      code: 'truncated',
      detail:
        'walk truncated (maxDepth reached, maxNodes reached) — more consumers of this value exist beyond this horizon.',
    },
  };

  for (const [name, { built, code, detail }] of Object.entries(NOTES)) {
    it(`${name}: the same code, the same words, the same key order`, () => {
      expect(built).toEqual({ code, detail });
      expect(Object.keys(built)).toEqual(['code', 'detail']);
      expect(JSON.stringify(built)).toBe(JSON.stringify({ code, detail }));
    });
  }

  it('every code a builder speaks is on the registry, and each of the five is spoken', () => {
    const spoken = new Set(Object.values(NOTES).map((n) => n.built.code));
    expect([...spoken].sort()).toEqual([...SLICE_CODES].sort());
    for (const code of spoken) expect(Object.keys(HONESTY_CODES), code).toContain(code);
  });
});

describe('every honesty signal the library produces is on the registry — and none gained a field', () => {
  const bundle = (n: number, extra: Partial<CommitBundle> = {}): CommitBundle => ({
    idx: n,
    stage: `S${n}`,
    stageId: `s${n}`,
    runtimeStageId: `s${n}#${n}`,
    trace: [{ path: `k${n}`, verb: 'set' }],
    redactedPaths: [],
    overwrite: { [`k${n}`]: n },
    updates: {},
    ...extra,
  });

  it("a fold's basis: 'initial+log' with a base, 'log-only' without one — both registered", () => {
    const log = [bundle(0), bundle(1)];
    const based = stateAt({ commitLog: log, initialState: { seeded: 1 } }, 1);
    const bare = stateAt({ commitLog: log }, 1);
    expect([based.basis, bare.basis]).toEqual(['initial+log', 'log-only']);
    for (const basis of [based.basis, bare.basis]) expect(Object.keys(HONESTY_CODES)).toContain(basis);
  });

  it("a stored-log row that is not a bundle is a LogGap (index, reason) — registered as 'log-gap', and carries no code", () => {
    const folded = stateAt({ commitLog: [bundle(0), null, bundle(2)] }, 2);
    expect(folded.skipped).toEqual([{ index: 1, reason: 'not an object (null)' }]);
    expect(Object.keys(folded.skipped![0])).toEqual(['index', 'reason']);
    expect(Object.keys(HONESTY_CODES)).toContain('log-gap');
  });

  it("a stage that also consumed untracked reads stamps incompleteSources — registered as 'incomplete-sources', no code field", () => {
    const log = [bundle(0), bundle(1, { untrackedSources: ['args'] })];
    const node = causalChain(log, 's1#1', () => ['k0'])!;
    expect(node.incompleteSources).toEqual(['args']);
    expect(Object.keys(node)).not.toContain('code');
    expect(Object.keys(HONESTY_CODES)).toContain('incomplete-sources');
  });
});

describe('the doors', () => {
  it('footprintjs/trace hands out the very registry object', () => {
    expect(traceDoor.HONESTY_CODES).toBe(HONESTY_CODES);
  });

  it('`note` is internal: no door hands it out', () => {
    for (const [door, entry] of Object.entries({
      rootDoor,
      advancedDoor,
      recordersDoor,
      traceDoor,
      detachDoor,
      zodDoor,
    })) {
      expect(Object.keys(entry), door).not.toContain('note');
    }
  });
});

describe('the two placeholders — the five places that used to spell them still say the same strings', () => {
  it('are the strings stored recordings and every reader already match on', () => {
    expect(LOG_PLACEHOLDER).toBe('REDACTED');
    expect(SCOPE_PLACEHOLDER).toBe('[REDACTED]');
    // the historical name in redaction.ts is the same string, not a second one
    expect(REDACTED).toBe('[REDACTED]');
  });

  interface State {
    ssn: string;
    apiKey: string;
    seeded: string;
    picked: string;
  }

  /** The tree node for `stageId` — `next` and `children` are the only ways down. */
  function findStage(node: any, stageId: string): any {
    if (!node) return undefined;
    if (node.id === stageId) return node;
    for (const child of [node.next, ...(node.children ?? [])]) {
      const found = findStage(child, stageId);
      if (found) return found;
    }
    return undefined;
  }

  it('a redacted run: the log and the mirror say REDACTED; every scope-tier view says [REDACTED]', async () => {
    const emitted: Array<{ payload: unknown }> = [];
    const decisions: Array<{ evidence: { rules: any[] } }> = [];
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.ssn = '123-45-6789';
        scope.apiKey = 'sk-secret';
        scope.$emit('app.auth.check', { token: 'tok' });
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (scope) =>
          decide(
            scope,
            [
              // a filter rule reads through the evaluator …
              { when: { ssn: { eq: 'nope' } }, then: 'a', label: 'by-ssn' },
              // … a function rule through the evidence collector
              { when: (s) => s.$getValue('apiKey') === 'zzz', then: 'b', label: 'by-fn' },
            ],
            'c',
          ),
        'route',
      )
      .addFunctionBranch('a', 'A', (scope) => {
        scope.picked = 'a';
      })
      .addFunctionBranch('b', 'B', (scope) => {
        scope.picked = 'b';
      })
      .addFunctionBranch('c', 'C', (scope) => {
        scope.picked = 'c';
      })
      .setDefault('c')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, { initialContext: { seeded: 'seed-secret' } });
    executor.setRedactionPolicy({ keys: ['ssn', 'apiKey', 'seeded'], emitPatterns: [/\.auth\./] });
    executor.attachEmitRecorder({ id: 'emits', onEmit: (e) => emitted.push(e) });
    executor.attachFlowRecorder({ id: 'flow', onDecision: (e) => decisions.push(e as never) });
    await executor.run();

    const live = executor.getSnapshot();
    const safe = executor.getSnapshot({ redact: true });

    // LOG tier — memory/utils.ts · redactPatch: what the commit log recorded
    const seedCommit = (live.commitLog as CommitBundle[]).find((b) => b.stageId === 'seed')!;
    expect(seedCommit.overwrite).toMatchObject({ ssn: 'REDACTED', apiKey: 'REDACTED' });
    // LOG tier — runner/ExecutionRuntime.ts: the mirror's seed is scrubbed with the log's string
    expect((safe.sharedState as Record<string, unknown>).seeded).toBe('REDACTED');
    expect((safe.sharedState as Record<string, unknown>).ssn).toBe('REDACTED');

    // SCOPE tier — scope/ScopeFacade.ts · emitEvent: a pattern-matched emit payload
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toBe('[REDACTED]');
    // SCOPE tier — decide/evaluator.ts: a filter rule's condition on a redacted key
    const [filterRule, functionRule] = decisions[0].evidence.rules;
    expect(filterRule.conditions[0]).toMatchObject({ key: 'ssn', actualSummary: '[REDACTED]', redacted: true });
    // SCOPE tier — decide/evidence.ts: a function rule's read of a redacted key
    expect(functionRule.inputs[0]).toMatchObject({ key: 'apiKey', valueSummary: '[REDACTED]', redacted: true });
    // SCOPE tier — memory/StageContext.ts · retainedForm: the retained reads of the deciding stage
    expect(findStage(live.executionTree, 'route').stageReads).toMatchObject({
      ssn: '[REDACTED]',
      apiKey: '[REDACTED]',
    });
  });
});
