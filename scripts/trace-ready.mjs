#!/usr/bin/env node
/** Reproduce the extraction plan's R1–R6 from this tree and named consumer Git refs.
 * Report only by default. --check-e1 enforces the local E1 gates; --check-entry checks E3 entry;
 * --require-ready also requires R3=0 (E3 completion). After extraction --check-extracted checks
 * the engine/package boundary and retained witnesses; R4 is UNKNOWN here. Co-change is information only.
 * No fetch, install, checkout or network call; absent/partial evidence is UNKNOWN, never zero.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractionProblems, isExtracted, recordAlone } from './check-layering.mjs';
import { importsIn, recordInternals, recordSymbolsAt, sourceEdges } from './doors.mjs';
import { classify, percent } from './record-tests.mjs';

const require = createRequire(import.meta.url);
const layering = require('./layering.config.cjs');
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = /\.(?:[mc]?[jt]sx?)$/;
const PLAYGROUNDS = new Set(['footprint-playground', 'agent-playground']);
const git = (dir, args) =>
  execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
const measured = (value, target, details = []) => ({ value, status: value === target ? 'PASS' : 'FAIL', details });

/** Read one immutable tree in one process. Byte lengths, not delimiters inside source text,
 * frame the response; source whitespace is preserved so reported line numbers stay exact. */
function sourcesAt(dir, sha, files) {
  const data = execFileSync('git', ['cat-file', '--batch'], {
    cwd: dir,
    input: files.map((file) => `${sha}:${file}\n`).join(''),
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
  });
  let offset = 0;
  return files.map((file) => {
    const end = data.indexOf(10, offset);
    const header = data.subarray(offset, end).toString('utf8');
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) throw new Error(`cannot read ${file}: ${header}`);
    const size = Number(match[1]);
    const start = end + 1;
    if (start + size >= data.length || data[start + size] !== 10) throw new Error(`incomplete source data for ${file}`);
    offset = start + size + 1;
    return { file, text: data.subarray(start, start + size).toString('utf8') };
  });
}

/** Consumer facts come from the same resolved commit for both the file list and file contents.
 * Legacy frame imports are potential record writers, reported separately from record symbols.
 * A remaining ExecutionRuntime import requires review; it cannot be silently counted as zero. */
export function consumerEvidence({ org, family, record, ref = 'origin/main' }) {
  return family
    .filter((entry) => entry.checks)
    .map((entry) => {
      const dir = join(org, entry.dir);
      try {
        if (!existsSync(dir)) throw new Error('consumer checkout is missing');
        const sha = git(dir, ['rev-parse', '--verify', `${ref}^{commit}`]);
        const files = git(dir, ['ls-tree', '-rz', '--name-only', sha])
          .split('\0')
          .filter((f) => SOURCE_FILE.test(f));
        if (files.length === 0) throw new Error('no tracked source files');
        const advanced = new Set();
        const opaqueAdvanced = [];
        const frameWriters = [];
        const namespaces = [];
        const exemptNamespaces = [];
        const imports = [];
        for (const { file, text } of sourcesAt(dir, sha, files)) {
          for (const row of importsIn(text, file)) {
            if (!/^footprintjs(?:\/|$)/.test(row.spec)) continue;
            const at = { file, ...row };
            imports.push(at);
            if (row.spec === 'footprintjs/advanced') {
              for (const name of row.names) if (record.has(name)) advanced.add(name);
              if (row.names.includes('*') && row.kind !== 'mock') opaqueAdvanced.push(at);
              if (row.names.some((name) => ['ExecutionRuntime', 'StageContext', 'ScopeFacade'].includes(name)))
                frameWriters.push(at);
            }
            if (file.startsWith('src/') && row.namespace && !['mock', 'type'].includes(row.kind)) {
              (PLAYGROUNDS.has(entry.package) ? exemptNamespaces : namespaces).push(at);
            }
          }
        }
        return {
          package: entry.package,
          dir,
          ref,
          sha,
          status: 'measured',
          advanced: [...advanced].sort(),
          opaqueAdvanced,
          frameWriters,
          namespaces,
          exemptNamespaces,
          imports,
        };
      } catch (error) {
        return { package: entry.package, dir, ref, status: 'unknown', reason: error.message.split('\n')[0] };
      }
    });
}

/** Whole history is required: a shallow checkout's denominator would be falsely reassuring. */
export function coChange({ root = REPO_ROOT, ref = 'origin/main', since = '3 months ago' } = {}) {
  try {
    const sha = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (git(root, ['rev-parse', '--is-shallow-repository']) === 'true')
      throw new Error('shallow history; fetch full history to measure co-change');
    const log = git(root, ['log', sha, `--since=${since}`, '--format=%x1e%H', '--name-only', '--no-renames']);
    let record = 0;
    let together = 0;
    for (const commit of log.split('\x1e').filter(Boolean)) {
      const files = commit
        .trim()
        .split('\n')
        .slice(1)
        .filter((f) => /^src\/.*\.ts$/.test(f));
      if (!files.some((f) => layering.isRecordFile(f))) continue;
      record++;
      if (files.some((f) => !layering.isRecordFile(f))) together++;
    }
    return { status: 'INFO', ref, sha, since, record, together, share: record ? together / record : null };
  } catch (error) {
    return { status: 'UNKNOWN', ref, since, reason: error.message.split('\n')[0] };
  }
}

