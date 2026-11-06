/**
 * facts.mjs: what the generated files claim, checked against the code. Each check returns problems;
 * none of them fixes anything. Generated text comes in as strings, the code's names as `code`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { doorSpecifiers, installedDoorSpecifiers, publicNames } from '../doors.mjs';

const RECORD_PACKAGE = 'foottrace';
const problem = (code, file, message) => ({ code, file, message });

/** Every public door of both packages (`door` to its names), and every member those names declare. */
export function readCodeFacts(root) {
  const entries = [...doorSpecifiers(root), ...installedDoorSpecifiers(RECORD_PACKAGE, root)];
  const { doors, members } = publicNames(
    entries.map(([, file]) => file),
    root,
  );
  const names = new Map(entries.map(([door, file]) => [door, doors.get(file)]));
  return { doors: names, known: new Set([...members, ...[...names.values()].flatMap((set) => [...set])]) };
}

/** The import map has one row per real door, and each name it shows is on that door. */
export function importMapProblems(importMap, code) {
  const file = 'ai-instructions/source/import-map.json';
  const rows = new Set(importMap.map((row) => row.door));
  return [
    ...[...code.doors.keys()]
      .filter((door) => !rows.has(door))
      .map((door) => problem('door-missing', file, `${door} is a public door with no row. Add one.`)),
    ...importMap.flatMap(({ door, names }) => {
      if (!code.doors.has(door))
        return [problem('door-unknown', file, `${door} is not a public door. Remove the row.`)];
      return names
        .filter((name) => !code.doors.get(door).has(name))
        .map((name) => problem('name-missing', file, `${door} does not export ${name}. Fix the row.`));
    }),
  ];
}

/** GitHub's heading slug, close enough for the headings in this repository. */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

function anchorsOf(path) {
  let fenced = false;
  const anchors = new Set();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    const heading = !fenced && /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) anchors.add(slug(heading[1]));
  }
  return anchors;
}

/** Each path in the task table exists, and its `#anchor`, when it has one, is a heading in that file. */
export function taskProblems(tasks, root) {
  const file = 'ai-instructions/source/tasks.json';
  return tasks.flatMap(({ task, read }) =>
    read.flatMap((target) => {
      const [path, anchor] = target.split('#');
      const absolute = join(root, path);
      if (!existsSync(absolute))
        return [problem('path-missing', file, `"${task}" points at ${path}, which does not exist. Update the row.`)];
      if (anchor && !anchorsOf(absolute).has(anchor))
        return [
          problem('anchor-missing', file, `"${task}" points at ${target}, and that heading is gone. Update the row.`),
        ];
      return [];
    }),
  );
}

/**
 * The API names an inline code span claims: a call (`.retry()`, `scope.$call()`, `run({ signal })`), a
 * `$` method, an `on…` hook, or a capitalised name with its members. Any other span is left alone,
 * because state keys and option values are not names a door hands out.
 */
export function apiNamesIn(span) {
  const call = /^(?:[\w$]+\.)*\.?([\w$]+)(?:<[^>]*>)?\(/.exec(span);
  if (call) return [call[1]];
  if (/^\$\w+$/.test(span) || /^on[A-Z]\w+$/.test(span)) return [span];
  if (/^[A-Z][A-Za-z]*[a-z][A-Za-z]*(?:\.[\w$]+)*$/.test(span)) return span.split('.');
  return [];
}

/** Prose names a door cannot vouch for, and `file:line` citations, which rot. Fences are the snippet check's job. */
export function proseProblems(rendered, code) {
  const seen = new Set();
  const found = [];
  for (const { target, text } of rendered) {
    const prose = text.replace(/^```[\s\S]*?^```$/gm, '');
    for (const [, span] of prose.matchAll(/`([^`\n]+)`/g)) {
      for (const name of apiNamesIn(span)) {
        if (code.known.has(name) || seen.has(name)) continue;
        seen.add(name);
        found.push(problem('name-unknown', target.output, `\`${span}\` names ${name}, which no public door declares.`));
      }
    }
    for (const [citation] of prose.matchAll(/\b[\w./-]+\.(?:ts|mts|mjs|cjs|md):\d+\b/g))
      found.push(problem('line-citation', target.output, `${citation} cites a line. Cite file · symbol.`));
  }
  return found;
}

/** Each generated file stays inside its size budget. */
export const budgetProblems = (rendered) =>
  rendered
    .filter(({ target, text }) => Buffer.byteLength(text) > target.maxBytes)
    .map(({ target, text }) =>
      problem(
        'over-budget',
        target.output,
        `${Buffer.byteLength(text)} bytes is over its budget of ${target.maxBytes}. Move detail to a linked page.`,
      ),
    );

/** Each generated file on disk equals what the source renders to. */
export const driftProblems = (rendered, root) =>
  rendered.flatMap(({ target, text }) => {
    const path = join(root, target.output);
    if (!existsSync(path)) return [problem('drift', target.output, 'is missing. Run npm run ai:generate.')];
    if (readFileSync(path, 'utf8') === text) return [];
    return [
      problem(
        'drift',
        target.output,
        'differs from its source. Edit ai-instructions/source, then run npm run ai:generate.',
      ),
    ];
  });

/** `ai-instructions/` holds the source, its own two files and generated files, and nothing hand-kept beside them. */
export function strayProblems(rendered, root) {
  const dir = join(root, 'ai-instructions');
  const allowed = new Set([
    ...rendered.map(({ target }) => target.output),
    'ai-instructions/README.md',
    'ai-instructions/setup.sh',
  ]);
  const walk = (folder) =>
    readdirSync(folder).flatMap((name) => {
      const path = join(folder, name);
      return statSync(path).isDirectory() ? walk(path) : [relative(root, path).split('\\').join('/')];
    });
  return walk(dir)
    .filter((file) => !file.startsWith('ai-instructions/source/') && !allowed.has(file))
    .map((file) =>
      problem('stray-file', file, 'is not generated from the source. Delete it, or add it to targets.json.'),
    );
}
