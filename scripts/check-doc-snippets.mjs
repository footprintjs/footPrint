#!/usr/bin/env node
/**
 * check-doc-snippets — type-check the TypeScript code blocks embedded in the docs so
 * they can't silently rot.
 *
 * Why this exists: CI compiles src/ and runs vitest, but nothing ever compiles the code
 * *inside* markdown/MDX. So a ```ts block that calls a renamed/removed method (e.g.
 * `executor.attachRecorder(...)` — really `attachScopeRecorder`) passes every gate and
 * ships broken. This extracts the self-contained (import-bearing) ```ts blocks, type-checks
 * them against ./src, and turns doc drift into a red build — exactly like a broken example.
 *
 * Design notes (doc snippets are hard to type-check robustly):
 *  - Only blocks that import from 'footprintjs' are checked (the real, self-contained ones).
 *  - Blocks within one doc are concatenated so a later block that uses `executor`/`chart`
 *    declared earlier resolves; a small preamble declares `executor` with its real type.
 *  - Docs whose concatenated code does not PARSE (pseudo-code fragments: `// ...`, partial
 *    method chains) are SKIPPED and reported — a syntax error in tsc suppresses ALL semantic
 *    diagnostics, so they must be excluded rather than poison the run. (The real .ts examples
 *    are covered separately by `npm run test:examples`.)
 *  - Only API-DRIFT errors are failed on (property/member/arg/object-literal mismatch);
 *    "cannot find name" etc. are ignored (a block may reference an earlier block's variable).
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.doc-snippets-tmp');
const ROOTS = ['README.md', 'CLAUDE.md', 'AGENTS.md', 'docs', 'docs-site/src/content', 'examples', 'src/lib', 'ai-instructions'];
// Skip build output + frozen design records (proposals/design/internals describe
// proposed or historical APIs on purpose — checking them against current src is wrong).
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public', 'proposals', 'design', 'internals']);
const DRIFT_CODES = new Set(['TS2339', 'TS2551', 'TS2305', 'TS2724', 'TS2554', 'TS2555', 'TS2353', 'TS2820', 'TS2769']);
const PREAMBLE = [
  "import type { FlowChartExecutor as __FCE_T } from 'footprintjs';",
  'declare const executor: __FCE_T<any, any>;',
];

function walk(rel, acc) {
  let st;
  try { st = statSync(join(ROOT, rel)); } catch { return; }
  if (st.isFile()) { if (/\.(md|mdx)$/.test(rel)) acc.push(rel); return; }
  for (const e of readdirSync(join(ROOT, rel))) {
    if (SKIP_DIRS.has(e) || e.startsWith('.')) continue;
    walk(join(rel, e), acc);
  }
}
const docFiles = [];
for (const r of ROOTS) walk(r, docFiles);

const FENCE = /```(?:ts|typescript|tsx)\r?\n([\s\S]*?)```/g;
const docUnits = [];
for (const f of docFiles) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  const segments = [];
  let lines = [...PREAMBLE];
  let m;
  while ((m = FENCE.exec(text)) !== null) {
    const code = m[1];
    if (!/\bfrom ['"]footprintjs(\/[a-z-]+)?['"]/.test(code)) continue;
    const docStart = text.slice(0, m.index).split('\n').length + 1;
    const codeLines = code.replace(/\s+$/, '').split('\n');
    segments.push({ tmpStart: lines.length + 1, docStart, lines: codeLines.length });
    lines.push(...codeLines, '', '');
  }
  if (segments.length === 0) continue;
  docUnits.push({ file: f, tmp: `doc-${f.replace(/[^a-z0-9]/gi, '_')}.ts`, segments, source: lines.join('\n') });
}

// Parse-filter: a syntax error in any file makes tsc skip ALL semantic checks, so exclude
// fragment-heavy docs that don't parse (and report them — they aren't silently "passing").
const checkable = [];
const skipped = [];
for (const u of docUnits) {
  const sf = ts.createSourceFile(u.tmp, u.source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  if ((sf.parseDiagnostics || []).length > 0) skipped.push(u.file);
  else checkable.push(u);
}

const totalBlocks = checkable.reduce((n, u) => n + u.segments.length, 0);
if (checkable.length === 0) {
  console.log('check-doc-snippets: no checkable import-bearing doc snippets found.');
  process.exit(0);
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
for (const u of checkable) writeFileSync(join(TMP, u.tmp), u.source);
const sub = (p) => join(ROOT, p);
writeFileSync(join(TMP, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    noEmit: true, strict: false, skipLibCheck: true, noImplicitAny: false,
    target: 'esnext', module: 'esnext', moduleResolution: 'bundler',
    allowImportingTsExtensions: true, types: [], lib: ['esnext', 'dom'],
    paths: {
      footprintjs: [sub('src/index.ts')], 'footprintjs/trace': [sub('src/trace.ts')],
      'footprintjs/advanced': [sub('src/advanced.ts')], 'footprintjs/recorders': [sub('src/recorders.ts')],
      'footprintjs/zod': [sub('src/zod.ts')], 'footprintjs/detach': [sub('src/detach.ts')],
    },
  },
  include: ['*.ts'],
}, null, 2));

let out = '';
try {
  execFileSync('npx', ['tsc', '-p', join(TMP, 'tsconfig.json')], { cwd: ROOT, stdio: 'pipe' });
} catch (e) {
  out = (e.stdout?.toString() || '') + (e.stderr?.toString() || '');
}
rmSync(TMP, { recursive: true, force: true });

const byTmp = new Map(checkable.map((u) => [u.tmp, u]));
const errRe = /(doc-[^(/\\]+\.ts)\((\d+),\d+\):\s+error (TS\d+):\s+(.*)/g;
const drift = [];
let em;
while ((em = errRe.exec(out)) !== null) {
  const [, tmp, lineStr, code, msg] = em;
  if (!DRIFT_CODES.has(code)) continue;
  const u = byTmp.get(tmp);
  if (!u) continue;
  const line = +lineStr;
  let seg = null;
  for (const s of u.segments) if (line >= s.tmpStart && line < s.tmpStart + s.lines) { seg = s; break; }
  drift.push({ where: `${u.file}:${seg ? seg.docStart + (line - seg.tmpStart) : line}`, code, msg });
}

const skipNote = skipped.length ? ` (${skipped.length} fragment-heavy docs skipped — not parseable standalone)` : '';
if (drift.length === 0) {
  console.log(`check-doc-snippets: ✓ ${totalBlocks} doc snippets across ${checkable.length} files reference the API correctly${skipNote}.`);
  process.exit(0);
}
console.error(`\ncheck-doc-snippets: ✗ ${drift.length} doc snippet(s) reference an API that no longer matches src/:\n`);
for (const d of drift) console.error(`  ${d.where}  ${d.code}: ${d.msg}`);
console.error(`\nFix the snippet to match src/, or update the API.${skipNote}\n`);
process.exit(1);
