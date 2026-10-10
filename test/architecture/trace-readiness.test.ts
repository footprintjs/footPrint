/** E1's measurements have failing controls: absent evidence must never look ready. */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { advancedImports } from '../../scripts/audit-consumers.mjs';
import {
  importsIn,
  readDoors,
  recordInternals,
  recordSymbols,
  recordSymbolsAt,
  sourceEdges,
} from '../../scripts/doors.mjs';
import { classify } from '../../scripts/record-tests.mjs';
import {
  coChange,
  consumerEvidence,
  consumerRows,
  format,
  parseArgs,
  passes,
  readiness,
} from '../../scripts/trace-ready.mjs';

const made: string[] = [];
const repo = resolve(__dirname, '../..');
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function write(root: string, file: string, text: string) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
}

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'trace-ready-'));
  made.push(root);
  for (const [file, text] of Object.entries(files)) write(root, file, text);
  return root;
}

const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commit(root: string) {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Readiness test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
}

describe('the declaration-based record map', () => {
  it('after extraction consumer checks still recognise the former record names on /advanced', () => {
    expect([...recordSymbols(readDoors(repo), 'src/advanced.ts')]).toEqual([]);
    const historical = recordSymbolsAt(repo, 'src/advanced.ts');
    expect(historical.has('CommitBundle')).toBe(true);
    expect(historical.has('SharedMemory')).toBe(true);
    expect(historical.has('StageContext')).toBe(false);
  });
  it('follows aliases and export stars, and does not mistake engine names for record symbols', () => {
    const root = tree({
      'src/lib/memory/types.ts': 'export interface CommitBundle {}',
      'src/lib/memory/StageContext.ts': 'export class StageContext {}',
      'src/trace.ts': "export { CommitBundle as Recording } from './lib/memory/types';",
      'src/advanced.ts': "export * from './trace'; export * from './lib/memory/StageContext';",
    });
    const doors = readDoors(root);
    expect(doors.get('src/advanced.ts').get('Recording')).toEqual(['src/lib/memory/types.ts']);
    expect([...recordSymbols(doors)]).toEqual(['Recording']);
  });

  it('R3 recognises a published alias by declaration and distinguishes same-spelled private symbols', () => {
    const root = tree({
      'src/lib/memory/paths.ts': 'export const pathSegments = 1;',
      'src/lib/ids/runtimeStageId.ts': 'export const pathSegments = 2;',
      'src/trace.ts': "export { pathSegments as publicPaths } from './lib/memory/paths';",
      'src/lib/runner/use.ts': "import { pathSegments } from '../ids/runtimeStageId'; export const use = pathSegments;",
      'src/lib/runner/public.ts': "import { pathSegments } from '../memory/paths'; export const use = pathSegments;",
    });
    expect(recordInternals(root)).toEqual([
      { name: 'pathSegments', declared: ['src/lib/ids/runtimeStageId.ts'], importers: ['src/lib/runner/use.ts:1'] },
    ]);
  });

  it('R3 includes dynamic, require, import-equals and barrel re-export dependencies', () => {
    const root = tree({
      'src/lib/memory/recordCommit.ts': 'export const recordCommit = 1;',
      'src/lib/runner/dynamic.ts': "const loaded = import('../memory/recordCommit');",
      'src/lib/runner/require.ts': "const loaded = require('../memory/recordCommit');",
      'src/lib/runner/equals.ts': "import loaded = require('../memory/recordCommit');",
      'src/lib/runner/reexport.ts': "export { recordCommit as used } from '../memory/recordCommit';",
    });
    expect(recordInternals(root)).toEqual([
      {
        name: 'recordCommit',
        declared: ['src/lib/memory/recordCommit.ts'],
        importers: [
          'src/lib/runner/dynamic.ts:1',
          'src/lib/runner/equals.ts:1',
          'src/lib/runner/reexport.ts:1',
          'src/lib/runner/require.ts:1',
        ],
      },
    ]);
  });

  it('parses aliases, re-exports, namespaces, dynamic imports, require, import types and mocks, ignoring prose', () => {
    const rows = importsIn(`
      // import { Fake } from 'footprintjs/advanced';
      const prose = "import { Fake } from 'footprintjs/advanced'";
      import { type CommitBundle as Bundle, SharedMemory } from 'footprintjs/advanced';
      export { CommitValuesMode as Encoding } from 'footprintjs';
      import * as trace from 'footprintjs/trace';
      const later = import('footprintjs/write');
      const old = require('footprintjs/advanced');
      type Record = import('footprintjs/trace').CommitBundle;
      vi.mock('footprintjs/trace', () => ({}));
    `);
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.names)).toEqual([
      ['CommitBundle', 'SharedMemory'],
      ['CommitValuesMode'],
      ['*'],
      ['*'],
      ['*'],
      ['CommitBundle'],
      ['*'],
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['static', 'static', 'static', 'dynamic', 'require', 'type', 'mock']);
  });
});

