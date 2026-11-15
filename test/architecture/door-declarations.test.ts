/** Release checks follow declaration identity and syntax, never names found in prose. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  importsIn,
  isRecordName,
  readDoors,
  recordInternals,
  recordSymbols,
  recordSymbolsAt,
  sourceEdges,
} from '../../scripts/doors.mjs';

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'door-declarations-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

describe('record ownership follows declarations', () => {
  it('does not let a same-spelled engine export borrow a record declaration from another door', () => {
    const doors = new Map([
      [
        'src/index.ts',
        new Map([
          ['SameName', ['src/lib/runner/ExecutionRuntime.ts']],
          ['NoDeclaration', []],
          ['Mixed', ['src/lib/memory/SharedMemory.ts', 'src/lib/runner/ExecutionRuntime.ts']],
        ]),
      ],
      ['src/advanced.ts', new Map([['SameName', ['src/lib/memory/SharedMemory.ts']]])],
    ]);
    expect(isRecordName([])).toBe(false);
    expect(recordSymbols(doors, 'src/index.ts')).toEqual(new Set());
    expect(recordSymbols(doors, 'src/advanced.ts')).toEqual(new Set(['SameName']));
    expect(recordSymbols(doors)).toEqual(new Set(['SameName']));
  });

  it('resolves re-export aliases to their original declaration, excluding public aliases from internal debt', () => {
    const root = fixture({
      'src/index.ts': "export type { Published as PublicAlias } from './lib/memory/SharedMemory.js';",
      'src/advanced.ts': "export type { Hidden as Renamed } from './lib/memory/EventLog.js';",
      'src/lib/memory/SharedMemory.ts':
        'export interface Hidden { record: true }\nexport interface Published { public: true }',
      'src/lib/memory/EventLog.ts': "export type { Hidden } from './SharedMemory.js';",
      'src/lib/memory/types.ts': 'export interface InternalOnly { privateRecord: true }',
      'src/lib/runner/engine.ts': 'export interface InternalOnly { engine: true }',
      'src/lib/runner/use.ts': [
        "import type { InternalOnly as RecordAlias } from '../memory/types.js';",
        "import type { InternalOnly as Again } from '../memory/types.js';",
        "import type { InternalOnly as EngineAlias } from './engine.js';",
        "import type { Published as AlreadyPublic } from '../memory/SharedMemory.js';",
        "import type { Missing } from './missing.js';",
        'export type Result = RecordAlias | Again | EngineAlias | AlreadyPublic | Missing;',
      ].join('\n'),
      'src/lib/runner/namespace.ts':
        "import * as Record from '../memory/types.js';\nexport type Use = Record.InternalOnly;",
    });
    const doors = readDoors(root);
    expect(doors.get('src/advanced.ts')?.get('Renamed')).toEqual(['src/lib/memory/SharedMemory.ts']);
    expect(recordInternals(root)).toEqual([
      {
        name: 'InternalOnly',
        declared: ['src/lib/memory/types.ts'],
        importers: ['src/lib/runner/namespace.ts:1', 'src/lib/runner/use.ts:1', 'src/lib/runner/use.ts:2'],
      },
    ]);
  });

  it('keeps historical record debt after extraction removes all current record exports', () => {
    const root = fixture({
      'package.json': JSON.stringify({ name: 'fixture', dependencies: { foottrace: '^1.11.1' } }),
      'src/index.ts': 'export const EngineOnly = 1;',
    });
    expect(recordSymbolsAt(root, 'src/index.ts')).toEqual(new Set(['CommitValuesMode']));
    expect(recordSymbolsAt(root, 'src/advanced.ts')).toContain('SharedMemory');
    expect(recordSymbolsAt(root, 'src/advanced.ts')).not.toContain('EngineOnly');
    expect(recordSymbolsAt(root, 'src/detach.ts')).toEqual(new Set());
    expect(recordSymbolsAt(root)).toContain('EventLog');
  });

  it('reads a pre-extraction package rather than inventing record exports from the historical inventory', () => {
    const root = fixture({
      'src/index.ts': "export { SharedMemory as OldAlias } from './lib/memory/SharedMemory.js';",
      'src/lib/memory/SharedMemory.ts': 'export class SharedMemory {}',
    });
    expect(recordSymbolsAt(root)).toEqual(new Set(['OldAlias']));
  });
});

describe('import syntax at the audit boundary', () => {
  it('retains original names, type/runtime distinctions and exact source lines across supported forms', () => {
    const source = [
      "// import { Fake } from 'comment';",
      'const prose = "require(\'quoted\')";',
      "import Default, { Original as Local } from 'named';",
      "import type { Item as Renamed } from 'types';",
      "export { Original as Public } from 'reexport';",
      "export type { Item } from 'type-reexport';",
      "export * as namespace from 'namespace';",
      "import Legacy = require('legacy');",
      "type Nested = import('nested-types').Outer.Inner;",
      "type All = import('all-types');",
      "const later = import('dynamic');",
      "const required = require('required');",
      "vi.mock('mocked');",
      "jest.importActual('actual');",
      "other.mock('not-a-test-import');",
      'require(variable);',
    ].join('\n');
    expect(importsIn(source)).toEqual([
      { spec: 'named', names: ['default', 'Original'], kind: 'static', namespace: false, line: 3 },
      { spec: 'types', names: ['Item'], kind: 'type', namespace: false, line: 4 },
      { spec: 'reexport', names: ['Original'], kind: 'static', namespace: false, line: 5 },
      { spec: 'type-reexport', names: ['Item'], kind: 'type', namespace: false, line: 6 },
      { spec: 'namespace', names: ['*'], kind: 'static', namespace: true, line: 7 },
      { spec: 'legacy', names: ['*'], kind: 'require', namespace: true, line: 8 },
      { spec: 'nested-types', names: ['Outer'], kind: 'type', namespace: false, line: 9 },
      { spec: 'all-types', names: ['*'], kind: 'type', namespace: true, line: 10 },
      { spec: 'dynamic', names: ['*'], kind: 'dynamic', namespace: true, line: 11 },
      { spec: 'required', names: ['*'], kind: 'require', namespace: true, line: 12 },
      { spec: 'mocked', names: ['*'], kind: 'mock', namespace: false, line: 13 },
      { spec: 'actual', names: ['*'], kind: 'mock', namespace: false, line: 14 },
    ]);
  });

  it('resolves .js imports and configured aliases while preserving missing or external edges as unknown', () => {
    const root = fixture({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@engine/*': ['src/lib/runner/*'] } },
      }),
      'src/lib/runner/target.ts': 'export interface Target {}',
      'src/lib/runner/use.ts': [
        "import type { Target } from './target.js';",
        "import type { Target as Alias } from '@engine/target';",
        "import type { Missing } from './missing.js';",
        "import type { External } from 'not-installed';",
      ].join('\n'),
    });
    expect(sourceEdges(root, ['src/lib/runner/use.ts', 'src/lib/runner/target.ts'])).toEqual([
      {
        from: 'src/lib/runner/use.ts',
        to: 'src/lib/runner/target.ts',
        spec: './target.js',
        names: ['Target'],
        kind: 'type',
        namespace: false,
        line: 1,
      },
      {
        from: 'src/lib/runner/use.ts',
        to: 'src/lib/runner/target.ts',
        spec: '@engine/target',
        names: ['Target'],
        kind: 'type',
        namespace: false,
        line: 2,
      },
      {
        from: 'src/lib/runner/use.ts',
        to: null,
        spec: './missing.js',
        names: ['Missing'],
        kind: 'type',
        namespace: false,
        line: 3,
      },
      {
        from: 'src/lib/runner/use.ts',
        to: null,
        spec: 'not-installed',
        names: ['External'],
        kind: 'type',
        namespace: false,
        line: 4,
      },
    ]);
  });
});
