/**
 * The fence — tests for `scripts/check-layering.mjs` + `scripts/layering.config.cjs`.
 *
 *   unit      the matcher: most specific pattern wins, an unplaced file is an error
 *   boundary  small fixture trees: every way the analysis must say FAIL (and the ways it must not)
 *   boundary  the closed record (C6): an import of any kind out of RECORD_FILES fails
 *   scenario  THE REAL TREE is clean — 0 value-level cycles, every upward edge named, the record closed
 *   scenario  the ESLint zones say the same thing the script says; and the lint is live
 *
 * A fence nobody can see fail is a fence nobody can trust, so most of this file is the
 * failing half.
 */
import { ESLint } from 'eslint';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { analyse, format } from '../../scripts/check-layering.mjs';
import layering from '../../scripts/layering.config.cjs';

const {
  LAYERS,
  RECORD_FILES,
  EXCEPTIONS,
  TYPE_ONLY_ALLOWANCES,
  SHIMS,
  compileLayers,
  rankOf,
  isRecordFile,
  listSourceFiles,
  layerZones,
} = layering;
const REPO = resolve(__dirname, '../..');

// ── fixtures ─────────────────────────────────────────────────────────────────

const FIXTURE_LAYERS = [
  { rank: 0, name: 'low', files: ['src/lib/low/**'] },
  { rank: 1, name: 'mid', files: ['src/lib/mid/**'] },
  { rank: 2, name: 'high', files: ['src/lib/high/**'] },
  { rank: 3, name: 'entry', files: ['src/*.ts'] },
];
const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Build a tree of `{ 'src/lib/low/a.ts': 'source' }` under a temp dir and analyse it. */
function run(tree: Record<string, string>, config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'layering-'));
  made.push(root);
  for (const [file, source] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return analyse({
    root,
    config: {
      layers: FIXTURE_LAYERS,
      recordFiles: [],
      exceptions: [],
      typeOnlyAllowances: [],
      shims: [],
      ...config,
    },
  });
}

// ── unit: the matcher ────────────────────────────────────────────────────────

describe('layering config — which layer a file is in', () => {
  const layers = compileLayers([
    { rank: 5, name: 'dir', files: ['src/lib/scope/**'] },
    { rank: 0, name: 'leaf', files: ['src/lib/scope/protection/readonlyInput.ts'] },
    { rank: 3, name: 'deeper dir', files: ['src/lib/scope/protection/**'] },
  ]);

  it('an exact path beats a directory glob, and a deeper directory beats a shallower one', () => {
    expect(rankOf('src/lib/scope/ScopeFacade.ts', layers)).toBe(5);
    expect(rankOf('src/lib/scope/protection/other.ts', layers)).toBe(3);
    expect(rankOf('src/lib/scope/protection/readonlyInput.ts', layers)).toBe(0);
  });

  it('a file no pattern matches has no layer (the fence calls it an error, never a default)', () => {
    expect(rankOf('src/lib/elsewhere/x.ts', layers)).toBeNull();
  });

  it('two equally specific patterns in different layers are refused, not guessed', () => {
    const tied = compileLayers([
      { rank: 1, name: 'a', files: ['src/lib/x/**'] },
      { rank: 2, name: 'b', files: ['src/lib/x/**'] },
    ]);
    expect(() => rankOf('src/lib/x/y.ts', tied)).toThrow(/equally/);
  });
});

// ── boundary: the analysis, on small trees ───────────────────────────────────

