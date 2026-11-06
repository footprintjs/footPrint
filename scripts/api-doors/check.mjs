#!/usr/bin/env node
/**
 * check.mjs: the generated API reference lists exactly the package's doors.
 *
 *   npm run docs && npm run check:api-doors
 *
 * The doors come from `scripts/doors.mjs · doorSpecifiers`, which reads `package.json · exports`. Those
 * are the doors `test/architecture/published-doors.test.ts` holds to the published release, and that test
 * pins the two readers together. `--root <dir>` checks another package. The tests use it to prove the
 * check goes red.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { importMapProblems } from '../ai-instructions/facts.mjs';
import { doorSpecifiers, publicNames } from '../doors.mjs';
import { doorPage, IMPORT_MAP, isEngineDoor } from './site.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CONFIG = 'typedoc.json';
const OUTPUT = 'api-docs.json';
const SITE = 'api-docs';
const MODULE_KIND = 2;

const problem = (code, file, message) => ({ code, file, message });
const readJson = (root, file) => JSON.parse(readFileSync(join(root, file), 'utf8'));
const normalize = (text) => text.replace(/\s+/g, ' ').trim();
const summaryOf = (module) => normalize((module.comment?.summary ?? []).map((part) => part.text).join(''));

/** Every door is an entry point, and every entry point is a door. */
function configProblems(doors, entryPoints) {
  const entries = new Set(entryPoints);
  const files = new Set(doors.values());
  return [
    ...[...doors]
      .filter(([, file]) => !entries.has(file))
      .map(([door, file]) => problem('door-undocumented', CONFIG, `${door} is a door. Add ${file} to entryPoints.`)),
    ...entryPoints
      .filter((file) => !files.has(file))
      .map((file) => problem('entry-not-a-door', CONFIG, `${file} is an entry point and no door. Remove it.`)),
  ];
}

/** One door's listing: its page, every name it hands out, and the job the import map gives it. */
function doorProblems(root, door, module, names, job) {
  const page = doorPage(door);
  const listed = new Set((module.children ?? []).map((child) => child.name));
  return [
    ...(existsSync(join(root, SITE, page))
      ? []
      : [problem('page-missing', `${SITE}/${page}`, `The sidebar links here, and ${door} has no such page.`)]),
    ...[...names]
      .filter((name) => !listed.has(name))
      .map((name) =>
        problem('name-unlisted', OUTPUT, `${door} exports ${name}, and the reference leaves it out. Check for @internal.`),
      ),
    ...(job === undefined || summaryOf(module).includes(normalize(job))
      ? []
      : [problem('job-missing', OUTPUT, `The comment on ${door} must say what the import map says: "${job}"`)]),
  ];
}

/** What TypeDoc really lists, against the doors. */
function outputProblems(root, doors, names, rows) {
  if (!existsSync(join(root, OUTPUT)))
    return [problem('output-missing', OUTPUT, 'No generated reference to read. Run npm run docs first.')];
  const modules = new Map(
    (readJson(root, OUTPUT).children ?? [])
      .filter((child) => child.kind === MODULE_KIND)
      .map((module) => [module.name, module]),
  );
  const jobs = new Map(rows.map(({ door, job }) => [door, job]));
  return [
    ...[...doors].flatMap(([door, file]) =>
      modules.has(door)
        ? doorProblems(root, door, modules.get(door), names.get(door), jobs.get(door))
        : [problem('door-unlisted', OUTPUT, `The reference lists no ${door}. Check the @module tag in ${file}.`)],
    ),
    ...[...modules.keys()]
      .filter((name) => !doors.has(name))
      .map((name) => problem('module-unknown', OUTPUT, `The reference lists ${name}, which is no door.`)),
  ];
}

/** Every way the reference, its config and the import map can disagree with the package's doors. */
export function findProblems(root) {
  const doors = doorSpecifiers(root);
  const read = publicNames([...doors.values()], root).doors;
  const names = new Map([...doors].map(([door, file]) => [door, read.get(file)]));
  const rows = readJson(root, IMPORT_MAP).filter(({ door }) => isEngineDoor(door));
  return [
    ...configProblems(doors, readJson(root, CONFIG).entryPoints ?? []),
    ...importMapProblems(rows, { doors: names }),
    ...outputProblems(root, doors, names, rows),
  ];
}

function main(args) {
  const at = args.indexOf('--root');
  const root = at >= 0 ? resolve(args[at + 1]) : REPO_ROOT;
  const problems = findProblems(root);
  for (const { code, file, message } of problems) {
    console.error(`${file} ${code}: ${message}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning file=${file}::${code}: ${message}`);
  }
  console.log(`check:api-doors: ${problems.length ? `FAIL (${problems.length} problems)` : 'OK'}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
