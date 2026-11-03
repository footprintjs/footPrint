import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { foottraceImports } from './foottrace.imports.mjs';

const imports = foottraceImports();
const importedKeys = new Set(imports.map(({ door, name }) => `${door}:${name}`));
for (const { door, name } of foottraceImports(new URL('./', import.meta.url))) {
  assert.ok(importedKeys.has(`${door}:${name}`), `Type specimen contracts an unimported API: ${door}:${name}`);
}
const declarations = imports
  .map(({ door, name }, index) => `import type { ${name} as Imported${index} } from '${door}';`)
  .join('\n');
const specimen = readFileSync(new URL('./foottrace.types.ts', import.meta.url), 'utf8');
for (const extension of ['cts', 'mts']) {
  const filename = resolve(`contract/foottrace.generated.${extension}`);
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...rest) =>
    file === filename
      ? ts.createSourceFile(filename, `${declarations}\n${specimen}`, languageVersion, true)
      : original(file, languageVersion, ...rest);
  const program = ts.createProgram(
    [filename],
    {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: [],
    },
    host,
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => '\n',
    }),
  );
  console.log(`Foottrace ${extension}: ${imports.length} source-derived imports and engine boundary types compile`);
}
