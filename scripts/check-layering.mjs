#!/usr/bin/env node
/**
 * check-layering.mjs — the fence, as a report.
 *
 * Reads every `.ts` file under `src/`, works out which imports survive compilation (the
 * RUNTIME edges), and checks them against the layer table in `layering.config.cjs`:
 *
 *   1. value-level cycles — at the module level (`src/lib/<dir>`) and at the file level;
 *   2. upward edges       — a runtime import of a file in a HIGHER layer, minus the edges
 *                           the config names on purpose;
 *   3. unassigned files   — a src file no layer pattern matches;
 *   4. stale names        — a named edge that no longer exists, or a type-only allowance
 *                           that became a runtime import;
 *   5. shim importers     — anything under src/ that still imports a deprecated old path;
 *   6. the closed record  — an import of ANY kind (value, type, lazy) from a RECORD_FILES
 *                           file to a file outside the set (C6), and a RECORD_FILES entry
 *                           that matches no file or places a file above L3; and the record
 *                           COMPILED ALONE — a program of the record files that loads any
 *                           other file, or reports a diagnostic, fails. That is the property
 *                           itself, and it sees what no import declaration shows: an
 *                           `import('…')` type reference, a package import.
 *
 * Type-only imports are NOT layering edges: tsc erases them. They are listed (and checked
 * against the allowance list) for information, and never fail the layering — but they do
 * count for the record, which must compile on its own. An import counts as
 * runtime exactly when `ts.transpileModule` keeps it — the same elision `tsc` applies; the
 * set was checked equal to the `require()` graph of the compiled CJS output.
 *
 * A dynamic `import()` is a lazy edge: counted for layering, NOT for cycles (it cannot
 * close a load-time cycle).
 *
 * Usage:
 *   node scripts/check-layering.mjs [--root <dir>] [--json]
 *     --root  analyse <dir>/src instead of this repo's (a copy of an older tree)
 *     --json  machine-readable result
 * Exit code: 0 clean, 1 any failure.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const defaultConfig = require('./layering.config.cjs');

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── the graph ────────────────────────────────────────────────────────────────

/** `src/lib/<dir>/…` → `<dir>`; `src/lib/<file>.ts` → `<file>`; `src/<entry>.ts` → `<entry>`. */
export function moduleOf(file) {
  const parts = file.split('/');
  if (parts[1] === 'lib') return parts.length > 3 ? parts[2] : parts[2].replace(/\.ts$/, '');
  return '<entry>:' + parts[1].replace(/\.ts$/, '');
}

/**
 * Every import edge in the tree: `{ from, to, kind, line }`, files repo-relative, `kind` one
 * of `value` (survives compilation), `type` (erased), `dynamic` (a lazy `import()`).
 */
