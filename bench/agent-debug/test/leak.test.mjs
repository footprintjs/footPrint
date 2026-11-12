/**
 * Leak tests, the ones that matter most. For every fault, on its faulty
 * working copy, every tool of every set-up is called with the inputs a model
 * would most likely give it, and:
 * - no answer holds the fault's `find` or `replace` text (or any line of
 *   them long enough to be telling), except `read_file` and `search`, which
 *   read the source itself;
 * - `map`, `step`, `why` and `story` never print a line of source code;
 * - no answer at all (read_file and search included) holds the fault's id or
 *   kind, or anything of a hidden-only order (RULE 1.2's void rule);
 * - the task text does not name the step (harness.test.mjs checks it too).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadFaults } from '../faults/apply.mjs';
import { taskText } from '../harness/prompt.mjs';
import { BENCH_DIR } from '../harness/runtime.mjs';
import { createWorkdir, listFiles, removeWorkdir } from '../harness/workdir.mjs';
import { SETUPS, callTool } from '../tools/index.mjs';

/** What identifies a hidden-only order: its id and its name. */
const HIDDEN_ONLY = Object.entries(JSON.parse(readFileSync(join(BENCH_DIR, 'hidden', 'orders.json'), 'utf8')))
  .filter(([name]) => name.startsWith('hidden-'))
  .flatMap(([name, order]) => [name, order.orderId]);

const RECORD_TOOLS = new Set(['map', 'step', 'why', 'story']);
const SOURCE_READERS = new Set(['read_file', 'search']);

/** The fault's telling texts: find, replace, and each of their lines of 12+ characters. */
function telling(fault) {
  const pieces = [fault.find, fault.replace];
  for (const text of [fault.find, fault.replace]) {
    for (const line of text.split('\n')) if (line.trim().length >= 12) pieces.push(line.trim());
  }
  return [...new Set(pieces.filter((p) => p.trim().length > 0))];
}

/** Code lines of the working copy's src/ (not comments), 16+ characters. */
function codeLines(dir) {
  const lines = new Set();
  for (const rel of listFiles(dir).filter((f) => f.startsWith('src/'))) {
    for (const raw of readFileSync(join(dir, rel), 'utf8').split('\n')) {
      const line = raw.trim();
      if (line.length < 16 || line.startsWith('*') || line.startsWith('/*') || line.startsWith('//')) continue;
      lines.add(line);
    }
  }
  return [...lines];
}

/** The calls a model would make, per tool. */
function callsFor(fault) {
  const { fixture, key } = fault.symptom;
  return [
    ['list_files', {}], ['run_order', { fixture }], ['run_tests', {}], ['done', { summary: 'x' }],
    ['map', {}], ['map', { address: 'tax' }], ['map', { address: fault.stepAddress }],
    ['step', { address: fault.stepAddress }], ['step', { address: fault.stepAddress, fixture }],
    ['why', { fixture, key }], ['why', { fixture, key: 'grandTotal' }], ['why', { fixture, key: 'status' }],
    ['story', { fixture }], ['story', { fixture, address: fault.stepAddress }], ['story', { fixture, address: 'tax' }],
    ['read_file', { path: fault.file }], ['search', { pattern: fault.find.split('\n')[0].trim().slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }],
  ];
}

for (const fault of loadFaults()) {
  test(`fault ${fault.id}: no tool outside read_file/search hands over the edit, and record tools print no code`, async () => {
    const work = await createWorkdir(fault);
    try {
      const code = codeLines(work.dir);
      const pieces = telling(fault);
      let sourceReadersSawIt = false;
      for (const setup of [1, 2, 3]) {
        const tools = SETUPS[setup];
        for (const [name, input] of callsFor(fault)) {
          if (!tools.some((t) => t.definition.name === name)) continue;
          const answer = await callTool(tools, name, input, { workdir: work.dir });
          for (const secret of [fault.id, fault.kind, ...HIDDEN_ONLY]) {
            assert.ok(!answer.content.includes(secret), `set-up ${setup} ${name} names ${JSON.stringify(secret)}`);
          }
          if (SOURCE_READERS.has(name)) {
            if (pieces.some((p) => answer.content.includes(p))) sourceReadersSawIt = true;
            continue;
          }
          for (const p of pieces) assert.ok(!answer.content.includes(p), `set-up ${setup} ${name} ${JSON.stringify(input)} holds ${JSON.stringify(p)}`);
          if (RECORD_TOOLS.has(name)) {
            for (const line of code) assert.ok(!answer.content.includes(line), `${name} ${JSON.stringify(input)} prints source: ${line}`);
          }
        }
      }
      assert.ok(sourceReadersSawIt, 'read_file of the faulty file shows the edit (the control: the check can see it)');
      assert.ok(!taskText(fault).includes(fault.stepAddress));
    } finally {
      removeWorkdir(work.dir);
    }
  });
}
