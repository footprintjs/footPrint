#!/usr/bin/env node
/**
 * record-tests.mjs — which tests are the record's, and which of them run without the engine.
 *
 * The extraction plan (docs/design/2026-10-trace-extraction.md, E1 and section 8, row R4) moves the
 * record to its own package with the tests that need nothing else. This script reads that off what
 * each test file LOADS — never off its name or its folder:
 *
 *   - the edges are `check-layering.mjs · readEdges` over src/ and test/ together, every import kind
 *     (value, type, lazy): a test that moves must still compile where it lands;
 *   - the record is `layering.config.cjs · RECORD_FILES`;
 *   - an import from a door (`src/*.ts`) counts as the files its NAMES are declared in
 *     (`doors.mjs · readDoors`), so `{ stateAt } from '…/src/trace'` loads the record and
 *     `{ flowChart } from '…/src'` loads the builder;
 *   - a test helper (a `.ts` under test/ that is not a test) is followed: what it loads, the test loads.
 *
 * A test RUNS WITHOUT THE ENGINE when everything it loads, at any depth, is a record file, a test
 * helper, or a package other than footprintjs (vitest, fast-check, node:*). It is THE RECORD'S when it
 * runs without the engine and loads a record file — or sits in one of the record's test folders
 * (RECORD_TEST_DIRS). The rest of the record's tests are named in STAYS, each group with its reason:
 *
 *   witness  the record's tests that need the engine: their point is what the engine writes. They stay
 *            in footprintjs and run against the trace package from E3 on.
 *   frame    tests in the record's folders whose subject stays in footprintjs (the frame, the run
 *            policy, the redaction verdict, diagnostics, the retention dials): not the record's.
 *
 * R4 = the record's tests that run without the engine ÷ all the record's tests (witnesses included).
 *
 * The run FAILS on a test in RECORD_TEST_DIRS that loads the engine and is not named (name it, or
 * make it engine-free), on a named test that runs without the engine (it is no witness: drop the
 * name and let it move), and on a name that matches no test file.
 *
 * Usage:
 *   node scripts/record-tests.mjs [--root <dir>] [--json] [--list]
 *     --root  classify <dir>'s tests (a copy of an older tree); the named list is this one's
 *     --json  machine-readable result
 *     --list  print every test file under its class, not only the counts and the problems
 * Exit code: 0 clean, 1 any failure.
 */

import { createRequire } from 'node:module';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readEdges } from './check-layering.mjs';
import { readDoors } from './doors.mjs';

const require = createRequire(import.meta.url);
const layering = require('./layering.config.cjs');

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The record's test folders: the plan's population for R4 (its appendix). Every test file here is
 * accounted for — it runs without the engine, or STAYS names it. Elsewhere, a test is the record's
 * when it runs without the engine and loads a record file (`capture/freeze`, `ids/runtimeStageId` …).
 */
export const RECORD_TEST_DIRS = ['test/lib/memory/', 'test/lib/slice/', 'test/lib/time-travel/'];

/** footprintjs itself under any name (`footprintjs`, `footprintjs-baseline/advanced` …): the engine. */
const FOOTPRINTJS = /^footprintjs(-[\w-]+)?(\/|$)/;

/** A test file, as vitest finds it (vitest.config.ts · include). */
const isTest = (file) => /^test\/.*\.test\.ts$/.test(file);

/**
 * The tests that stay in footprintjs, by group. A name here is a decision with its reason; the run
 * fails on a name that runs without the engine (it should move) or matches no file.
 * @type {ReadonlyArray<{ group: 'witness' | 'frame', why: string, files: string[] }>}
 */
