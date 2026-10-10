/** Extraction evidence must explain both historical and moved test populations. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { classify, format, percent } from '../../scripts/record-tests.mjs';
import extraction from '../../scripts/trace-extraction.json';

const made: string[] = [];
afterEach(() => made.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function tree(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'record-test-report-'));
  made.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

describe('record-test ownership report', () => {
  it('reports each retained class, its reason and the complete unresolved dependency chain', () => {
    const root = tree({
      'src/lib/memory/types.ts': 'export const record = 1;',
      'src/lib/runner/engine.ts': 'export const engine = 1;',
      'src/trace.ts': "export { record } from './lib/memory/types'; export { engine } from './lib/runner/engine';",
      'test/lib/memory/pure.test.ts': "import { record } from '../../../src/trace';",
      'test/lib/memory/stale.test.ts': "import { record } from '../../../src/trace';",
      'test/lib/memory/witness.test.ts': "import * as trace from '../../../src/trace';",
      'test/lib/memory/frame.test.ts': "import { engine } from '../../../src/lib/runner/engine';",
      'test/lib/memory/unknown.test.ts': "import '../../../src/trace';",
      'test/lib/memory/broken.test.ts': "import '../../helpers/missing';",
      'test/external.test.ts': "import { flowChart } from 'footprintjs-baseline';",
    });
    const result = classify({
      root,
      stays: [
        { group: 'witness', why: 'the engine writes the record', files: ['test/lib/memory/witness.test.ts'] },
        { group: 'frame', why: 'the frame stays in the engine', files: ['test/lib/memory/frame.test.ts'] },
        { group: 'witness', why: 'obsolete entry', files: ['test/lib/memory/stale.test.ts'] },
      ],
    });
    expect(result.counts).toMatchObject({ record: 1, witness: 1, frame: 1, unclassified: 2, stale: 1, outside: 1 });
    const text = format(result, { list: true });
    expect(text).toContain('R4: 1 of 5 (20.0%)');
    expect(text).toContain('runs without the engine (moves with the record): 1\n  test/lib/memory/pure.test.ts');
    expect(text).toContain('witness: the engine writes the record');
    expect(text).toContain('frame: the frame stays in the engine');
    expect(text).toContain('src/lib/runner/engine.ts (engine, through src/trace.ts)');
    expect(text).toContain('UNCLASSIFIED: 2');
    expect(text).toContain('via test/lib/memory/broken.test.ts:1');
    expect(text).toContain('STALE: 1\n  test/lib/memory/stale.test.ts');
    expect(text).toContain('problems: 3');
    expect(text).toMatch(/\nFAIL$/);
  });

  it('reports UNKNOWN after extraction and refuses copied or newly engine-free record suites', () => {
    const moved = extraction.movedTests[0];
    const root = tree({
      'package.json': JSON.stringify({ dependencies: { foottrace: '^1.0.0' } }),
      'src/index.ts': 'export {};',
      [moved]: "import { stateAt } from 'foottrace';",
      'test/record-only.test.ts': "import { SharedMemory } from 'foottrace/write';",
    });
    const result = classify({ root, stays: [] });
    expect(result.extracted).toBe(true);
    expect(result.r4).toMatchObject({ share: null, status: 'UNKNOWN' });
    expect(result.problems).toContain(`${moved} moved to foottrace but remains in footprintjs`);
    expect(result.problems).toContain('test/record-only.test.ts is an engine-free record test; its owner is foottrace');
    const text = format(result);
    expect(text).toContain('extracted-package mode');
    expect(text).toContain('R4: UNKNOWN');
    expect(text).toContain('not a measurement of this tree');
    expect(text).not.toContain('R4: null of null');
    expect(text).toMatch(/\nFAIL$/);
  });

  it('traverses a cyclic helper graph once and records direct record imports outside record folders', () => {
    const root = tree({
      'src/lib/memory/types.ts': 'export const record = 1;',
      'test/helpers/a.ts': "import './b'; export { record } from '../../src/lib/memory/types';",
      'test/helpers/b.ts': "import './a';",
      'test/record.test.ts': "import './helpers/a';",
    });
    const result = classify({ root, stays: [] });
    expect(result.ok).toBe(true);
    expect(result.counts).toMatchObject({ record: 1, recordElsewhere: 1 });
    expect(format(result)).toMatch(/\nOK$/);
    expect(format(result)).not.toContain('problems:');
    expect(percent(2 / 3)).toBe('66.6%');
  });
});
