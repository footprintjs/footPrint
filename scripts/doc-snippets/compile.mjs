import { relative, resolve } from 'node:path';
import ts from 'typescript';

export function checkSnippets(root, units) {
  const options = {
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    jsx: ts.JsxEmit.Preserve,
    allowImportingTsExtensions: true,
    types: [],
    typeRoots: [resolve(root, 'node_modules/@types')],
    lib: ['lib.esnext.d.ts', 'lib.dom.d.ts'],
    paths: Object.fromEntries(
      ['index', 'trace', 'advanced', 'recorders', 'zod', 'detach'].map((door) => [
        door === 'index' ? 'footprintjs' : `footprintjs/${door}`,
        [resolve(root, `src/${door}.ts`)],
      ]),
    ),
  };
  // Virtual files live beside their documents, preserving relative import resolution.
  const virtual = new Map(
    units.map((unit) => [
      resolve(root, `${unit.file}.__snippet_${unit.index}.${unit.language === 'tsx' ? 'tsx' : 'ts'}`),
      unit,
    ]),
  );
  if (virtual.size !== units.length) throw new Error('Duplicate snippet identity.');
  // A forced module still allows global/module augmentations. Separate programs
  // prevent declarations in one example from repairing another example's errors.
  const diagnostics = [];
  for (const [file, unit] of virtual) {
    const host = ts.createCompilerHost(options, true);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    // Only this root is virtual. An example cannot import another fence's
    // generated filename as a hidden dependency that does not exist on disk.
    host.readFile = (path) => (resolve(path) === file ? unit.source : readFile(path));
    host.fileExists = (path) => resolve(path) === file || fileExists(path);
    host.getCurrentDirectory = () => root;
    const program = ts.createProgram({ rootNames: [file], options, host });
    diagnostics.push(...ts.getPreEmitDiagnostics(program));
  }
  // Never filter diagnostic codes or drop a document because parsing failed.
  return diagnostics.map((diagnostic) => {
    const unit = diagnostic.file && virtual.get(resolve(diagnostic.file.fileName));
    const at =
      diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined;
    const origin = at && unit?.lineMap?.[at.line];
    return {
      file: unit?.file ?? (diagnostic.file ? relative(root, diagnostic.file.fileName) : '<compiler>'),
      line: at ? origin?.line ?? (unit?.line ?? 1) + at.line : undefined,
      column: at ? origin?.columns?.[at.character] ?? (origin?.column ?? 1) + at.character : undefined,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    };
  });
}
