/**
 * honesty.ts — the ONE vocabulary for what a reader cannot see (F4a).
 *
 *   unit      the registry is frozen and closed, holds exactly the twenty-one codes, and every explanation is
 *             ONE sentence
 *   boundary  the TYPES, asked of the real compiler: a code the registry does not hold FAILS TO COMPILE; the
 *             six public unions are exactly the members they were (they did not widen); the sentences are
 *             typed `string`; and every registered code belongs to a declared vocabulary (none is orphaned)
 *   scenario  the five slice notes still say the 9.31.0 bytes; each code the slice queries and the fold
 *             EMIT is on the registry, and the signals that carry no code gained no field; the `/trace` door
 *             hands out the very registry; a redacted run still speaks both placeholders
 *             (`memory/placeholders.ts`) at the five places that used to spell them
 *
 * The bytes below were taken from the library at 9.31.0, before the placeholders moved. Nothing in this file
 * changed a runtime string.
 *
 * F3 (9.33.0, ruling R4) added ONE code, `'nested-rows'` (a slice note), so exactly two pins moved, and only by
 * that member: the registry holds NINETEEN codes (six slice notes), and `HonestyNoteCode`'s literal union `Today`
 * gains `'nested-rows'`. The five 9.31.0 note bytes, and the check that their builders speak exactly those five,
 * are untouched (`SLICE_CODES_9_31`); the new note's builder is pinned on its own.
 *
 * F4b (9.33.0) added TWO codes, `'deleted'` and `'from-initial-state'` (the value basis of
 * `commitValueAtWithBasis`): the registry holds TWENTY-ONE. `'redacted'`'s sentence was reworded to be true of
 * both emitters (a fold and a key's value basis); no runtime string the engine writes changed. `HonestyNoteCode`
 * gains `'redacted'` and `'from-initial-state'` (a backward slice's notes say them), and `'pre-run-origin'`'s
 * sentence says "absent or already there" (a causal node's `preRunReads` lists keys that never existed too).
 */
import { join, resolve } from 'path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

import { decide, flowChart, FlowChartExecutor } from '../../../src';
import { HONESTY_CODES } from '../../../src/lib/memory/honesty';
import { LOG_PLACEHOLDER, SCOPE_PLACEHOLDER } from '../../../src/lib/memory/placeholders';
import type { CommitBundle } from '../../../src/lib/memory/types';
import {
  conservativeEdgesNote,
  nestedRowsNote,
  preRunOriginNote,
  readsNotRecordedNote,
  truncatedNote,
  unknownKeyNote,
} from '../../../src/lib/slice/keyIndex';
import * as traceDoor from '../../../src/trace';
import {
  arrayProvenance,
  causalChain,
  forwardSliceForKey,
  keyTimeline,
  sliceForKey,
  stateAt,
} from '../../../src/trace';

const REPO = resolve(__dirname, '../../..');

