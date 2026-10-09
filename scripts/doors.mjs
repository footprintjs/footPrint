/**
 * doors.mjs — every name a public door hands out, and the file that declares it.
 *
 * A door is a package entry point (`src/*.ts`, L8 in `layering.config.cjs`; the keys of package.json
 * `exports` name them). A name is resolved through every alias and re-export to its declaration, so
 * `export { A as B }` and `export * from` count. The extraction plan's rule reads off this map
 * (docs/design/2026-10-trace-extraction.md, section 7.5): a symbol is the RECORD'S — it moves to the
 * trace package — when it is declared in a record file (`layering.config.cjs · RECORD_FILES`).
 *
 * Three readers, none keeps a copy:
 *   - `scripts/record-tests.mjs`     a test's import from a door counts as the files its names are declared in
 *   - `scripts/audit-consumers.mjs`  the "record symbols" a consumer imports from `/advanced`
 *   - `scripts/trace-ready.mjs`      R3 (record internals no door hands out) and R5
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const layering = require('./layering.config.cjs');

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The compiler options of `<root>/tsconfig.json` (or plain strict defaults), never emitting. */
function optionsAt(root) {
  const config = join(root, 'tsconfig.json');
  const options = existsSync(config)
    ? ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config, ts.sys, root).options
    : { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true };
  return { ...options, noEmit: true };
}

/**
 * Every door under `<root>/src`: `door` (repo-relative file) → `name` → the repo-relative files that
 * declare it. A declaration outside the tree (a package's) keeps its path relative to `root`.
 */
export function readDoors(root = REPO_ROOT) {
  const files = layering.listSourceFiles(root).filter((f) => layering.rankOf(f) === 8);
  const program = ts.createProgram(
    files.map((f) => join(root, f)),
    optionsAt(root),
  );
  const checker = program.getTypeChecker();
  const where = (file) => relative(root, file).split('\\').join('/');
  const doors = new Map();
  for (const file of files) {
    const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(join(root, file)));
    const names = new Map();
    for (const symbol of moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : []) {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      const declared = new Set((target.declarations ?? []).map((d) => where(d.getSourceFile().fileName)));
      names.set(symbol.getName(), [...declared].sort());
    }
    doors.set(file, names);
  }
  return doors;
}

/** The package's door specifiers (`footprintjs`, `footprintjs/trace`, …) → their src entry files. */
export function doorSpecifiers(root = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = new Map();
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    const dist = typeof target === 'string' ? target : target?.require?.default ?? target?.default;
    const entry = /^\.\/dist\/(?:esm\/)?([\w-]+)\.js$/.exec(typeof dist === 'string' ? dist : '');
    if (entry) out.set(subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`, `src/${entry[1]}.ts`);
  }
  return out;
}

/** True when every declaration of a door's name lies in a record file — the plan's rule, section 7.5. */
export const isRecordName = (declared) => declared.length > 0 && declared.every((f) => layering.isRecordFile(f));

/** The record symbols: every name some door hands out that is declared in a record file. */
export function recordSymbols(doors = readDoors()) {
  const names = new Set();
  for (const door of doors.values()) for (const [name, declared] of door) if (isRecordName(declared)) names.add(name);
  return names;
}
