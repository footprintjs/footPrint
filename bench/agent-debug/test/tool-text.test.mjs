/**
 * The tool texts handed to set-up P are true of the twin (RULE-2.md,
 * "Changed after the fairness reading": `read_file`'s example once named
 * `src/chart.mjs`, a file only the flowchart program has).
 * Every path a definition of a P tool names (in its description or in any
 * property's description) must exist in the twin's working folder, and
 * every quoted example ("for example …", "such as …") must be a fixture, a
 * path, or text the twin's folder holds. The same holds for set-up 1 on the
 * flowchart program, so a text true of only one of them fails here.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { PROGRAMS } from '../harness/programs.mjs';
import { schemaOf } from '../harness/shapes.mjs';
import { createWorkdir, listFiles, removeWorkdir } from '../harness/workdir.mjs';
import { loadQuestions } from '../questions/index.mjs';
import { toolsFor } from '../tools/index.mjs';

/** Every string of a tool definition: its description and every nested description. */
function texts(definition) {
  const out = [definition.description];
  const walk = (v) => {
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'description' && typeof x === 'string' ? out.push(x) : walk(x));
  };
  walk(definition.input_schema);
  return out;
}

/** The paths a text names: tokens under src/, test/ or fixtures/, and file names with an extension. */
export function pathsIn(text) {
  return [...text.matchAll(/(?<![\w/.-])((?:src|test|fixtures)\/[\w./<>-]*|[\w-]+\.(?:mjs|md|json))/g)].map((m) => m[1].replace(/[.,;:]+$/, ''));
}

/** The quoted examples a text gives. */
export function examplesIn(text) {
  return [...text.matchAll(/(?:for example|such as) ("[^"]+"(?: or "[^"]+")*)/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

/** Whether `folder` (a working copy) holds what a text names. */
function checkFolder(dir, definitions, label) {
  const files = listFiles(dir);
  const fixtures = files.filter((f) => f.startsWith('fixtures/')).map((f) => f.slice('fixtures/'.length, -'.json'.length));
  const text = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  const problems = [];
  for (const definition of definitions) {
    for (const t of texts(definition)) {
      for (const path of pathsIn(t)) {
        const real = path.replace('<fixture>', fixtures[0]);
        if (!existsSync(join(dir, real))) problems.push(`${label} ${definition.name} names ${path}, which ${label}'s working folder does not hold`);
      }
      for (const example of examplesIn(t)) {
        const ok = fixtures.includes(example) || existsSync(join(dir, example)) || example.split('|').every((part) => text.includes(part));
        if (!ok) problems.push(`${label} ${definition.name} gives the example "${example}", which ${label}'s working folder does not hold`);
      }
    }
  }
  return problems;
}

/** Every definition a set-up may be handed: its tools for a fault, and for each question's answer schema. */
function definitionsOf(setup) {
  const sets = [toolsFor(setup), ...loadQuestions().map((q) => toolsFor(setup, schemaOf(q.shape)))];
  return [...new Map(sets.flat().map((t) => [JSON.stringify(t.definition), t.definition])).values()];
}

test('every path and example a tool handed to set-up P names exists in the twin\'s working folder', async () => {
  const work = await createWorkdir(null, { program: PROGRAMS.P });
  try {
    assert.deepEqual(checkFolder(work.dir, definitionsOf('P'), 'P'), []);
  } finally {
    removeWorkdir(work.dir);
  }
});

test('the same holds for set-up 1 on the flowchart program', async () => {
  const work = await createWorkdir(null);
  try {
    assert.deepEqual(checkFolder(work.dir, definitionsOf(1), '1'), []);
  } finally {
    removeWorkdir(work.dir);
  }
});

test('the check sees a text true of the flowchart program only', async () => {
  const work = await createWorkdir(null, { program: PROGRAMS.P });
  try {
    const old = { name: 'read_file', description: 'Give a path relative to the working folder, such as "src/chart.mjs".', input_schema: { type: 'object', properties: {} } };
    assert.deepEqual(pathsIn(old.description), ['src/chart.mjs']);
    assert.equal(checkFolder(work.dir, [old], 'P').length, 2, 'the path and the example are both caught');
    const map = toolsFor(3).find((t) => t.definition.name === 'map');
    assert.ok(checkFolder(work.dir, [/** @type {any} */ (map).definition], 'P').length > 0, 'map names src/chart.mjs, which is why P never gets it');
  } finally {
    removeWorkdir(work.dir);
  }
});
