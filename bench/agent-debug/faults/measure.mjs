/**
 * Measures every fault on fresh copies and either checks or writes the
 * measured fields of its file: `symptom.expected`, `symptom.actual`,
 * `hiddenTests` and `distance`.
 *
 * Why measured: RULE.md says no number is typed by hand. The fault's edit
 * (`find`, `replace`) and its symptom fixture and key are chosen by a
 * person; everything a run can tell is taken from a run.
 * Run: `node faults/measure.mjs` (check) or `node faults/measure.mjs --write`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseResult, runOrderIn, runTestFile } from '../harness/program.mjs';
import { runHiddenTests } from '../harness/score.mjs';
import { createWorkdir, removeWorkdir } from '../harness/workdir.mjs';
import { askProbe } from '../tools/lib/probe-client.mjs';
import { FAULTS_DIR, loadFaults } from './apply.mjs';

/**
 * Measures one fault.
 * @param {import('./apply.mjs').Fault} fault
 */
export async function measureFault(fault) {
  const clean = await createWorkdir(null);
  const faulty = await createWorkdir(fault);
  try {
    const expected = parseResult((await runOrderIn(clean.dir, fault.symptom.fixture)).stdout)?.[fault.symptom.key];
    const actual = parseResult((await runOrderIn(faulty.dir, fault.symptom.fixture)).stdout)?.[fault.symptom.key];
    const visible = await runTestFile(faulty.dir, 'test/visible.test.mjs');
    const hidden = await runHiddenTests(faulty.dir);
    const distance = Number(
      await askProbe(faulty.dir, { op: 'distance', fixture: fault.symptom.fixture, key: fault.symptom.key, address: fault.stepAddress }),
    );
    return { expected, actual, visibleFailed: visible.failed, visiblePassed: visible.passed.length, hiddenTests: hidden.failed, distance };
  } finally {
    removeWorkdir(clean.dir);
    removeWorkdir(faulty.dir);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes('--write');
  let bad = 0;
  for (const fault of loadFaults()) {
    const m = await measureFault(fault);
    console.log(`${fault.id}: ${fault.symptom.key} ${JSON.stringify(m.expected)} → ${JSON.stringify(m.actual)}, distance ${m.distance}, visible failed ${m.visibleFailed.length}/${m.visiblePassed + m.visibleFailed.length}, hidden failed ${m.hiddenTests.join(' | ')}`);
    if (write) {
      const next = { ...fault, distance: m.distance, symptom: { ...fault.symptom, expected: m.expected, actual: m.actual }, hiddenTests: m.hiddenTests };
      writeFileSync(join(FAULTS_DIR, `${fault.id}.json`), `${JSON.stringify(next, null, 2)}\n`);
    } else if (
      fault.distance !== m.distance ||
      JSON.stringify(fault.symptom.expected) !== JSON.stringify(m.expected) ||
      JSON.stringify(fault.symptom.actual) !== JSON.stringify(m.actual) ||
      JSON.stringify(fault.hiddenTests) !== JSON.stringify(m.hiddenTests)
    ) {
      bad++;
      console.log(`  ↑ differs from faults/${fault.id}.json`);
    }
  }
  process.exitCode = bad ? 1 : 0;
}
