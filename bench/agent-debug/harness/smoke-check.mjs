/**
 * The smoke batch's pass (RULE.md 1.5): what it must show before the 90
 * runs, answered from the batch folder's own files. Each line is "yes" or
 * "no" with the numbers behind it. A "no" does not change the smoke run's
 * exit code; it is what the owner reads before the 90.
 *
 * - every response carried the API's usage numbers, thinking included;
 * - no run ended at the output limit (`max_tokens`);
 * - every retry is in its transcript: the retries each run counted equal the
 *   `retry` lines of its transcript;
 * - order.json records the commit, a tree with no uncommitted change, and the
 *   installed footprintjs version;
 * - the spend in the report equals the sum of the usage in the transcripts.
 * Example line: `- no run ended at the output limit: yes (0 of 3 runs ended at max_tokens)`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readRuns } from './batch.mjs';
import { costOf } from './budget.mjs';

/** The events of one transcript (a line cut by a stop is skipped). */
function eventsOf(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const yes = (/** @type {boolean} */ ok) => (ok ? 'yes' : 'no');
const isCount = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * @param {string} out the smoke batch's folder
 * @returns {string[]} the checklist, one Markdown list line each
 */
export function smokeChecklist(out) {
  const runs = readRuns(join(out, 'runs.jsonl'));
  const order = JSON.parse(readFileSync(join(out, 'order.json'), 'utf8'));
  const perRun = runs.map((row) => ({ row, events: eventsOf(join(out, row.transcript ?? '')) }));
  const responses = perRun.flatMap((r) => r.events.filter((e) => e.type === 'response'));
  const withUsage = responses.filter((e) => isCount(e.usage?.input_tokens) && isCount(e.usage?.output_tokens)).length;
  const withThinking = responses.filter((e) => isCount(e.usage?.output_tokens_details?.thinking_tokens)).length;
  const atLimit = runs.filter((r) => r.stopReason === 'max_tokens').length;
  const retryLines = perRun.reduce((sum, r) => sum + r.events.filter((e) => e.type === 'retry').length, 0);
  const retriesCounted = runs.reduce((sum, r) => sum + (r.retries ?? 0), 0);
  const retriesMatch = perRun.every((r) => (r.row.retries ?? 0) === r.events.filter((e) => e.type === 'retry').length);
  const code = order.code ?? {};
  const fp = order.versions?.footprintjs ?? null;
  const recorded = typeof code.commit === 'string' && code.uncommittedChanges === false && typeof fp === 'string';
  const rowsIn = runs.reduce((s, r) => s + r.inputTokens, 0);
  const rowsOut = runs.reduce((s, r) => s + r.outputTokens, 0);
  const logIn = responses.reduce((s, e) => s + (e.usage?.input_tokens ?? 0), 0);
  const logOut = responses.reduce((s, e) => s + (e.usage?.output_tokens ?? 0), 0);
  const spendRows = costOf({ input_tokens: rowsIn, output_tokens: rowsOut });
  const spendLogs = costOf({ input_tokens: logIn, output_tokens: logOut });
  return [
    `- every response carried the usage numbers, thinking included: ${yes(responses.length > 0 && withUsage === responses.length && withThinking === responses.length)} (${withUsage} of ${responses.length} responses carried input and output tokens; ${withThinking} of ${responses.length} carried thinking tokens)`,
    `- no run ended at the output limit: ${yes(atLimit === 0)} (${atLimit} of ${runs.length} runs ended at max_tokens)`,
    `- every retry is in its transcript: ${yes(retriesMatch)} (${retriesCounted} retries counted by the runs, ${retryLines} retry lines in the transcripts)`,
    `- the commit, a clean tree and the footprintjs version are recorded: ${yes(recorded)} (commit ${code.commit ?? 'none'}, uncommitted changes ${code.uncommittedChanges ?? 'unknown'}, footprintjs ${fp ?? 'unknown'}, foottrace ${order.versions?.foottrace ?? 'unknown'})`,
    `- the spend equals the sum of the usage in the transcripts: ${yes(rowsIn === logIn && rowsOut === logOut)} (runs.jsonl ${rowsIn} in + ${rowsOut} out = ${spendRows.toFixed(6)} dollars; transcripts ${logIn} in + ${logOut} out = ${spendLogs.toFixed(6)} dollars)`,
  ];
}
