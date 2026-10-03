/**
 * The F6 review question, answered by the compiler: "add a hook to one channel without adding
 * it to the registry — what fails at compile time?"  Answer: `recorder/hooks.ts` stops compiling.
 *
 * Each probe compiles the REAL `src/lib/recorder/hooks.ts` beside a virtual file that augments a
 * recorder interface (declaration merging — exactly what adding a member in the source does) and
 * asserts the diagnostic lands on the registry. The control compiles with no augmentation.
 */

import { resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');
const HOOKS_FILE = resolve(REPO, 'src/lib/recorder/hooks.ts');
const PROBE_FILE = resolve(REPO, 'test/architecture/__hook_registry_probe__.ts');

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
};

/** Diagnostics reported in hooks.ts when compiled beside `probe`. */
function registryErrors(probe: string): string[] {
  const host = ts.createCompilerHost(OPTIONS);
  const read = host.readFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.readFile = (f) => (resolve(f) === PROBE_FILE ? probe : read(f));
  host.fileExists = (f) => resolve(f) === PROBE_FILE || exists(f);
  const program = ts.createProgram([PROBE_FILE, HOOKS_FILE], OPTIONS, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && resolve(d.file.fileName) === HOOKS_FILE)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

const FLOW_TYPES = '../../src/lib/engine/narrative/types.js';
const SCOPE_TYPES = '../../src/lib/scope/types.js';

describe('the hook registry is checked against the recorder interfaces at compile time', () => {
  it('control: the registry compiles as shipped', () => {
    expect(registryErrors(`import '${FLOW_TYPES}';\nexport {};\n`)).toEqual([]);
  }, 60_000);

  it('a NEW hook on FlowRecorder, missing from HOOKS, does not compile', () => {
    const errors = registryErrors(
      `export {};\ndeclare module '${FLOW_TYPES}' {\n  interface FlowRecorder { onProbeHook?(event: { probe: true }): void }\n}\n`,
    );
    expect(errors.join('\n')).toMatch(/onProbeHook/);
  }, 60_000);

  it('an existing flow hook added to ScopeRecorder (a second channel) does not compile until HOOKS names it', () => {
    const errors = registryErrors(
      `export {};\ndeclare module '${SCOPE_TYPES}' {\n  interface ScopeRecorder { onLoop?(event: { probe: true }): void }\n}\n`,
    );
    expect(errors.join('\n')).toMatch(/scope/);
  }, 60_000);
});