/** The codes each declared vocabulary speaks, and the signals that carry no code field of their own. */
/** The five slice notes the library built at 9.31.0 — the bytes pinned below. */
const SLICE_CODES_9_31 = ['conservative-fed-edges', 'pre-run-origin', 'reads-not-recorded', 'unknown-key', 'truncated'];
/** Every slice note today: the five, and F3's `'nested-rows'`. */
const SLICE_CODES = [...SLICE_CODES_9_31, 'nested-rows'];
const MISSING_REASONS = ['empty-log', 'never-written', 'not-an-array'];
const FED_BASES = ['per-write', 'stage'];
const ATTRIBUTION_BASES = ['append-verb', 'prefix-inference', 'whole-value'];
const FOLD_BASES = ['initial+log', 'log-only'];
/** F4b (9.33.0): the two codes only a key's value basis speaks (`ValueBasis` — the rest of it is shared). */
const VALUE_BASES = ['deleted', 'from-initial-state'];
const SIGNALS_WITHOUT_A_CODE_FIELD = ['log-gap', 'incomplete-sources', 'redacted'];

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

  it('holds exactly twenty-one codes — six slice notes, three missing reasons, two fed-edge and three birth bases, two fold bases, two value bases, three codeless signals', () => {
    const all = [
      ...SLICE_CODES,
      ...MISSING_REASONS,
      ...FED_BASES,
      ...ATTRIBUTION_BASES,
      ...FOLD_BASES,
      ...VALUE_BASES,
      ...SIGNALS_WITHOUT_A_CODE_FIELD,
    ];
    expect(all).toHaveLength(21);
    expect(Object.keys(HONESTY_CODES).sort()).toEqual(all.sort());
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
  "import type { AttributionBasis, FedBasis, HonestyNote, HonestyNoteCode } from '../slice/types.js';",
  "import type { MissingProvenanceReason, MissingSliceReason } from '../slice/types.js';",
  "import type { ValueBasis, WriterBasis } from './commitLogUtils.js';",
  "import { HONESTY_CODES } from './honesty.js';",
  "import type { HonestyCode, RegisteredCode } from './honesty.js';",
  "type Today = 'conservative-fed-edges' | 'nested-rows' | 'pre-run-origin' | 'reads-not-recorded' | 'unknown-key' | 'truncated' | 'redacted' | 'from-initial-state';",
  "type TodayBasis = 'initial+log' | 'log-only';",
  "type TodayMissing = 'empty-log' | 'never-written';",
  "type TodayProvenance = 'empty-log' | 'never-written' | 'not-an-array';",
  "type TodayFed = 'per-write' | 'stage';",
  "type TodayAttribution = 'append-verb' | 'prefix-inference' | 'whole-value';",
  "type TodayValue = 'never-written' | 'deleted' | 'nested-rows' | 'from-initial-state' | 'redacted';",
  "type TodayWriter = 'never-written' | 'nested-rows';",
  // every declared vocabulary, plus the three codes a field carries instead of a `code` value
  'type Declared = HonestyNoteCode | MissingSliceReason | MissingProvenanceReason | FedBasis | AttributionBasis | FoldBasis | ' +
    'ValueBasis | WriterBasis | ' +
    "'log-gap' | 'incomplete-sources' | 'redacted';",
];

const CASES: Record<string, string> = {
  // RegisteredCode — the gate every vocabulary-of-codes union goes through
  registeredMembersCompile: "type A = RegisteredCode<'unknown-key' | 'truncated'>;",
  aMisspeltMemberFails: "type B = RegisteredCode<'unknown-keyy'>;",
  oneBadMemberPoisonsTheUnion: "type C = RegisteredCode<'unknown-key' | 'nonsense'>;",
  // the declared unions sit inside the registry …
  sliceCodesAreRegistered: 'const a: HonestyCode = null as unknown as HonestyNoteCode;',
  foldBasesAreRegistered: 'const b: HonestyCode = null as unknown as FoldBasis;',
  sliceReasonsAndBasesAreRegistered:
    'const c0: HonestyCode = null as unknown as MissingSliceReason | MissingProvenanceReason | FedBasis | AttributionBasis;',
  // … and are exactly the members they were: mutually assignable with today's literal unions …
  sliceUnionIsToday:
    'const c: Today = null as unknown as HonestyNoteCode; const d: HonestyNoteCode = null as unknown as Today;',
  foldUnionIsToday:
    'const e: TodayBasis = null as unknown as FoldBasis; const f: FoldBasis = null as unknown as TodayBasis;',
  missingUnionIsToday:
    'const e1: TodayMissing = null as unknown as MissingSliceReason; const f1: MissingSliceReason = null as unknown as TodayMissing;',
  provenanceUnionIsToday:
    'const e2: TodayProvenance = null as unknown as MissingProvenanceReason; const f2: MissingProvenanceReason = null as unknown as TodayProvenance;',
  fedUnionIsToday:
    'const e3: TodayFed = null as unknown as FedBasis; const f3: FedBasis = null as unknown as TodayFed;',
  attributionUnionIsToday:
    'const e4: TodayAttribution = null as unknown as AttributionBasis; const f4: AttributionBasis = null as unknown as TodayAttribution;',
  valueUnionIsToday:
    'const e5: TodayValue = null as unknown as ValueBasis; const f5: ValueBasis = null as unknown as TodayValue;',
  writerUnionIsToday:
    'const e6: TodayWriter = null as unknown as WriterBasis; const f6: WriterBasis = null as unknown as TodayWriter;',
  // … and did NOT widen to every registered code
  sliceUnionRefusesALogGap: "const g: HonestyNoteCode = 'log-gap';",
  sliceUnionRefusesABasis: "const h: HonestyNoteCode = 'log-only';",
  foldUnionRefusesASliceCode: "const i: FoldBasis = 'truncated';",
  missingUnionRefusesAProvenanceReason: "const i1: MissingSliceReason = 'not-an-array';",
  fedUnionRefusesABirthBasis: "const i2: FedBasis = 'whole-value';",
  // a note's code is typed by the registry: only a slice code makes a HonestyNote
  aNoteWithASliceCodeCompiles: "const k: HonestyNote = { code: 'pre-run-origin', detail: 'x' };",
  aNoteWithAnUnregisteredCodeFails: "const l: HonestyNote = { code: 'nonsense', detail: 'x' };",
  // every registered code belongs to a declared vocabulary or a codeless signal — none is orphaned …
  everyCodeIsDeclared: 'const w: Declared = null as unknown as HonestyCode;',
  // … and that check bites: leave one out and a registered code has nowhere to go
  aCodeLeftOverFails: "const x: Exclude<Declared, 'redacted'> = null as unknown as HonestyCode;",
  // the registry itself, as a type
  lookupByARegisteredCodeIsAString:
    "const m: string = HONESTY_CODES['unknown-key']; const n: string = HONESTY_CODES['log-only'];",
  theSentencesAreTypedString: "const v: (typeof HONESTY_CODES)['unknown-key'] = 'x';",
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
    // `noUnusedLocals: false`: every case declares a local nothing reads, and that must never be the verdict
    const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, noUnusedLocals: false, types: [] };
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

  it('a code the registry holds compiles in RegisteredCode, in a subset check, in a note and as a lookup key', () => {
    for (const name of [
      'registeredMembersCompile',
      'sliceCodesAreRegistered',
      'foldBasesAreRegistered',
      'sliceReasonsAndBasesAreRegistered',
      'aNoteWithASliceCodeCompiles',
      'lookupByARegisteredCodeIsAString',
    ]) {
      expect(byCase.get(name), name).toBeUndefined();
    }
  });

  it('a code the registry does NOT hold fails to compile — in RegisteredCode (TS2344), in a note (TS2322), as a key (TS7053)', () => {
    expect(byCase.get('aMisspeltMemberFails')).toEqual(['TS2344']);
    expect(byCase.get('oneBadMemberPoisonsTheUnion')).toEqual(['TS2344']);
    expect(byCase.get('aNoteWithAnUnregisteredCodeFails')).toEqual(['TS2322']);
    expect(byCase.get('lookupByAnUnregisteredCodeFails')).toEqual(['TS7053']);
  });

  it("the eight public unions are exactly today's members: mutually assignable with the literal unions, and not widened", () => {
    for (const name of [
      'valueUnionIsToday',
      'writerUnionIsToday',
      'sliceUnionIsToday',
      'foldUnionIsToday',
      'missingUnionIsToday',
      'provenanceUnionIsToday',
      'fedUnionIsToday',
      'attributionUnionIsToday',
    ]) {
      expect(byCase.get(name), name).toBeUndefined();
    }
    for (const name of [
      'sliceUnionRefusesALogGap',
      'sliceUnionRefusesABasis',
      'foldUnionRefusesASliceCode',
      'missingUnionRefusesAProvenanceReason',
      'fedUnionRefusesABirthBasis',
    ]) {
      expect(byCase.get(name), name).toEqual(['TS2322']);
    }
  });

  it('every registered code belongs to a declared vocabulary or a codeless signal — and the check bites', () => {
    expect(byCase.get('everyCodeIsDeclared')).toBeUndefined();
    expect(byCase.get('aCodeLeftOverFails')).toEqual(['TS2322']);
  });

  it('the sentences are typed `string`, not literal types — an `as const` on the registry fails here', () => {
    expect(byCase.get('theSentencesAreTypedString')).toBeUndefined();
  });

  it('the registry is readonly at compile time as well as frozen at run time (TS2540)', () => {
    expect(byCase.get('theRegistryIsReadonlyToo')).toEqual(['TS2540']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// scenario — the bytes did not move
// ════════════════════════════════════════════════════════════════════════════

describe('the five slice notes — the bytes the library built at 9.31.0', () => {
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
    expect([...spoken].sort()).toEqual([...SLICE_CODES_9_31].sort());
    for (const code of spoken) expect(Object.keys(HONESTY_CODES), code).toContain(code);
  });
});

describe("F3's slice note — 'nested-rows'", () => {
  it('its builder speaks a registered code and names the key by its segments, the commits and the overflow', () => {
    const one = nestedRowsNote('cfg', [1]);
    expect(one.code).toBe('nested-rows');
    expect(Object.keys(HONESTY_CODES)).toContain(one.code);
    expect(one.detail).toBe(
      "'cfg' was written only through paths inside it at commit 1 — such a write changed part of its value, not the whole: earlier writes may account for the rest, and a reader of the key may not have read the part it changed.",
    );
    const many = nestedRowsNote(['cfg', 'inner'].join('\u001F'), [1, 2, 3, 4, 5, 6, 7]);
    expect(
      many.detail.startsWith(
        "'cfg › inner' was written only through paths inside it at commits 1, 2, 3, 4, 5 (+2 more) — ",
      ),
    ).toBe(true);
  });
});

describe('every code the slice queries and the fold emit is on the registry — and the codeless signals gained no field', () => {
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

  it("a budget that cut a causal walk stamps truncated on the root — registered as 'truncated', no code field", () => {
    const log = [bundle(0), bundle(1)];
    const node = causalChain(log, 's1#1', () => ['k0'], { maxDepth: 0 })!;
    expect(node.truncated).toEqual({ byDepth: true, byNodes: false });
    expect(Object.keys(node)).not.toContain('code');
    expect(Object.keys(HONESTY_CODES)).toContain('truncated');
  });

  it("a fold over a scrubbed row says redacted + redactedPaths — registered as 'redacted', no code field, the log's placeholder", () => {
    const log = [bundle(0, { overwrite: { k0: LOG_PLACEHOLDER }, redactedPaths: ['k0'] }), bundle(1)];
    const folded = stateAt({ commitLog: log, initialState: {} }, 1);
    expect([folded.redacted, folded.redactedPaths, folded.state.k0]).toEqual([true, ['k0'], 'REDACTED']);
    expect(Object.keys(folded)).not.toContain('code');
    expect(Object.keys(HONESTY_CODES)).toContain('redacted');
  });

  it('a slice with no answer says why — every missing reason the four queries emit is registered', () => {
    const log = [bundle(0), bundle(1)];
    const reads = () => ['k0'];
    const emitted = [
      sliceForKey([], 'k0', reads).missing,
      sliceForKey(log, 'nope', reads).missing,
      forwardSliceForKey([], 'k0', reads).missing,
      forwardSliceForKey(log, 'nope', reads).missing,
      keyTimeline(log, 'nope', reads).missing,
      arrayProvenance([], 'k0').missing,
      arrayProvenance(log, 'nope').missing,
      arrayProvenance(log, 'k0').missing,
    ];
    expect(emitted).toEqual([
      'empty-log',
      'never-written',
      'empty-log',
      'never-written',
      'never-written',
      'empty-log',
      'never-written',
      'not-an-array',
    ]);
    for (const reason of emitted) expect(Object.keys(HONESTY_CODES)).toContain(reason);
  });

  it("a fed edge says how it was attributed — 'per-write' with recorded provenance, 'stage' without; both registered", () => {
    const log = [
      bundle(0),
      bundle(1, { trace: [{ path: 'k1', verb: 'set', readKeys: ['k0'] }] }),
      bundle(2, { trace: [{ path: 'k2', verb: 'set' }] }),
    ];
    const reads = (id: string) => (id === 's0#0' ? [] : ['k0']);
    const bases = forwardSliceForKey(log, 'k0', reads).root!.fedEdges.map((edge) => edge.basis);
    expect(bases).toEqual(['per-write', 'stage']);
    for (const basis of bases) expect(Object.keys(HONESTY_CODES)).toContain(basis);
  });

  it("an element birth says how it was attributed — 'whole-value', 'prefix-inference', 'append-verb'; all registered", () => {
    const write = (n: number, verb: 'set' | 'append', list: number[]) =>
      bundle(n, { trace: [{ path: 'list', verb }], overwrite: { list } });
    const log = [write(0, 'set', [1]), write(1, 'set', [1, 2]), write(2, 'append', [3])];
    const bases = arrayProvenance(log, 'list').births!.map((birth) => birth.basis);
    expect(bases).toEqual(['whole-value', 'prefix-inference', 'append-verb']);
    for (const basis of bases) expect(Object.keys(HONESTY_CODES)).toContain(basis);
  });
});

describe('the doors', () => {
  it('footprintjs/trace hands out the very registry object', () => {
    expect(traceDoor.HONESTY_CODES).toBe(HONESTY_CODES);
  });
});

describe('the two placeholders — the five places that used to spell them still say the same strings', () => {
  it('are the strings stored recordings and every reader already match on', () => {
    expect(LOG_PLACEHOLDER).toBe('REDACTED');
    expect(SCOPE_PLACEHOLDER).toBe('[REDACTED]');
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

    // LOG tier — memory/redaction.ts · redactPatch: what the commit log recorded
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
