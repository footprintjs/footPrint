/**
 * The record tools' back end, run in a child process (one per call) because
 * it imports and runs the agent's working copy, which may hang or crash.
 *
 * Usage: `node --import <runtime>/deps/register.mjs probe.mjs <workdir> <request JSON>`.
 * Request: `{ op: 'map'|'step'|'why'|'story'|'distance', fixture?, key?, address? }`.
 * It prints its answer after a marker line, as JSON `{ ok, text }`, so that
 * whatever the program itself prints never mixes into the answer.
 */
import { renderMap } from './map.mjs';
import { recordRun } from './run-record.mjs';
import { renderStep } from './step.mjs';
import { renderStory } from './story.mjs';
import { loadChart } from './structure.mjs';
import { distance } from './walk.mjs';
import { renderWhy } from './why.mjs';

export const MARKER = '\u0000agent-debug-probe-answer\u0000';

async function answer(workdir, request) {
  switch (request.op) {
    case 'map':
      return renderMap(workdir, await loadChart(workdir), request.address);
    case 'step': {
      const record = request.fixture ? await recordRun(workdir, request.fixture) : undefined;
      const chart = record ? record.chart : await loadChart(workdir);
      return renderStep(workdir, chart, request.address, record, request.fixture);
    }
    case 'why':
      return renderWhy(await recordRun(workdir, request.fixture), request.fixture, request.key);
    case 'story':
      return renderStory(await recordRun(workdir, request.fixture), request.address);
    case 'distance':
      return String(distance(await recordRun(workdir, request.fixture), request.key, request.address));
    default:
      throw new Error(`unknown op ${request.op}`);
  }
}

const [workdir, raw] = process.argv.slice(2);
let out;
try {
  out = { ok: true, text: await answer(workdir, JSON.parse(raw)) };
} catch (error) {
  out = { ok: false, text: error instanceof Error ? error.message : String(error) };
}
process.stdout.write(`\n${MARKER}\n${JSON.stringify(out)}\n`);
