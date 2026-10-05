#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, format } from './doc-snippets/index.mjs';

try {
  const result = analyze(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(format(result));
  process.exitCode = result.diagnostics.length ? 1 : 0;
} catch (error) {
  console.error('check-doc-snippets: compiler/discovery failure:', error);
  process.exitCode = 1;
}