export const STAYS = [
  // ── engine witnesses: the record's tests whose point is what the engine writes ──
  {
    group: 'witness',
    why: 'walking equals replaying: the cursor over a run equals the engine’s own state at every stop',
    files: ['test/lib/time-travel/conformance.test.ts'],
  },
  {
    group: 'witness',
    why: 'pause and resume legs: two executors’ runs read as one axis',
    files: ['test/lib/time-travel/chain.test.ts'],
  },
  {
    group: 'witness',
    why: 'the copy-on-write differentials and pins (memory/property/copy-on-write-fixture.ts): this engine against footprintjs-baseline 9.28.0',
    files: [
      'test/lib/memory/property/copy-on-write-differential.property.test.ts',
      'test/lib/memory/property/copy-on-write-pause-differential.property.test.ts',
      'test/lib/memory/property/keyed-fold-differential.property.test.ts',
      'test/lib/memory/property/record-reachability.property.test.ts',
      'test/lib/memory/property/value-basis.property.test.ts',
      'test/lib/memory/scenario/copy-on-write-byte-identity.test.ts',
      'test/lib/memory/scenario/copy-on-write-commit.test.ts',
      'test/lib/memory/scenario/copy-on-write-witness.test.ts',
      'test/lib/memory/unit/copy-on-write.test.ts',
    ],
  },
  {
    group: 'witness',
    why: 'the record-bytes fixtures: 26 flowchart runs, the whole served record pinned byte for byte',
    files: ['test/fixtures/record-bytes/record-bytes.test.ts'],
  },
  {
    group: 'witness',
    why: 'causal walks over real pipelines (decider, selector, subflow, loop), and the engine’s dev mode',
    files: ['test/lib/memory/backtrack-integration.test.ts'],
  },
  // ── not the record's: tests in its folders whose subject stays in footprintjs ──
  {
    group: 'frame',
    why: 'the engine’s frame (StageContext) and its diagnostics',
    files: ['test/lib/memory/unit/StageContext.test.ts', 'test/lib/memory/unit/DiagnosticCollector.test.ts'],
  },
  {
    group: 'frame',
    why: 'the run policy (memory/runPolicy.ts)',
    files: ['test/lib/memory/runPolicy.test.ts'],
  },
  {
    group: 'frame',
    why: 'the redaction verdict (memory/redaction.ts): the rule, the write decision, mapper taint, served errors',
    files: [
      'test/lib/memory/unit/decideWrite.test.ts',
      'test/lib/memory/unit/diagnostic-redaction-rule.test.ts',
      'test/lib/memory/unit/emit-redaction-rule.test.ts',
      'test/lib/memory/unit/mapper-taint.test.ts',
      'test/lib/memory/unit/redaction-path-exact.test.ts',
      'test/lib/memory/unit/redaction-rule.test.ts',
      'test/lib/memory/unit/served-errors-cycle.test.ts',
      'test/lib/memory/security/needs-path-linear.security.test.ts',
    ],
  },
  {
    group: 'frame',
    why: 'the retention dials (readTracking, writeTracking): what the frame keeps of each read and write',
    files: ['test/lib/memory/scenario/read-tracking.test.ts', 'test/lib/memory/scenario/write-tracking.test.ts'],
  },
];

// ── the closure ──────────────────────────────────────────────────────────────

/**
 * What one test loads that is not the record's: `{ chain, what }` per escape, the chain naming each
 * file:line on the way from the test. `loadsRecord` is true when it reached a record file.
 */
function loadsOf(test, ctx) {
  const escapes = [];
  let loadsRecord = false;
  const seen = new Set([test]);
  const queue = [{ file: test, chain: [] }];
  const follow = (to, chain) => {
    if (seen.has(to)) return;
    seen.add(to);
    queue.push({ file: to, chain });
  };
  while (queue.length > 0) {
    const { file, chain } = queue.shift();
    for (const edge of ctx.edgesFrom.get(file) ?? []) {
      const at = [...chain, `${file}:${edge.line}`];
      if (edge.to === null) {
        if (FOOTPRINTJS.test(edge.spec)) escapes.push({ chain: at, what: `the package '${edge.spec}'` });
        else if (edge.spec.startsWith('.')) {
          escapes.push({
            chain: at,
            what: `'${edge.spec}' (${normalize(join(dirname(file), edge.spec))}), not a .ts file the reader can follow`,
          });
        }
        continue;
      }
      const door = ctx.doors.get(edge.to);
      if (door) {
        const names = edge.names.includes('*') ? [...door.keys()] : edge.names;
        for (const name of names) {
          const declared = door.get(name);
          if (!declared) {
            escapes.push({ chain: at, what: `'${name}', which ${edge.to} does not hand out` });
            continue;
          }
          for (const decl of declared) {
            if (layering.isRecordFile(decl)) {
              loadsRecord = true;
              follow(decl, at);
            } else escapes.push({ chain: at, what: `${decl} (${name}, through ${edge.to})` });
          }
        }
      } else if (layering.isRecordFile(edge.to)) {
        loadsRecord = true;
        follow(edge.to, at);
      } else if (edge.to.startsWith('test/')) follow(edge.to, at);
      else escapes.push({ chain: at, what: edge.to });
    }
  }
  return { escapes, loadsRecord };
}

// ── the classification ───────────────────────────────────────────────────────

/**
 * @param {{ root?: string, stays?: typeof STAYS, recordDirs?: string[] }} [options]
 */