describe('record-test classification', () => {
  const record = {
    'src/lib/memory/types.ts': 'export const record = 1;',
    'src/trace.ts': "export { record } from './lib/memory/types';",
  };

  it('follows helpers and record doors while refusing engine barrels, type references and require escapes', () => {
    const root = tree({
      ...record,
      'src/lib/runner/engine.ts': 'export const engine = 1;',
      'src/index.ts': "export { record } from './lib/memory/types';",
      'test/helpers/pure.ts': "export { record } from '../../src/trace';",
      'test/helpers/engine.ts': "export const x = require('../../src/lib/runner/engine');",
      'test/lib/memory/pure.test.ts': "import { record } from '../../helpers/pure'; void record;",
      'test/lib/memory/helper.test.ts': "import { x } from '../../helpers/engine'; void x;",
      'test/lib/memory/type.test.ts': "type Engine = import('../../../src/lib/runner/engine').engine;",
      'test/lib/memory/barrel.test.ts': "import { record } from '../../../src'; void record;",
      'test/lib/memory/missing.test.ts': "import { missing } from '../../../src/trace'; void missing;",
    });
    const result = classify({ root, stays: [] });
    expect(result.counts.record).toBe(1);
    expect(result.counts.unclassified).toBe(4);
    expect(result.files.find((file) => file.file.endsWith('helper.test.ts')).escapes[0].chain).toHaveLength(2);
    expect(result.r4).toEqual({ engineFree: 1, of: 5, share: 0.2 });
  });

  it('refuses stale, duplicate, missing and unreasoned STAYS entries', () => {
    const root = tree({
      ...record,
      'test/lib/memory/pure.test.ts': "import { record } from '../../../src/trace'; void record;",
    });
    const result = classify({
      root,
      stays: [
        { group: 'witness', why: '', files: ['test/lib/memory/pure.test.ts'] },
        { group: 'witness', why: 'duplicate', files: ['test/lib/memory/pure.test.ts', 'test/missing.test.ts'] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/valid class and a reason/);
    expect(result.problems.join('\n')).toMatch(/named twice/);
    expect(result.problems.join('\n')).toMatch(/no test file/);
    expect(result.problems.join('\n')).toMatch(/runs without the engine/);
  });

  it('the extracted tree retains classified witnesses without pretending to measure the moved R4 population', () => {
    const result = classify({ root: repo });
    expect(result.problems).toEqual([]);
    expect(result.extracted).toBe(true);
    expect(result.r4).toMatchObject({ share: null, engineFree: null, of: null, status: 'UNKNOWN' });
    expect(result.counts.witness).toBeGreaterThan(0);
  });
});

describe('readiness evidence and gates', () => {
  it('R1 and R2 see import-type references and package imports, not just import declarations', () => {
    const root = tree({
      'src/lib/memory/types.ts':
        "export type Up = import('./StageContext').StageContext; export type Ext = import('missing-package').Type;",
      'src/lib/memory/StageContext.ts': 'export class StageContext {}',
      'test/placeholder.test.ts': '// no source imported',
    });
    const edges = sourceEdges(root, ['src/lib/memory/types.ts', 'src/lib/memory/StageContext.ts']);
    expect(edges.map((e) => e.kind)).toEqual(['type', 'type']);
    const report = readiness({ root, family: [], stays: [] });
    expect(report.rows.R1).toMatchObject({ status: 'FAIL', value: 1 });
    expect(report.rows.R2).toMatchObject({ status: 'FAIL', value: 2 });
  });

  it('reads a resolved consumer ref, reports all source import kinds, and exempts only playground namespaces', () => {
    const org = tree({
      'consumer/src/use.ts':
        "import { CommitBundle as Bundle } from 'footprintjs/advanced'; import * as trace from 'footprintjs/trace';",
      'consumer/test/use.test.ts': "vi.mock('footprintjs/trace'); const x = import('footprintjs/advanced');",
      'consumer/src/frames.ts':
        "import { ExecutionRuntime, StageContext } from 'footprintjs/advanced'; type Mock = typeof import('footprintjs/trace');",
    });
    const dir = join(org, 'consumer');
    git(dir, 'init', '-q');
    const sha = commit(dir);
    write(dir, 'src/use.ts', '// working tree intentionally differs');
    const entry = { package: 'consumer', dir: 'consumer', checks: ['npm test'] };
    const evidence = consumerEvidence({ org, family: [entry], ref: sha, record: new Set(['CommitBundle']) });
    expect(evidence[0]).toMatchObject({ status: 'measured', sha, advanced: ['CommitBundle'] });
    expect(evidence[0].namespaces).toHaveLength(1);
    expect(evidence[0].frameWriters).toHaveLength(1);
    expect(evidence[0].opaqueAdvanced).toHaveLength(1);
    expect(consumerRows(evidence).R5.status).toBe('UNKNOWN');
    expect(consumerRows(evidence).R6.status).toBe('FAIL');
    const playground = consumerEvidence({
      org,
      family: [{ ...entry, package: 'footprint-playground' }],
      ref: sha,
      record: new Set(),
    });
    expect(consumerRows(playground).R6.status).toBe('PASS');
    expect(playground[0].exemptNamespaces).toHaveLength(1);
    const audit = advancedImports(dir, new Set(['CommitBundle']));
    expect(audit.record).toEqual([]); // audit scans its checked-out candidate, unlike the ref report
    expect(audit.other).toContain('ExecutionRuntime');
    expect(audit.unresolved).toBe(true);
  });

  it('missing consumer repositories and refs cannot become zero evidence', () => {
    const org = tree({});
    const consumers = consumerEvidence({
      org,
      family: [{ package: 'missing', dir: 'missing', checks: [] }],
      record: new Set(),
    });
    expect(consumers[0].status).toBe('unknown');
    expect(consumerRows(consumers).R5.status).toBe('UNKNOWN');
    expect(consumerRows(consumers).R6.status).toBe('UNKNOWN');
    expect(consumerRows([]).R5.status).toBe('UNKNOWN');
  });

  it('co-change uses record-touching commits as denominator and remains informational even at 100%', () => {
    const root = tree({
      'src/lib/memory/types.ts': 'export type A = 1;',
      'src/lib/runner/use.ts': 'export const use = 1;',
    });
    git(root, 'init', '-q');
    const sha = commit(root);
    expect(coChange({ root, ref: sha, since: '2000-01-01' })).toMatchObject({
      status: 'INFO',
      record: 1,
      together: 1,
      share: 1,
    });
    expect(coChange({ root, ref: 'missing' }).status).toBe('UNKNOWN');
    write(root, '.git/shallow', `${sha}\n`);
    expect(coChange({ root, ref: sha }).status).toBe('UNKNOWN');
  });

  it('E1 does not require E3 completion, entry requires consumer evidence, and co-change never gates', () => {
    const rows = Object.fromEntries(['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].map((key) => [key, { status: 'PASS' }]));
    rows.R3.status = 'FAIL';
    const report = { rows, coChange: { status: 'UNKNOWN' } };
    expect(passes(report, 'e1')).toBe(true);
    expect(passes(report, 'entry')).toBe(true);
    expect(passes(report, 'ready')).toBe(false);
    rows.R5.status = 'UNKNOWN';
    expect(passes(report, 'entry')).toBe(false);
    expect(passes(report, 'report')).toBe(true);
    rows.R4.status = 'FAIL';
    expect(passes(report, 'e1')).toBe(false);
  });

  // This integration check compiles the record layer, unlike the small parser fixtures above.
  it('the extracted report checks public imports and flags the moved population and unavailable consumers honestly', () => {
    const report = readiness({ root: repo, org: tree({}) });
    expect(report.rows.R1.status).toBe('PASS');
    expect(report.rows.R2.status).toBe('PASS');
    expect(report.rows.R3.value).toBe(0);
    expect(report.rows.R4.status).toBe('UNKNOWN');
    expect(report.rows.R5.status).toBe('UNKNOWN');
    expect(format(report)).toContain('incomplete evidence');
    expect(passes(report, 'e1')).toBe(false);
    expect(passes(report, 'extracted')).toBe(true);
  }, 30_000);

  it('refuses malformed flags instead of silently running another mode', () => {
    expect(() => parseArgs(['--root'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--unknown'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--check-e1', '--require-ready'])).toThrow(/only one/);
    expect(parseArgs(['--check-entry', '--consumer-ref', 'origin/main']).mode).toBe('entry');
  });
});
