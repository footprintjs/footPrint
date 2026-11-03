import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export function foottraceImports(root = new URL('../src/', import.meta.url)) {
  const imports = new Map();
  function visitDirectory(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) visitDirectory(file);
      else if (entry.name.endsWith('.ts')) {
        const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node) {
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            const door = node.moduleSpecifier?.text;
            if (door === 'foottrace' || door?.startsWith('foottrace/')) {
              const clause = ts.isImportDeclaration(node) ? node.importClause : node;
              const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause;
              assert.ok(
                (bindings && ts.isNamedImports(bindings)) || (bindings && ts.isNamedExports(bindings)),
                `${file}: foottrace contracts require named imports/exports`,
              );
              assert.ok(!clause.name, `${file}: default foottrace imports need an explicit contract`);
              for (const specifier of bindings.elements) {
                const name = (specifier.propertyName ?? specifier.name).text;
                const key = `${door}:${name}`;
                const kind = clause.isTypeOnly || specifier.isTypeOnly ? 'type' : 'value';
                const prior = imports.get(key);
                imports.set(key, {
                  door,
                  name,
                  kind: prior?.kind === 'value' ? 'value' : kind,
                  files: [...new Set([...(prior?.files ?? []), relative(process.cwd(), file)])],
                });
              }
            }
          } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            const door = node.moduleReference.expression?.text;
            assert.ok(
              !(door === 'foottrace' || door?.startsWith('foottrace/')),
              `${file}: import-equals foottrace imports need an explicit contract`,
            );
          } else if (
            (ts.isCallExpression(node) &&
              (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) ||
            ts.isImportTypeNode(node)
          ) {
            const argument = ts.isImportTypeNode(node) ? node.argument.literal : node.arguments[0];
            const door = argument && ts.isStringLiteralLike(argument) ? argument.text : undefined;
            assert.ok(
              !(door === 'foottrace' || door?.startsWith('foottrace/')),
              `${file}: dynamic/type-query foottrace imports need an explicit contract`,
            );
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  visitDirectory(root instanceof URL ? fileURLToPath(root) : root);
  assert.ok(imports.size, 'No production foottrace imports found');
  return [...imports.values()].sort((a, b) => {
    const left = `${a.door}:${a.name}`;
    const right = `${b.door}:${b.name}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
