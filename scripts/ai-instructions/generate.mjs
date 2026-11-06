#!/usr/bin/env node
/**
 * generate.mjs: writes every AI instruction file from `ai-instructions/source`.
 *
 *   npm run ai:generate            write the files, then report any wrong fact
 *   npm run check:ai-instructions  write nothing; exit 1 on drift or a wrong fact
 *
 * `--root <dir>` reads and writes instruction files under another folder; the code's names still come
 * from this repository. The tests use it to prove the check goes red.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  budgetProblems,
  driftProblems,
  importMapProblems,
  proseProblems,
  readCodeFacts,
  strayProblems,
  taskProblems,
} from './facts.mjs';
import { readSource, renderAll } from './render.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every problem with the instruction files under `root`. `drift` is off after a write. */
export function findProblems(root, source, rendered, code, { drift = true } = {}) {
  return [
    ...(drift ? driftProblems(rendered, root) : []),
    ...strayProblems(rendered, root),
    ...importMapProblems(source.importMap, code),
    ...taskProblems(source.tasks, root),
    ...proseProblems(rendered, code),
    ...budgetProblems(rendered),
  ];
}

export function writeAll(rendered, root) {
  for (const { target, text } of rendered) {
    const path = join(root, target.output);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}

/** The bytes of each file. Tokens are an estimate at four characters per token, never a count. */
const sizeLine = ({ target, text }) => {
  const bytes = Buffer.byteLength(text);
  return `  ${target.output}: ${bytes} bytes, about ${Math.round(bytes / 400) / 10}k tokens (estimate)`;
};

function main(args) {
  const check = args.includes('--check');
  const at = args.indexOf('--root');
  const root = at >= 0 ? resolve(args[at + 1]) : REPO_ROOT;
  const name = check ? 'check:ai-instructions' : 'ai:generate';

  let source;
  let rendered;
  try {
    source = readSource(root);
    rendered = renderAll(source);
  } catch (error) {
    console.error(`${name}: FAIL: ${error.message}`);
    return 1;
  }
  if (!check) writeAll(rendered, root);

  const problems = findProblems(root, source, rendered, readCodeFacts(REPO_ROOT), { drift: check });
  for (const { code, file, message } of problems) {
    console.error(`${file} ${code}: ${message}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning file=${file}::${code}: ${message}`);
  }
  console.log(`${name}: ${problems.length ? `FAIL (${problems.length} problems)` : 'OK'}`);
  for (const item of rendered) console.log(sizeLine(item));
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