export function consumerRows(consumers) {
  const missing = consumers.filter((c) => c.status !== 'measured');
  const measuredConsumers = consumers.filter((c) => c.status === 'measured');
  const r5Details = measuredConsumers.flatMap((c) => [
    ...c.advanced.map((name) => `${c.package}: ${name} from /advanced`),
    ...c.frameWriters.map(
      (row) =>
        `${c.package}: ${row.file}:${row.line} imports ${row.names
          .filter((name) => ['ExecutionRuntime', 'StageContext', 'ScopeFacade'].includes(name))
          .join(', ')} (legacy frame writer needs review)`,
    ),
    ...c.opaqueAdvanced.map((row) => `${c.package}: ${row.file}:${row.line} opaque /advanced access`),
  ]);
  const unknownR5 =
    missing.length > 0 || measuredConsumers.some((c) => c.opaqueAdvanced.length || c.frameWriters.length);
  const evidenceMissing = missing.map((c) => `${c.package}: ${c.reason} (${c.dir}, ${c.ref})`);
  const r5Value = measuredConsumers.reduce((n, c) => n + c.advanced.length, 0);
  const r6Details = measuredConsumers.flatMap((c) =>
    c.namespaces.map((row) => `${c.package}: ${row.file}:${row.line} ${row.kind} ${row.spec}`),
  );
  return {
    R5: {
      ...measured(r5Value, 0, [...r5Details, ...evidenceMissing]),
      status: unknownR5 || consumers.length === 0 ? 'UNKNOWN' : r5Value ? 'FAIL' : 'PASS',
    },
    R6: {
      ...measured(r6Details.length, 0, [...r6Details, ...evidenceMissing]),
      status: missing.length || consumers.length === 0 ? 'UNKNOWN' : r6Details.length ? 'FAIL' : 'PASS',
    },
  };
}

export function readiness({
  root = REPO_ROOT,
  org = dirname(root),
  consumerRef = 'origin/main',
  historyRef = 'origin/main',
  since = '3 months ago',
  stays,
  family,
} = {}) {
  const extracted = isExtracted(root);
  const files = layering.listSourceFiles(root);
  const edges = sourceEdges(root, files);
  const upward = edges.filter(
    (e) => e.to && layering.rankOf(e.from) <= 3 && layering.rankOf(e.from) !== null && layering.rankOf(e.to) >= 4,
  );
  const escapes = edges.filter((e) => layering.isRecordFile(e.from) && (!e.to || !layering.isRecordFile(e.to)));
  const recordFiles = files.filter((f) => layering.isRecordFile(f));
  const recordProblems = extracted
    ? extractionProblems(root, files)
    : [
        ...layering.RECORD_FILES.filter((pattern) => !files.some((f) => layering.globToRegExp(pattern).test(f))).map(
          (f) => `missing record file: ${f}`,
        ),
        ...recordFiles
          .filter((f) => layering.rankOf(f) === null || layering.rankOf(f) > 3)
          .map((f) => `record file above L3 or unranked: ${f}`),
        ...recordAlone(root, recordFiles),
      ];
  const internals = recordInternals(root);
  const tests = classify({ root, ...(stays ? { stays } : {}) });
  const consumers = consumerEvidence({
    org,
    ref: consumerRef,
    family: family ?? JSON.parse(readFileSync(join(root, 'scripts/family.json'), 'utf8')).family,
    record: recordSymbolsAt(root, 'src/advanced.ts'),
  });
  const edgeText = (e) => `${e.from}:${e.line} → ${e.to ?? e.spec} (${e.kind})`;
  const r1 = measured(new Set(upward.map((e) => e.from)).size, 0, upward.map(edgeText));
  const unassigned = files.filter((file) => layering.rankOf(file) === null);
  if (!files.length || unassigned.length) {
    r1.status = 'UNKNOWN';
    r1.details.push(...unassigned.map((f) => `unranked file: ${f}`));
    if (!files.length) r1.details.push('no source files');
  }
  const r2 = measured(escapes.length, 0, [...escapes.map(edgeText), ...recordProblems]);
  if (recordProblems.length || (!extracted && !recordFiles.length)) r2.status = 'FAIL';
  if (extracted)
    r2.details.push('Record ownership moved to foottrace; checked the engine imports only its public named doors.');
  return {
    extracted,
    root,
    org,
    consumerRef,
    historyRef,
    rows: {
      R1: r1,
      R2: r2,
      R3: measured(
        extracted ? recordProblems.length : internals.length,
        0,
        extracted
          ? recordProblems
          : internals.map((i) => `${i.name}: ${i.declared.join(', ')} ← ${i.importers.join(', ')}`),
      ),
      R4: {
        value: tests.r4.share,
        status: extracted ? 'UNKNOWN' : tests.ok && tests.r4.share >= 0.7 ? 'PASS' : 'FAIL',
        details: [...tests.problems, ...(extracted ? [tests.r4.reason] : [])],
        engineFree: tests.r4.engineFree,
        of: tests.r4.of,
      },
      ...consumerRows(consumers),
    },
    internals,
    tests,
    consumers,
    coChange: coChange({ root, ref: historyRef, since }),
  };
}

