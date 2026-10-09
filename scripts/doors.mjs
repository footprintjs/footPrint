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

/** Record symbols handed out by any door, or only one requested door. A same-spelled engine
 * symbol on a different door must not borrow a record declaration's classification. */
export function recordSymbols(doors = readDoors(), onlyDoor) {
  const names = new Set();
  for (const [file, door] of doors) {
    if (onlyDoor && file !== onlyDoor) continue;
    for (const [name, declared] of door) if (isRecordName(declared)) names.add(name);
  }
  return names;
}

/** Parse imports as syntax, never matching comments or quoted examples. Shared by the consumer
 * audit and readiness report. Namespace/dynamic/require uses stay explicit, including mocks. */
export function importsIn(text, file = 'source.ts') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  const add = (node, spec, names, kind, namespace = false) => {
    imports.push({
      spec,
      names,
      kind,
      namespace,
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    });
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
      const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : clause;
      const names = ts.isImportDeclaration(node) && clause?.name ? ['default'] : [];
      const namespace = !!bindings && (ts.isNamespaceImport(bindings) || ts.isNamespaceExport(bindings));
      if ((bindings && ts.isNamedImports(bindings)) || (bindings && ts.isNamedExports(bindings))) {
        names.push(...bindings.elements.map((el) => (el.propertyName ?? el.name).text));
      } else if (namespace || (ts.isExportDeclaration(node) && !clause)) names.push('*');
      add(
        node,
        node.moduleSpecifier.text,
        names,
        node.isTypeOnly || clause?.isTypeOnly ? 'type' : 'static',
        namespace || names.includes('*'),
      );
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (node.moduleReference.expression)
        add(node, node.moduleReference.expression.text, ['*'], node.isTypeOnly ? 'type' : 'require', true);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      let qualifier = node.qualifier;
      while (qualifier && ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
      add(node, node.argument.literal.text, qualifier ? [qualifier.text] : ['*'], 'type', !qualifier);
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0].text, ['*'], 'dynamic', true);
      else if (ts.isIdentifier(callee) && callee.text === 'require')
        add(node, node.arguments[0].text, ['*'], 'require', true);
      else if (
        ts.isPropertyAccessExpression(callee) &&
        ['vi', 'jest'].includes(callee.expression.getText(source)) &&
        ['mock', 'doMock', 'importActual', 'importMock'].includes(callee.name.text)
      ) {
        add(node, node.arguments[0].text, ['*'], 'mock', false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

/** R3 is declaration identity, not spelling: a public alias also hands out its target symbol. */
export function recordInternals(root = REPO_ROOT) {
  const files = layering.listSourceFiles(root);
  const program = ts.createProgram(
    files.map((file) => join(root, file)),
    optionsAt(root),
  );
  const checker = program.getTypeChecker();
  const canonical = (symbol) => (symbol?.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  const publicSymbols = new Set();
  for (const file of files.filter((f) => layering.rankOf(f) === 8)) {
    const module = checker.getSymbolAtLocation(program.getSourceFile(join(root, file)));
    for (const symbol of module ? checker.getExportsOfModule(module) : []) publicSymbols.add(canonical(symbol));
  }
  const found = new Map();
  const inspect = (symbol, from, line) => {
    const target = canonical(symbol);
    if (!target || publicSymbols.has(target)) return;
    const declared = (target.declarations ?? []).map((d) =>
      relative(root, d.getSourceFile().fileName).split('\\').join('/'),
    );
    if (!isRecordName(declared)) return;
    if (!found.has(target))
      found.set(target, { name: target.getName(), declared: [...new Set(declared)].sort(), importers: [] });
    const use = `${from}:${line}`;
    if (!found.get(target).importers.includes(use)) found.get(target).importers.push(use);
  };
  for (const file of files.filter((f) => f.startsWith('src/lib/') && !layering.isRecordFile(f))) {
    const source = program.getSourceFile(join(root, file));
    for (const row of importsIn(source.text, file)) {
      const resolved = ts.resolveModuleName(row.spec, join(root, file), optionsAt(root), ts.sys).resolvedModule
        ?.resolvedFileName;
      const imported = resolved && program.getSourceFile(resolved);
      const module = imported && checker.getSymbolAtLocation(imported);
      const available = module ? checker.getExportsOfModule(module) : [];
      for (const symbol of available)
        if (row.names.includes('*') || row.names.includes(symbol.getName())) {
          inspect(symbol, file, row.line);
        }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.declared[0].localeCompare(b.declared[0]));
}

/** All source references, including import types, require and mocks. Missing local references stay
 * visible as to:null. Use compiler resolution so .js/.ts suffixes and configured aliases agree. */
export function sourceEdges(root, files) {
  const options = optionsAt(root);
  const known = new Set(files);
  const edges = [];
  for (const file of files) {
    for (const imported of importsIn(readFileSync(join(root, file), 'utf8'), file)) {
      const resolved = ts.resolveModuleName(imported.spec, join(root, file), options, ts.sys).resolvedModule
        ?.resolvedFileName;
      const target = resolved && relative(root, resolved).split('\\').join('/');
      edges.push({ from: file, to: known.has(target) ? target : null, ...imported });
    }
  }
  return edges;
}
