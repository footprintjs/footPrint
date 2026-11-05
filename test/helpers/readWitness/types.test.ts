import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { expect, it } from 'vitest';

it('the private witness facades compose under strict TypeScript without test-global shims', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const files = [
    'readWitness',
    'firstCommit124',
    'readLawPorts',
    'pauseLegViews',
    'observedFamily',
    'witnessDecision',
  ].map((name) => resolve(root, `test/helpers/${name}.ts`));
  const program = ts.createProgram(files, {
    noEmit: true,
    strict: true,
    noImplicitReturns: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    skipLibCheck: true,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program).map((item) => ({
    code: item.code,
    message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
  }));
  expect(diagnostics).toEqual([]);
});