export function classify({ root = REPO_ROOT, stays = STAYS, recordDirs = RECORD_TEST_DIRS } = {}) {
  const src = layering.listSourceFiles(root);
  const tests = layering.listSourceFiles(root, 'test');
  const edgesFrom = new Map();
  for (const edge of readEdges(root, [...src, ...tests], { outside: true })) {
    if (!edgesFrom.has(edge.from)) edgesFrom.set(edge.from, []);
    edgesFrom.get(edge.from).push(edge);
  }
  const ctx = { edgesFrom, doors: readDoors(root) };

  const named = new Map();
  const problems = [];
  for (const group of stays) {
    for (const file of group.files) {
      if (named.has(file)) problems.push(`${file} is named twice in STAYS`);
      named.set(file, group);
    }
  }
  const testFiles = tests.filter(isTest);
  for (const file of named.keys()) if (!testFiles.includes(file)) problems.push(`${file} is named in STAYS but is no test file`);

  const files = testFiles.map((file) => {
    const inRecordDir = recordDirs.some((dir) => file.startsWith(dir));
    const { escapes, loadsRecord } = loadsOf(file, ctx);
    const group = named.get(file);
    let kind;
    if (group && escapes.length === 0) {
      kind = 'stale';
      problems.push(`${file} is named (${group.group}) but runs without the engine: drop the name, it moves`);
    } else if (group) kind = group.group;
    else if (escapes.length === 0 && (inRecordDir || loadsRecord)) kind = 'record';
    else if (inRecordDir) {
      kind = 'unclassified';
      problems.push(`${file} loads ${escapes[0].what}: make it engine-free, or name it in STAYS (scripts/record-tests.mjs)`);
    } else kind = 'outside';
    return { file, kind, inRecordDir, escapes, why: group?.why ?? null };
  });

  const count = (kind) => files.filter((f) => f.kind === kind).length;
  const record = count('record');
  const ofRecord = record + count('witness') + count('unclassified') + count('stale');
  return {
    tests: files.length,
    files,
    r4: { engineFree: record, of: ofRecord, share: ofRecord === 0 ? 0 : record / ofRecord },
    counts: {
      record,
      recordElsewhere: files.filter((f) => f.kind === 'record' && !f.inRecordDir).length,
      witness: count('witness'),
      frame: count('frame'),
      unclassified: count('unclassified'),
      stale: count('stale'),
      outside: count('outside'),
    },
    problems,
    ok: problems.length === 0,
  };
}

// ── the report ───────────────────────────────────────────────────────────────

export const percent = (share) => `${(Math.floor(share * 1000) / 10).toFixed(1)}%`;

export function format(result, { list = false } = {}) {
  const { counts: c, r4 } = result;
  const lines = [
    `record-tests: ${result.tests} test files; the record's: ${r4.of} (${r4.engineFree} run without the engine, ` +
      `${c.recordElsewhere} of them outside its folders; ${c.witness} engine witnesses)`,
    `  not the record's: ${c.frame} named in its folders (their subject stays in footprintjs), ${c.outside} elsewhere`,
    `R4: ${r4.engineFree} of ${r4.of} (${percent(r4.share)}) of the record's test files run without the engine`,
  ];
  const section = (title, kind, detail) => {
    const rows = result.files.filter((f) => f.kind === kind);
    if (rows.length === 0) return;
    lines.push('', `${title}: ${rows.length}`);
    for (const f of rows) lines.push(`  ${f.file}${detail ? detail(f) : ''}`);
  };
  if (list) {
    section('runs without the engine (moves with the record)', 'record');
    const groups = new Map();
    for (const f of result.files.filter((x) => x.kind === 'witness' || x.kind === 'frame')) {
      const key = `${f.kind}: ${f.why}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    for (const [key, rows] of groups) {
      lines.push('', `${key}`);
      for (const f of rows) lines.push(`  ${f.file}   (loads ${f.escapes[0].what})`);
    }
  }
  section('UNCLASSIFIED', 'unclassified', (f) => `   loads ${f.escapes[0].what} via ${f.escapes[0].chain.join(' > ')}`);
  section('STALE', 'stale');
  if (result.problems.length > 0) {
    lines.push('', `problems: ${result.problems.length}`);
    for (const p of result.problems) lines.push(`  ${p}`);
  }
  lines.push('', result.ok ? 'OK' : 'FAIL');
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--root');
  const root = at === -1 ? REPO_ROOT : resolve(args[at + 1]);
  const result = classify({ root });
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : format(result, { list: args.includes('--list') }));
  // Not process.exit(): a long --json report written to a pipe would be cut off before it drains.
  process.exitCode = result.ok ? 0 : 1;
}