export function passes(report, mode = 'report') {
  const gates = {
    report: [],
    e1: ['R1', 'R2', 'R4'],
    entry: ['R1', 'R2', 'R4', 'R5', 'R6'],
    ready: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'],
    extracted: ['R1', 'R2', 'R3'],
  };
  if (!(mode in gates)) throw new Error(`unknown readiness mode: ${mode}`);
  return (
    (mode !== 'extracted' || (report.extracted && report.tests.ok)) &&
    gates[mode].every((key) => report.rows[key].status === 'PASS')
  );
}

export function format(report) {
  const labels = {
    R1: 'L0–L3 files importing L4+',
    R2: 'Record imports outside the record',
    R3: 'Unpublished record internals (E3 work)',
    R4: 'Engine-free record test files',
    R5: 'Consumer record symbols on /advanced; frame writers reviewed',
    R6: 'Consumer namespace sites (playgrounds exempt)',
  };
  const lines = [
    '# Trace extraction readiness',
    '',
    `Source: ${report.root}`,
    '',
    '| Measure | Observed | Target | Status |',
    '|---|---|---|---|',
  ];
  for (const [key, row] of Object.entries(report.rows)) {
    const value =
      key === 'R4'
        ? row.value === null
          ? 'unknown; tests moved to foottrace'
          : `${row.engineFree}/${row.of} (${percent(row.value)})`
        : `${row.value}${row.status === 'UNKNOWN' ? ' known; incomplete evidence' : ''}`;
    lines.push(
      `| ${key}: ${labels[key]} | ${value} | ${key === 'R4' ? '≥70%, all files classified' : '0'} | ${row.status} |`,
    );
  }
  const co = report.coChange;
  lines.push(
    `| Co-change (information only) | ${
      co.status === 'INFO'
        ? `${co.together}/${co.record}${co.share === null ? ' (no record commits)' : ` (${percent(co.share)})`}`
        : 'unknown'
    } | No gate | ${co.status} |`,
  );
  lines.push(
    '',
    report.extracted
      ? 'Extraction checks R1/R2/R3 and retained-test classification. R4 moved to foottrace and is not measured here. Consumer migration evidence remains separate; co-change never blocks.'
      : 'E1 gates R1/R2/R4; E3 entry additionally requires R5/R6. R3 must be resolved during E3. Co-change never blocks.',
    '',
    '## Evidence',
    '',
  );
  for (const c of report.consumers)
    lines.push(
      `- ${c.package}: ${c.dir} · ${c.ref}${c.sha ? ` @ ${c.sha}` : ` · UNKNOWN: ${c.reason}`}${
        c.exemptNamespaces?.length ? ` · ${c.exemptNamespaces.length} exempt playground namespace site(s)` : ''
      }`,
    );
  lines.push(
    `- Co-change: ${co.ref}${co.sha ? ` @ ${co.sha}` : ''}, since ${co.since}${co.reason ? ` · ${co.reason}` : ''}`,
  );
  for (const [key, row] of Object.entries(report.rows))
    if (row.details.length) {
      lines.push('', `## ${key} details`, '', ...row.details.map((detail) => `- ${detail}`));
    }
  return lines.join('\n');
}

export function parseArgs(args) {
  const options = { mode: 'report', json: false };
  const values = {
    '--root': 'root',
    '--org': 'org',
    '--consumer-ref': 'consumerRef',
    '--history-ref': 'historyRef',
    '--since': 'since',
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (values[flag]) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      options[values[flag]] = flag === '--root' || flag === '--org' ? resolve(value) : value;
    } else if (flag === '--json') options.json = true;
    else if (['--check-e1', '--check-entry', '--require-ready', '--check-extracted'].includes(flag)) {
      if (options.mode !== 'report') throw new Error('choose only one readiness gate');
      options.mode = {
        '--check-e1': 'e1',
        '--check-entry': 'entry',
        '--require-ready': 'ready',
        '--check-extracted': 'extracted',
      }[flag];
    } else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const report = readiness(options);
  const markdown = format(report);
  console.log(options.json ? JSON.stringify(report, null, 2) : markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  process.exitCode = passes(report, options.mode) ? 0 : 1;
}