describe('check-layering — fixture trees', () => {
  const low = 'export const low = 1;\n';

  it('a tree that only imports downward is clean', () => {
    const r = run({
      'src/lib/low/a.ts': low,
      'src/lib/mid/b.ts': "import { low } from '../low/a.js';\nexport const b = low;\n",
      'src/lib/high/c.ts':
        "import { b } from '../mid/b.js';\nimport { low } from '../low/a.js';\nexport const c = [b, low];\n",
      'src/index.ts': "export { c } from './lib/high/c.js';\n",
    });
    expect(r.ok).toBe(true);
    expect(r.upward).toEqual([]);
    expect(r.moduleCycles).toEqual([]);
  });

  it('a RUNTIME import of a higher layer fails, and the report names the edge', () => {
    const r = run({
      'src/lib/low/a.ts': "import { c } from '../high/c.js';\nexport const a = c;\n",
      'src/lib/high/c.ts': 'export const c = 1;\n',
    });
    expect(r.ok).toBe(false);
    expect(r.upwardUnnamed.map((e) => `${e.from} -> ${e.to}`)).toEqual(['src/lib/low/a.ts -> src/lib/high/c.ts']);
    expect(format(r)).toMatch(/FAIL/);
    expect(format(r)).toMatch(/low\/a\.ts:1 \(L0\) -> high\/c\.ts \(L2\) {3}\[NOT NAMED\]/);
  });

  it('the same edge, NAMED in the config, passes — and is still listed', () => {
    const r = run(
      {
        'src/lib/low/a.ts': "import { c } from '../high/c.js';\nexport const a = c;\n",
        'src/lib/high/c.ts': 'export const c = 1;\n',
      },
      { exceptions: [{ from: 'src/lib/low/a.ts', to: 'src/lib/high/c.ts', reason: 'test' }] },
    );
    expect(r.ok).toBe(true);
    expect(r.upward).toHaveLength(1);
    expect(r.upwardUnnamed).toEqual([]);
    expect(r.namedEdges[0]).toMatchObject({ live: true, upwardUnderTable: true });
  });

  it('a naming covers ONE importer and ONE target — not its neighbours', () => {
    const r = run(
      {
        'src/lib/low/a.ts': "import { c } from '../high/c.js';\nexport const a = c;\n",
        'src/lib/low/other.ts': "import { c } from '../high/c.js';\nexport const o = c;\n",
        'src/lib/high/c.ts': 'export const c = 1;\n',
      },
      { exceptions: [{ from: 'src/lib/low/a.ts', to: 'src/lib/high/c.ts', reason: 'test' }] },
    );
    expect(r.upwardUnnamed.map((e) => e.from)).toEqual(['src/lib/low/other.ts']);
  });

  it('type-only imports are not edges: `import type`, `{ type X }`, and an import used only as a type', () => {
    const r = run({
      'src/lib/high/h.ts': 'export interface H { x: number }\nexport const h = 1;\n',
      'src/lib/low/a.ts': "import type { H } from '../high/h.js';\nexport type A = H;\n",
      'src/lib/low/b.ts': "import { type H } from '../high/h.js';\nexport type B = H;\n",
      // not marked `type`, but only ever used in a type position: tsc erases it, so it is not an edge
      'src/lib/low/c.ts': "import { H } from '../high/h.js';\nexport type C = H;\n",
    });
    expect(r.ok).toBe(true);
    expect(r.upward).toEqual([]);
    expect(r.edges.typeOnly).toBe(3);
    expect(r.typeUpward).toHaveLength(3);
  });

  it('a type import placed BEFORE a value import of the same module does not take its slot (the usual order)', () => {
    const r = run({
      'src/lib/high/h.ts': 'export interface H { x: number }\nexport const h = 1;\n',
      'src/lib/low/a.ts':
        "import type { H } from '../high/h.js';\nimport { h } from '../high/h.js';\nexport const a: H = { x: h };\n",
    });
    expect(r.upwardUnnamed.map((e) => [e.kind, e.line])).toEqual([['value', 2]]);
    expect(r.typeUpward.map((e) => e.line)).toEqual([1]);
  });

  it('a value import next to a type import is still a runtime edge', () => {
    const r = run({
      'src/lib/high/h.ts': 'export interface H { x: number }\nexport const h = 1;\n',
      'src/lib/low/a.ts': "import { type H, h } from '../high/h.js';\nexport const a: H = { x: h };\n",
    });
    expect(r.upwardUnnamed).toHaveLength(1);
  });

  it('a module cycle is reported even when no single file cycles', () => {
    const r = run({
      'src/lib/low/a.ts': "import { b } from '../mid/b.js';\nexport const a = b;\n",
      'src/lib/mid/b.ts': "import { c } from '../low/c.js';\nexport const b = c;\n",
      'src/lib/low/c.ts': 'export const c = 1;\n',
    });
    expect(r.moduleCycles).toEqual([['low', 'mid']]);
    expect(r.fileCycles).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it('a file cycle is reported', () => {
    const r = run({
      'src/lib/low/a.ts': "import { b } from './b.js';\nexport const a = () => b;\n",
      'src/lib/low/b.ts': "import { a } from './a.js';\nexport const b = () => a;\n",
    });
    expect(r.fileCycles).toEqual([['src/lib/low/a.ts', 'src/lib/low/b.ts']]);
    expect(r.ok).toBe(false);
  });

  it('a cycle that goes through a type-only import is not a cycle', () => {
    const r = run({
      'src/lib/low/a.ts': "import type { B } from '../mid/b.js';\nexport type A = B;\nexport const a = 1;\n",
      'src/lib/mid/b.ts': "import { a } from '../low/a.js';\nexport type B = typeof a;\n",
    });
    expect(r.moduleCycles).toEqual([]);
    expect(r.fileCycles).toEqual([]);
  });

  it('a dynamic import() counts for layering but cannot close a load-time cycle', () => {
    const r = run({
      'src/lib/low/a.ts': "export const a = () => import('../high/c.js');\n",
      'src/lib/high/c.ts': "import { a } from '../low/a.js';\nexport const c = a;\n",
    });
    expect(r.edges.lazy).toBe(1);
    expect(r.moduleCycles).toEqual([]);
    expect(r.upwardUnnamed.map((e) => e.kind)).toEqual(['dynamic']);
  });

  it('a file in no layer fails', () => {
    const r = run({ 'src/lib/low/a.ts': low, 'src/lib/stray/x.ts': low });
    expect(r.unassigned).toEqual(['src/lib/stray/x.ts']);
    expect(r.ok).toBe(false);
  });

  it('a named edge that no longer exists fails (the list cannot outlive its reason)', () => {
    const r = run(
      { 'src/lib/low/a.ts': low, 'src/lib/high/c.ts': low },
      { exceptions: [{ from: 'src/lib/low/a.ts', to: 'src/lib/high/c.ts', reason: 'gone' }] },
    );
    expect(r.staleNames).toHaveLength(1);
    expect(r.ok).toBe(false);
  });

  it('a type-only allowance that became a runtime import fails', () => {
    const r = run(
      {
        'src/lib/low/a.ts': "import { c } from '../high/c.js';\nexport const a = c;\n",
        'src/lib/high/c.ts': 'export const c = 1;\n',
      },
      { typeOnlyAllowances: [{ from: 'src/lib/low/a.ts', to: 'src/lib/high/c.ts', reason: 'was type-only' }] },
    );
    expect(r.staleNames[0].why).toMatch(/RUNTIME import now/);
    expect(r.ok).toBe(false);
  });

  it('an import of a deprecated old path fails — the shim is for out-of-tree callers', () => {
    const r = run(
      {
        'src/lib/low/old.ts': "export { low } from './new.js';\n",
        'src/lib/low/new.ts': low,
        'src/lib/mid/b.ts': "import { low } from '../low/old.js';\nexport const b = low;\n",
      },
      { shims: ['src/lib/low/old.ts'] },
    );
    expect(r.shimImporters.map((s) => s.from)).toEqual(['src/lib/mid/b.ts']);
    expect(r.ok).toBe(false);
  });
});

// ── boundary: the closed record (C6) ─────────────────────────────────────────

describe('check-layering — the record names nothing outside itself', () => {
  const record = { recordFiles: ['src/lib/low/rec/**', 'src/lib/mid/rec.ts'] };
  const leaf = 'export const leaf = 1;\nexport interface Leaf { x: number }\n';

  it('a record that imports only record files is clean — and anything may import the record', () => {
    const r = run(
      {
        'src/lib/low/rec/a.ts': leaf,
        'src/lib/mid/rec.ts': "import { leaf } from '../low/rec/a.js';\nexport const rec = leaf;\n",
        'src/lib/high/user.ts': "import { rec } from '../mid/rec.js';\nexport const user = rec;\n",
      },
      record,
    );
    expect(r.ok, format(r)).toBe(true);
    expect(r.recordFiles).toBe(2);
    expect(r.recordEscapes).toEqual([]);
  });

  it('a VALUE import out of the record fails, even downward — and the report names it', () => {
    const r = run(
      {
        'src/lib/low/other.ts': leaf,
        'src/lib/mid/rec.ts': "import { leaf } from '../low/other.js';\nexport const rec = leaf;\n",
      },
      record,
    );
    expect(r.ok).toBe(false);
    expect(r.upward).toEqual([]); // the layering is fine; the record is not
    expect(r.recordEscapes.map((e) => `${e.from} -> ${e.to} (${e.kind})`)).toEqual([
      'src/lib/mid/rec.ts -> src/lib/low/other.ts (value)',
    ]);
    expect(format(r)).toMatch(/mid\/rec\.ts:1 -> low\/other\.ts {3}\[value: a record file imports only record files\]/);
  });

  it('a TYPE-only import out of the record fails too — a record cut along the list must compile alone', () => {
    const r = run(
      {
        'src/lib/low/other.ts': leaf,
        'src/lib/mid/rec.ts': "import type { Leaf } from '../low/other.js';\nexport type Rec = Leaf;\n",
      },
      record,
    );
    expect(r.recordEscapes.map((e) => e.kind)).toEqual(['type']);
    expect(r.ok).toBe(false);
  });

  it('what no import declaration shows — an import() TYPE reference, a package — fails: the record compiled alone', () => {
    const typeRef = run(
      { 'src/lib/low/other.ts': leaf, 'src/lib/mid/rec.ts': "export type Rec = import('../low/other.js').Leaf;\n" },
      record,
    );
    expect(typeRef.recordEscapes).toEqual([]); // not an import declaration: the edge reader cannot see it …
    expect(typeRef.recordCompile).toEqual(['compiled alone, the record loads src/lib/low/other.ts']); // … the compile can
    expect(typeRef.ok).toBe(false);

    const pkg = run(
      { 'src/lib/mid/rec.ts': "import type { Thing } from 'not-a-package';\nexport type Rec = Thing;\n" },
      record,
    );
    expect(pkg.recordCompile.join('\n')).toMatch(
      /compiled alone: src\/lib\/mid\/rec\.ts:1 Cannot find module 'not-a-package'/,
    );
    expect(pkg.ok).toBe(false);
  });

  it('a lazy import() out of the record fails', () => {
    const r = run(
      { 'src/lib/low/other.ts': leaf, 'src/lib/mid/rec.ts': "export const rec = () => import('../low/other.js');\n" },
      record,
    );
    expect(r.recordEscapes.map((e) => e.kind)).toEqual(['dynamic']);
    expect(r.ok).toBe(false);
  });

  it('a RECORD_FILES entry that matches nothing, or a record file above L3, is a config error', () => {
    const stale = run({ 'src/lib/low/rec/a.ts': leaf }, { recordFiles: ['src/lib/low/rec/**', 'src/lib/gone/**'] });
    expect(stale.recordProblems).toEqual(['src/lib/gone/** matches no file']);
    expect(stale.ok).toBe(false);

    const above = run(
      { 'src/lib/low/rec/a.ts': leaf, 'src/lib/top/rec.ts': leaf },
      {
        layers: [...FIXTURE_LAYERS, { rank: 4, name: 'top', files: ['src/lib/top/**'] }],
        recordFiles: ['src/lib/low/rec/**', 'src/lib/top/rec.ts'],
      },
    );
    expect(above.recordProblems).toEqual(['src/lib/top/rec.ts is at L4: the record is L0-L3']);
    expect(above.ok).toBe(false);
  });
});

// ── scenario: the real tree ──────────────────────────────────────────────────

describe('the footprintjs source tree', () => {
  const result = analyse({ root: REPO });

  it('passes the fence: 0 value-level cycles, every upward edge named, every file in a layer', () => {
    expect(result.ok, `\n${format(result)}`).toBe(true);
    expect(result.moduleCycles).toEqual([]);
    expect(result.fileCycles).toEqual([]);
    expect(result.unassigned).toEqual([]);
    expect(result.shimImporters).toEqual([]);
  });

  it('names exactly the three edges the layering table was written with — and no more', () => {
    expect(EXCEPTIONS.map((e: { from: string; to: string }) => `${e.from} -> ${e.to}`)).toEqual([
      'src/lib/builder/FlowChartBuilder.ts -> src/lib/runner/RunnableChart.ts',
      'src/lib/engine/** -> src/lib/reactive/handles.ts',
      'src/lib/scope/ScopeFacade.ts -> src/lib/detach/spawn.ts',
    ]);
    expect(result.namedEdges.every((n: { live: boolean }) => n.live)).toBe(true);
  });

  it('every upward RUNTIME edge in the tree is one of the named ones', () => {
    expect(result.upward.map((u: { from: string; to: string }) => `${u.from} -> ${u.to}`)).toEqual([
      'src/lib/scope/ScopeFacade.ts -> src/lib/detach/spawn.ts',
    ]);
  });

  it('every upward TYPE-ONLY import is on the allowance list, and the list is short (none below L4 since C6)', () => {
    expect(result.typeUpward.filter((t: { allowance: unknown }) => t.allowance === null)).toEqual([]);
    expect(TYPE_ONLY_ALLOWANCES.length).toBeLessThanOrEqual(3);
    expect(TYPE_ONLY_ALLOWANCES.filter((a: { from: string }) => (rankOf(a.from) ?? 0) < 4)).toEqual([]);
  });

  it('the record is closed: every RECORD_FILES file imports only record files, by value or by type (R1, R2 = 0)', () => {
    expect(result.recordEscapes).toEqual([]);
    expect(result.recordProblems).toEqual([]);
    expect(result.recordCompile, 'the record compiled on its own loads nothing else and has no diagnostic').toEqual([]);
    expect(result.recordFiles).toBe(listSourceFiles(REPO).filter((f: string) => isRecordFile(f)).length);
    // R1 of the extraction plan: no L0–L3 file names an L4+ file, by value or by type.
    const below = (e: { from: string; to: string }) => (rankOf(e.from) ?? 9) <= 3 && (rankOf(e.to) ?? 0) >= 4;
    expect(result.typeUpward.filter(below)).toEqual([]);
    expect(result.upward.filter(below)).toEqual([]);
  });

  it('the rule bites on the real tree: leave capture/valueKinds.ts out of the record and its three importers escape', () => {
    const without = RECORD_FILES.filter((f: string) => f !== 'src/lib/capture/valueKinds.ts');
    const control = analyse({ root: REPO, config: { recordFiles: without } });
    expect(control.ok).toBe(false);
    expect(control.recordEscapes.map((e: { from: string }) => e.from).sort()).toEqual([
      'src/lib/capture/freeze.ts',
      'src/lib/memory/equality.ts',
      'src/lib/time-travel/chain.ts',
    ]);
    expect(control.recordCompile).toEqual(['compiled alone, the record loads src/lib/capture/valueKinds.ts']);
  }, 60_000); // a second whole-tree analysis, the record's compile included: ~0.6 s here, several on a CI runner

  it('the deprecated shims exist and nothing under src/ imports them', () => {
    const files = new Set(listSourceFiles(REPO));
    for (const shim of SHIMS) expect(files.has(shim), shim).toBe(true);
  });
});

// ── scenario: the ESLint zones agree with the table ──────────────────────────

describe('the ESLint zones', () => {
  const files: string[] = listSourceFiles(REPO);
  const zones = layerZones(REPO) as Array<{ target: string | string[]; from: string[] }>;
  const forbidden = (importer: string, imported: string) =>
    zones.some((z) => [z.target].flat().includes(join(REPO, importer)) && z.from.includes(join(REPO, imported)));
  const named = [...EXCEPTIONS, ...TYPE_ONLY_ALLOWANCES].map((n: { from: string; to: string }) => ({
    from: layering.globToRegExp(n.from),
    to: n.to,
  }));

  it('forbid exactly the pairs the table forbids: an upward import that is not named, or one out of the record', () => {
    const record = new Set(files.filter((f) => isRecordFile(f)));
    const wrong: string[] = [];
    for (const a of files) {
      for (const b of files) {
        const upward = rankOf(a) < rankOf(b) && rankOf(a) <= 7;
        const allowed = named.some((n: { from: RegExp; to: string }) => n.from.test(a) && n.to === b);
        const outOfRecord = record.has(a) && !record.has(b);
        if (forbidden(a, b) !== ((upward && !allowed) || outOfRecord)) wrong.push(`${a} -> ${b}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the lint is LIVE: an upward import is an error, a downward one is not (the real config, run for real)', async () => {
    const eslint = new ESLint({ cwd: REPO });
    const lint = async (code: string, file: string) =>
      (await eslint.lintText(code, { filePath: join(REPO, file) }))[0].messages.filter(
        (m) => m.ruleId === 'import/no-restricted-paths' || m.ruleId === 'import/no-cycle',
      );
    const up = await lint(
      "import { ScopeFacade } from '../scope/ScopeFacade.js';\nexport const x = ScopeFacade;\n",
      'src/lib/memory/pathOps.ts',
    );
    expect(up.map((m) => m.ruleId)).toContain('import/no-restricted-paths');
    const down = "import { isDevMode } from '../devMode.js';\nexport const y = isDevMode;\n";
    expect(await lint(down, 'src/lib/memory/redaction.ts')).toEqual([]);
    // The same downward import from a RECORD file is out of the record: the second rule, at lint time.
    const out = await lint(down, 'src/lib/memory/backtrack.ts');
    expect(out).toHaveLength(1);
    expect(out[0].message).toMatch(/A record file imports only record files: RECORD_FILES/);
    // … and so is a TYPE import out of the record (the rule counts every kind; ESLint sees `import type` too).
    const typeOut = await lint(
      "import type { StageSnapshot } from './frameTypes.js';\nexport type Y = StageSnapshot;\n",
      'src/lib/memory/backtrack.ts',
    );
    expect(typeOut.map((m) => m.message).join('\n')).toMatch(/A record file imports only record files: RECORD_FILES/);
  }, 60_000);
});
