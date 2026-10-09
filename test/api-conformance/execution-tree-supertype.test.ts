/**
 * C6(b) — the record's readers take `ExecutionTree`, the record's own structural type for the tree, a
 * SUPERTYPE of the engine's `StageSnapshot`. So a signature that named `StageSnapshot` only widened:
 * every caller, and every `TimeTravelStrategy` implementer that annotates its tree, compiles unchanged.
 *
 * Vitest strips types, so the compiler is asked directly (the hook-registry-compile pattern):
 *
 *   contract  execution-tree-supertype.consumers.ts — the published consumers' shapes — compiles with
 *             no diagnostic against this tree
 *   contract  the same file compiles against a release from BEFORE the change: it is code that compiled
 *             then, not code written to fit it. The release is `footprintjs-baseline` (9.28.0, an npm
 *             alias pinned EXACTLY): `footprintjs-published` is a caret range, and with no lockfile a
 *             fresh install resolves it to the newest 9.x — the release that carries this change
 *   boundary  the one shape that sees the new type: an implementer that leaves its tree parameter
 *             unannotated is typed by the signature, so reading a `StageSnapshot`-only field there no
 *             longer compiles (it did before) — and this check can fail
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO = resolve(__dirname, '../..');
const PROBE = resolve(__dirname, 'execution-tree-supertype.consumers.ts');

const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(REPO, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  REPO,
);
const OPTIONS: ts.CompilerOptions = { ...parsed.options, noEmit: true };

/** The diagnostics a set of (virtual) files gets, as `file:line message` — only those files', not the library's. */
function diagnostics(files: Record<string, string>): string[] {
  const host = ts.createCompilerHost(OPTIONS);
  const base = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
  host.getSourceFile = (file, version, onError, create) =>
    files[resolve(file)] !== undefined
      ? ts.createSourceFile(file, files[resolve(file)]!, version, true)
      : base.getSourceFile(file, version, onError, create);
  host.fileExists = (file) => files[resolve(file)] !== undefined || base.fileExists(file);
  host.readFile = (file) => files[resolve(file)] ?? base.readFile(file);
  const program = ts.createProgram(Object.keys(files), OPTIONS, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && files[resolve(d.file.fileName)] !== undefined)
    .map((d) => {
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
      return `${d.file!.fileName.split('/').pop()}:${line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
}

/** `source` with its imports of this tree's doors re-pointed at a release from before C6 (exactly pinned). */
const before = (source: string) =>
  source
    .replace(
      "import type { CommitBundle } from 'foottrace';",
      "import type { CommitBundle } from 'footprintjs-baseline/advanced';",
    )
    .replace(/'\.\.\/\.\.\/src\/advanced\.js'/g, "'footprintjs-baseline/advanced'")
    .replace(/'foottrace'/g, "'footprintjs-baseline/trace'");

const consumers = readFileSync(PROBE, 'utf8');

/** An implementer that types its tree by the signature and reads what only a `StageSnapshot` has. */
const UNANNOTATED = [
  "import type { TimeTravelStrategy } from 'foottrace';",
  "import { commitStops } from 'foottrace';",
  'export const logged: TimeTravelStrategy = {',
  '  stopsFor: (log, tree) => (tree?.logs ? commitStops(log, tree) : []),',
  '};',
].join('\n');

describe('ExecutionTree is a supertype of StageSnapshot — what compiled before still compiles', () => {
  it('the consumers’ shapes compile against this tree', () => {
    expect(diagnostics({ [PROBE]: consumers })).toEqual([]);
  }, 60_000);

  it('the same shapes compile against a release from before the change — the probe is pre-C6 code', () => {
    expect(before(consumers)).toContain("from 'footprintjs-baseline/trace'");
    expect(diagnostics({ [resolve(__dirname, '__before_consumers__.ts')]: before(consumers) })).toEqual([]);
  }, 60_000);

  it('the boundary: an UNANNOTATED tree parameter is typed by the signature (and the check can fail)', () => {
    expect(diagnostics({ [resolve(__dirname, '__before_unannotated__.ts')]: before(UNANNOTATED) })).toEqual([]);
    // The before-side is typed, not `any`: a field no StageSnapshot has is refused there too.
    const nope = diagnostics({
      [resolve(__dirname, '__before_nope__.ts')]: before(UNANNOTATED.replace('logs', 'nope')),
    });
    expect(nope.join('\n')).toMatch(/Property 'nope' does not exist on type 'StageSnapshot'/);
    const here = diagnostics({ [resolve(__dirname, '__unannotated__.ts')]: UNANNOTATED });
    expect(here).toHaveLength(1);
    expect(here[0]).toMatch(/Property 'logs' does not exist on type 'ExecutionTree'/);
  }, 60_000);
});
