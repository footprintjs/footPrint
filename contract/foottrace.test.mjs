import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { behaviors } from './foottrace.behaviors.mjs';
import { foottraceImports } from './foottrace.imports.mjs';

const required = foottraceImports();
const covered = behaviors
  .flatMap(({ covers }) => Object.entries(covers).flatMap(([door, names]) => names.map((name) => `${door}:${name}`)))
  .sort();

test('behavior contracts cover exactly the runtime exports imported by production source', () => {
  assert.deepEqual(
    covered,
    required
      .filter(({ kind }) => kind === 'value')
      .map(({ door, name }) => `${door}:${name}`)
      .sort(),
  );
});

test('the import inventory preserves aliases and type imports, ignores comments, and refuses opaque imports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'foottrace-contract-'));
  const file = join(directory, 'consumer.ts');
  try {
    writeFileSync(
      file,
      `// import { guessed } from 'foottrace';
      import { joinPath as join, type CommitBundle } from 'foottrace';
      import type { LogAddress } from 'foottrace';
      export { nativeGet as get } from 'foottrace/paths';`,
    );
    assert.deepEqual(
      foottraceImports(directory).map(({ door, name, kind }) => ({ door, name, kind })),
      [
        { door: 'foottrace/paths', name: 'nativeGet', kind: 'value' },
        { door: 'foottrace', name: 'CommitBundle', kind: 'type' },
        { door: 'foottrace', name: 'LogAddress', kind: 'type' },
        { door: 'foottrace', name: 'joinPath', kind: 'value' },
      ],
    );
    for (const declaration of [
      `import * as record from 'foottrace';`,
      `export * from 'foottrace';`,
      `import record from 'foottrace';`,
      `import 'foottrace';`,
      `const record = require('foottrace');`,
      `const record = import('foottrace');`,
      `type Record = import('foottrace').CommitBundle;`,
      `import record = require('foottrace');`,
    ]) {
      writeFileSync(file, declaration);
      assert.throws(() => foottraceImports(directory), assert.AssertionError);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const mode of ['require', 'import']) {
  const load = mode === 'require' ? createRequire(import.meta.url) : (door) => import(door);
  const api = {
    root: await load('foottrace'),
    write: await load('foottrace/write'),
    paths: await load('foottrace/paths'),
  };
  for (const behavior of behaviors) test(`${mode}: ${behavior.name}`, () => behavior.run(api));
}
