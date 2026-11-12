/**
 * Asks the record probe (tools/record/probe.mjs, run from the runtime folder)
 * one question about the working copy, in a confined child process with
 * limits; the answer comes back as text and the working copy is never
 * imported into the harness process.
 * Example: `await askProbe(dir, { op: 'why', fixture: 'school-paper', key: 'grandTotal' })` → text.
 */
import { join } from 'node:path';

import { runNode } from '../../harness/child.mjs';
import { ensureRuntime, importHookArgs } from '../../harness/runtime.mjs';

const MARKER = '\u0000agent-debug-probe-answer\u0000';

/**
 * @param {string} workdir
 * @param {Record<string, unknown>} request
 * @returns {Promise<string>} the answer; throws with the probe's message when it failed
 */
export async function askProbe(workdir, request) {
  const probe = join(ensureRuntime(), 'record', 'probe.mjs');
  // The probe builds and runs the working copy's chart: model-edited code.
  // It may read the copy and the runtime, and write nothing.
  const child = await runNode([...importHookArgs(), probe, workdir, JSON.stringify(request)], {
    cwd: workdir,
    confine: { read: [workdir, ensureRuntime()], write: [] },
    timeoutMs: 30_000,
  });
  if (child.timedOut) throw new Error('the run took longer than the time limit (30 s) and was stopped');
  const at = child.stdout.lastIndexOf(MARKER);
  if (at < 0) {
    const tail = child.stderr.split('\n').filter(Boolean).slice(0, 6).join('\n');
    throw new Error(`the program could not be loaded or run:\n${tail}`);
  }
  const answer = JSON.parse(child.stdout.slice(at + MARKER.length).trim());
  if (!answer.ok) throw new Error(answer.text);
  return answer.text;
}
