/**
 * An app compiled with `exactOptionalPropertyTypes` can attach every built-in recorder.
 *
 * The library builds WITHOUT that flag, so its shipped declarations spell an inferred optional member
 * as `capture?: … | undefined` (a conditional spread infers one: `ControlDepRecorder · toSnapshot`'s
 * `capture` since 10.3.0, `ManifestFlowRecorder · toSnapshot`'s `meta` since 10.1.0). Under the flag
 * `X | undefined` is not `X`, so a bundle type that refused an explicit `undefined` refused those
 * recorders at every attach door (`attachCombinedRecorder(controlDepRecorder())` stopped compiling).
 * `recorder/snapshot.ts · RecorderBundle` takes an explicit `undefined` on each optional member;
 * `copyBundle` copies field by field, so `undefined` and absent already read the same.
 *
 * Compiled against the SOURCE, the mismatch never shows, even with the old bundle type: the
 * bundles are then inferred under the flag too. So the probe is compiled against the DECLARATIONS,
 * emitted in memory exactly as `npm run build` writes dist/types (this repo's tsconfig.json), by a
 * consumer program whose options differ from the library's by the flag alone. Vitest strips types,
 * so the compiler is asked directly (the execution-tree-supertype pattern).
 *
 *   contract  every built-in recorder with a `toSnapshot` attaches through `attachCombinedRecorder` and
 *             its own channel door, and so does an app's recorder whose bundle carries an explicit
 *             `undefined` (the `attachEmitRecorder` door)
 *   boundary  the consumer program really runs under the flag, and the bundle is lenient on its
 *             optional members only: a bundle whose `name` is `undefined` is still refused. This
 *             also fails if the doors stop resolving and turn into `any`
 */
import { dirname, join, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');
/** Where the emitted declarations are served from. Nothing is written to disk. */
const DECLARATIONS = join(REPO, '__emitted_declarations__');
const PROBE = resolve(__dirname, '__exact_optional_probe__.ts');

const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(REPO, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  REPO,
);

let emitted: Map<string, string> | undefined;

/** The declarations `npm run build` writes to dist/types, emitted in memory once: path → text. */
function declarations(): Map<string, string> {
  if (emitted) return emitted;
  const options: ts.CompilerOptions = {
    ...parsed.options,
    declarationDir: DECLARATIONS,
    emitDeclarationOnly: true,
    inlineSourceMap: false,
    inlineSources: false,
  };
  const files = new Map<string, string>();
  const result = ts
    .createProgram(parsed.fileNames, options)
    .emit(undefined, (file, text) => files.set(resolve(file), text));
  const problems = result.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
  if (result.emitSkipped || problems.length > 0) throw new Error(`declaration emit failed: ${problems.join('; ')}`);
  emitted = files;
  return files;
}

/** The diagnostics an app gets for `probe` against the emitted declarations, as `line: message`. */
function consumerDiagnostics(probe: string): string[] {
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    exactOptionalPropertyTypes: true,
    paths: { footprintjs: [join(DECLARATIONS, 'index.d.ts')], 'footprintjs/*': [join(DECLARATIONS, '*.d.ts')] },
  };
  const served = declarations();
  // A relative import is looked up only in a directory that exists, so the served folders must too:
  // without them every `./lib/…` import inside the declarations is unresolved, silently under
  // `skipLibCheck`, and each door turns into `any`. The boundary test below would then fail.
  const folders = new Set<string>();
  for (const file of served.keys()) {
    for (let dir = dirname(file); dir.startsWith(DECLARATIONS); dir = dirname(dir)) folders.add(dir);
  }
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = (file) => (resolve(file) === PROBE ? probe : served.get(resolve(file)) ?? read(file));
  host.fileExists = (file) => resolve(file) === PROBE || served.has(resolve(file)) || exists(file);
  host.directoryExists = (dir) => folders.has(resolve(dir)) || ts.sys.directoryExists(dir);
  const program = ts.createProgram([PROBE], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => !d.file || resolve(d.file.fileName) === PROBE)
    .map((d) => {
      const line = d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : 0;
      return `${line}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
}

const HEADER = [
  "import type { FlowChartExecutor } from 'footprintjs';",
  "import { attempts, CompositeRecorder, debug, manifest, metrics, narrative } from 'footprintjs/recorders';",
  "import { controlDepRecorder, inOutRecorder, QualityRecorder, topologyRecorder } from 'footprintjs/trace';",
  'declare const executor: FlowChartExecutor;',
];

/** Every built-in recorder with a `toSnapshot`, through the combined door and its own channel door. */
const BUILT_INS = [
  ...HEADER,
  'executor.attachCombinedRecorder(controlDepRecorder());',
  'executor.attachFlowRecorder(controlDepRecorder());',
  'executor.attachCombinedRecorder(manifest());',
  'executor.attachFlowRecorder(manifest());',
  'executor.attachCombinedRecorder(inOutRecorder());',
  'executor.attachFlowRecorder(inOutRecorder());',
  'executor.attachCombinedRecorder(topologyRecorder());',
  'executor.attachFlowRecorder(topologyRecorder());',
  'executor.attachCombinedRecorder(attempts());',
  'executor.attachFlowRecorder(attempts());',
  'executor.attachCombinedRecorder(metrics());',
  'executor.attachScopeRecorder(metrics());',
  'executor.attachCombinedRecorder(debug());',
  'executor.attachScopeRecorder(debug());',
  'const quality = new QualityRecorder(() => ({ score: 1 }));',
  'executor.attachCombinedRecorder(quality);',
  'executor.attachScopeRecorder(quality);',
  'executor.attachCombinedRecorder(narrative());',
  'executor.attachEmitRecorder(narrative());',
  "const composite = new CompositeRecorder('composite', [metrics(), manifest(), controlDepRecorder()]);",
  'executor.attachCombinedRecorder(composite);',
  'executor.attachScopeRecorder(composite);',
  'executor.attachFlowRecorder(composite);',
  // An app's own recorder, written the way an app under the flag writes one: optional options passed on.
  'class Labelled {',
  "  readonly id = 'labelled';",
  "  constructor(private readonly label?: string, private readonly view?: 'translate') {}",
  '  onEmit(): void {}',
  "  toSnapshot() { return { name: 'labelled', description: this.label, preferredOperation: this.view, data: [] }; }",
  '}',
  'executor.attachEmitRecorder(new Labelled());',
  'executor.attachCombinedRecorder(new Labelled());',
].join('\n');

describe('an app compiled with exactOptionalPropertyTypes attaches every built-in recorder', () => {
  it('every built-in recorder with a toSnapshot, and an app recorder with an explicit undefined, attach', () => {
    expect(consumerDiagnostics(BUILT_INS)).toEqual([]);
  }, 60_000);

  it('the boundary: the program runs under the flag, and a bundle without a name is still refused', () => {
    const flag = consumerDiagnostics('export const probe: { a?: number } = { a: undefined };');
    expect(flag).toHaveLength(1);
    expect(flag[0]).toMatch(/exactOptionalPropertyTypes/);
    const nameless = consumerDiagnostics(
      [...HEADER, "executor.attachEmitRecorder({ id: 'x', toSnapshot: () => ({ name: undefined, data: [] }) });"].join(
        '\n',
      ),
    );
    expect(nameless).toHaveLength(1);
    expect(nameless[0]).toMatch(/^5: .*'undefined' is not assignable to type 'string'/);
  }, 60_000);
});