export function readEdges(root, files) {
  const known = new Set(files);
  const resolveSpec = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = join(dirname(from), spec.replace(/\.js$/, '')).split('\\').join('/');
    for (const candidate of [base + '.ts', base + '/index.ts']) if (known.has(candidate)) return candidate;
    return null;
  };
  const edges = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const kept = ts
      .createSourceFile(
        'out.js',
        ts.transpileModule(text, {
          fileName: file,
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
        ts.ScriptTarget.ES2022,
        true,
      )
      .statements.filter((s) => (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier)
      .map((s) => s.moduleSpecifier.text);
    let next = 0;
    for (const statement of source.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier)
        continue;
      const spec = statement.moduleSpecifier.text;
      // The transpile only ever REMOVES statements, in order, so the kept list lines up with the
      // source one for one. `import type` / `export type` are always erased: decide those by syntax
      // and leave the kept list alone, so a type import placed BEFORE a value import of the same
      // module (the usual order) is not credited with the value import's slot.
      const erased =
        (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly === true) ||
        (ts.isExportDeclaration(statement) && statement.isTypeOnly);
      let kind = 'type';
      if (!erased && kept[next] === spec) {
        kind = 'value';
        next++;
      }
      const to = resolveSpec(file, spec);
      if (to)
        edges.push({ from: file, to, kind, line: source.getLineAndCharacterOfPosition(statement.getStart()).line + 1 });
    }
    if (next !== kept.length) {
      throw new Error(`check-layering: could not line up the compiled imports of ${file} with its source`);
    }
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const to = resolveSpec(file, node.arguments[0].text);
        if (to)
          edges.push({
            from: file,
            to,
            kind: 'dynamic',
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return edges;
}

/** Tarjan. Returns the strongly connected components with more than one member. */
export function cycles(nodes, adjacency) {
  let counter = 0;
  const stack = [];
  const onStack = new Set();
  const index = new Map();
  const low = new Map();
  const found = [];
  const visit = (v) => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1) found.push(component.sort());
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return found;
}

const adjacencyOf = (edges, nodeOf) => {
  const adjacency = new Map();
  for (const e of edges) {
    const a = nodeOf(e.from);
    const b = nodeOf(e.to);
    if (a === b) continue;
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    adjacency.get(a).add(b);
  }
  return adjacency;
};

/**
 * The record compiled on its own: a program rooted at the record files must load no other file —
 * of the tree or of node_modules; TypeScript's own lib aside — and report no diagnostic. A package
 * cut along RECORD_FILES compiles alone exactly when this is empty. `types: []` keeps the ambient
 * `@types` packages out, as a package that declares no dependency would have them.
 */
export function recordAlone(root, recordFiles) {
  if (recordFiles.length === 0) return [];
  const config = join(root, 'tsconfig.json');
  const options = existsSync(config)
    ? ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config, ts.sys, root).options
    : { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true };
  const program = ts.createProgram(
    recordFiles.map((f) => join(root, f)),
    { ...options, noEmit: true, types: [] },
  );
  const roots = new Set(recordFiles.map((f) => resolve(root, f)));
  const where = (file) => relative(root, file).split('\\').join('/');
  const problems = program
    .getSourceFiles()
    .filter((sf) => !program.isSourceFileDefaultLibrary(sf) && !roots.has(resolve(sf.fileName)))
    .map((sf) => `compiled alone, the record loads ${where(sf.fileName)}`);
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const at = d.file ? `${where(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1} ` : '';
    problems.push(`compiled alone: ${at}${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
  return problems;
}

// ── the analysis ─────────────────────────────────────────────────────────────

/**
 * @param {{ root?: string, config?: object }} [options] `config` shape: see layering.config.cjs
 *   (`layers`, `recordFiles`, `exceptions`, `typeOnlyAllowances`, `shims`).
 */
export function analyse({ root = REPO_ROOT, config = {} } = {}) {
  const layers = config.layers ?? defaultConfig.LAYERS;
  const recordFiles = config.recordFiles ?? defaultConfig.RECORD_FILES;
  const exceptions = config.exceptions ?? defaultConfig.EXCEPTIONS;
  const typeOnlyAllowances = config.typeOnlyAllowances ?? defaultConfig.TYPE_ONLY_ALLOWANCES;
  const shims = config.shims ?? defaultConfig.SHIMS;
  const compiled = defaultConfig.compileLayers(layers);
  const match = (glob, file) => defaultConfig.globToRegExp(glob).test(file);

  const files = defaultConfig.listSourceFiles(root);
  const rank = new Map(files.map((f) => [f, defaultConfig.rankOf(f, compiled)]));
  const unassigned = files.filter((f) => rank.get(f) === null);
  const edges = readEdges(root, files);
  const runtime = edges.filter((e) => e.kind === 'value' || e.kind === 'dynamic');
  const eager = edges.filter((e) => e.kind === 'value');
  const layered = (e) => rank.get(e.from) !== null && rank.get(e.to) !== null;

  const moduleCycles = cycles([...new Set(files.map(moduleOf))], adjacencyOf(eager, moduleOf));
  const fileCycles = cycles(
    files,
    adjacencyOf(eager, (f) => f),
  );

  const named = (list, e) => list.find((n) => n.to === e.to && match(n.from, e.from));
  const upward = runtime
    .filter((e) => layered(e) && rank.get(e.to) > rank.get(e.from))
    .map((e) => ({
      ...e,
      fromRank: rank.get(e.from),
      toRank: rank.get(e.to),
      exception: named(exceptions, e) ?? null,
    }));
  const upwardUnnamed = upward.filter((e) => e.exception === null);

  const typeUpward = edges
    .filter((e) => e.kind === 'type' && layered(e) && rank.get(e.to) > rank.get(e.from))
    .map((e) => ({
      ...e,
      fromRank: rank.get(e.from),
      toRank: rank.get(e.to),
      allowance: named(typeOnlyAllowances, e) ?? null,
    }));

  const liveEdge = (n, kinds) => edges.some((e) => kinds.includes(e.kind) && e.to === n.to && match(n.from, e.from));
  const namedEdges = exceptions.map((n) => {
    const sample = runtime.find((e) => e.to === n.to && match(n.from, e.from));
    return {
      ...n,
      live: sample !== undefined,
      upwardUnderTable: sample !== undefined && layered(sample) && rank.get(sample.to) > rank.get(sample.from),
      fromRank: sample ? rank.get(sample.from) : null,
      toRank: rank.get(n.to) ?? null,
    };
  });
  const staleNames = [
    ...exceptions
      .filter((n) => !liveEdge(n, ['value', 'dynamic']))
      .map((n) => ({ ...n, why: 'no such runtime import exists any more' })),
    ...typeOnlyAllowances
      .filter((n) => !liveEdge(n, ['type']) || liveEdge(n, ['value', 'dynamic']))
      .map((n) => ({
        ...n,
        why: liveEdge(n, ['value', 'dynamic'])
          ? 'is a RUNTIME import now — the allowance covers type-only edges'
          : 'no such type-only import exists any more',
      })),
  ];
  const shimImporters = edges.filter((e) => shims.includes(e.to) && !shims.includes(e.from));

  // The second rule (C6): the record names nothing outside itself — every import kind counts.
  const inRecord = (f) => defaultConfig.isRecordFile(f, recordFiles);
  const recordEscapes = edges.filter((e) => inRecord(e.from) && !inRecord(e.to));
  const recordProblems = [
    ...recordFiles.filter((glob) => !files.some((f) => match(glob, f))).map((glob) => `${glob} matches no file`),
    ...files
      .filter((f) => inRecord(f) && rank.get(f) !== null && rank.get(f) > 3)
      .map((f) => `${f} is at L${rank.get(f)}: the record is L0-L3`),
  ];
  const recordCompile = recordAlone(root, files.filter(inRecord));

  const result = {
    files: files.length,
    edges: {
      runtime: eager.length,
      lazy: edges.filter((e) => e.kind === 'dynamic').length,
      typeOnly: edges.filter((e) => e.kind === 'type').length,
    },
    moduleCycles,
    fileCycles,
    upward,
    upwardUnnamed,
    namedEdges,
    typeUpward,
    unassigned,
    staleNames,
    shimImporters,
    recordFiles: files.filter(inRecord).length,
    recordEscapes,
    recordProblems,
    recordCompile,
  };
  result.ok =
    moduleCycles.length === 0 &&
    fileCycles.length === 0 &&
    upwardUnnamed.length === 0 &&
    unassigned.length === 0 &&
    staleNames.length === 0 &&
    shimImporters.length === 0 &&
    recordEscapes.length === 0 &&
    recordProblems.length === 0 &&
    recordCompile.length === 0;
  return result;
}

// ── the report ───────────────────────────────────────────────────────────────

const short = (f) => f.replace(/^src\/lib\//, '').replace(/^src\//, '');

export function format(result) {
  const lines = [];
  const e = result.edges;
  lines.push(
    `check-layering: ${result.files} files, ${e.runtime + e.lazy + e.typeOnly} import edges (${e.runtime} runtime, ${
      e.lazy
    } lazy, ${e.typeOnly} type-only)`,
  );
  lines.push('');
  lines.push(
    `value-level cycles   modules (src/lib/<dir>): ${result.moduleCycles.length}   files: ${result.fileCycles.length}`,
  );
  for (const c of result.moduleCycles) lines.push(`  module cycle: ${c.join(' <-> ')}`);
  for (const c of result.fileCycles) lines.push(`  file cycle: ${c.map(short).join(' <-> ')}`);
  lines.push('');
  lines.push(`upward runtime edges: ${result.upward.length}   not named: ${result.upwardUnnamed.length}`);
  for (const u of result.upward) {
    lines.push(
      `  ${short(u.from)}:${u.line} (L${u.fromRank}) -> ${short(u.to)} (L${u.toRank})${
        u.exception ? '   [named]' : '   [NOT NAMED]'
      }`,
    );
  }
  lines.push('');
  lines.push(`named edges: ${result.namedEdges.length}`);
  for (const n of result.namedEdges) {
    const where = n.live ? `L${n.fromRank} -> L${n.toRank}` : 'NOT LIVE';
    lines.push(
      `  ${short(n.from)} -> ${short(n.to)}   ${where}${
        n.live && !n.upwardUnderTable ? ' (not upward under the table)' : ''
      }`,
    );
    lines.push(`    ${n.reason}`);
  }
  lines.push('');
  const unallowed = result.typeUpward.filter((t) => t.allowance === null);
  lines.push(
    `type-only upward imports (erased by tsc, not a runtime edge): ${result.typeUpward.length}   not in the allowance list: ${unallowed.length}`,
  );
  for (const t of result.typeUpward) {
    lines.push(
      `  ${short(t.from)}:${t.line} (L${t.fromRank}) -> ${short(t.to)} (L${t.toRank})${
        t.allowance ? '' : '   [not allowed: eslint will flag it]'
      }`,
    );
  }
  lines.push('');
  lines.push(
    `unassigned files: ${result.unassigned.length}   stale named edges: ${result.staleNames.length}   importers of deprecated paths: ${result.shimImporters.length}`,
  );
  for (const f of result.unassigned)
    lines.push(`  unassigned: ${f}  (add it to LAYERS in scripts/layering.config.cjs)`);
  for (const s of result.staleNames) lines.push(`  stale: ${short(s.from)} -> ${short(s.to)}  ${s.why}`);
  for (const s of result.shimImporters)
    lines.push(`  deprecated path imported: ${short(s.from)}:${s.line} -> ${short(s.to)}`);
  lines.push('');
  lines.push(
    `the record (RECORD_FILES): ${result.recordFiles} files   imports out of it: ${
      result.recordEscapes.length
    }   compiled alone: ${result.recordCompile.length === 0 ? 'clean' : `${result.recordCompile.length} problems`}   config problems: ${
      result.recordProblems.length
    }`,
  );
  for (const e of result.recordEscapes)
    lines.push(`  ${short(e.from)}:${e.line} -> ${short(e.to)}   [${e.kind}: a record file imports only record files]`);
  for (const p of [...result.recordCompile, ...result.recordProblems]) lines.push(`  ${p}`);
  lines.push('');
  lines.push(result.ok ? 'OK' : 'FAIL');
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  const root = at === -1 ? REPO_ROOT : resolve(args[at + 1]);
  const result = analyse({ root });
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : format(result));
  process.exit(result.ok ? 0 : 1);
}
