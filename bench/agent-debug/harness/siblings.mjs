/**
 * The other part 2 batches kept beside a batch folder (RULE-2.md, "What
 * decides": every batch of part 2 is kept, and the report of a later batch
 * names each earlier one with its decision line).
 *
 * Why: a batch that came out "No decision" (or one somebody did not like) is
 * followed by a new batch. If the new report said nothing of the old one, the
 * old outcome would live only in a promise of the rule; the fifth fairness
 * reading asked for it to be printed.
 *
 * What counts, read from each folder's own files only:
 * - a folder in the same parent folder as this batch, holding `order.json`;
 * - of part 2: its order.json lists `questions` (part 1 never writes that
 *   field; a part 2 batch run with `--tasks` naming faults only is not found);
 * - not a smoke batch (order.json's label);
 * - not a rehearsal: a folder whose started and finished runs were ALL run by
 *   the scripted model (model.mjs · SCRIPTED_MODEL) is a rehearsal. A folder
 *   with no run at all cannot be told apart and is listed.
 * When it started: the earliest `at` in its started.jsonl (written before a
 * run's first request), never the clock now; "not known" when no run started.
 * A folder whose order.json cannot be read, or whose decision cannot be read
 * from its files (its `decide` throws: an order.json whose `plan` is not a
 * list, say), is listed as unreadable with the first line of the error. It
 * never stops the report of the batch beside it (sixth fairness reading).
 * What this cannot know: a folder moved out of the parent folder or deleted,
 * and a batch run in another parent folder.
 * Example: `otherBatches('/b/two', decide)` →
 * `[{ name: 'one', started: '2026-11-14T09:00:00.000Z', decision: { line: 'Stop and look: …' } }]`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { readRuns } from './batch.mjs';
import { SCRIPTED_MODEL } from './model.mjs';

/** When a batch folder's first run started, as an ISO time, or undefined. @param {string} folder */
export function startedAt(folder) {
  const times = readRuns(join(folder, 'started.jsonl')).map((r) => r.at).filter((t) => Number.isFinite(t));
  return times.length ? new Date(Math.min(...times)).toISOString() : undefined;
}

/** Whether every run a folder started or finished was the scripted model's (a rehearsal). @param {string} folder */
export function isRehearsal(folder) {
  const models = [...readRuns(join(folder, 'started.jsonl')), ...readRuns(join(folder, 'runs.jsonl'))].map((r) => r.model);
  return models.length > 0 && models.every((m) => m === SCRIPTED_MODEL);
}

/**
 * The part 2 batches beside `folder` (same parent, not itself), by start
 * time (not known last), then by name.
 * @template D
 * @param {string} folder
 * @param {(folder: string) => D} decide the decision of a folder, from its own files (report2.mjs · decisionOf)
 * @returns {{ name: string, started?: string, decision?: D, unreadable?: string }[]}
 */
export function otherBatches(folder, decide) {
  const own = resolve(folder);
  const parent = dirname(own);
  const found = [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === basename(own)) continue;
    const dir = join(parent, entry.name);
    const orderFile = join(dir, 'order.json');
    if (!existsSync(orderFile)) continue;
    let order;
    try {
      order = JSON.parse(readFileSync(orderFile, 'utf8'));
    } catch {
      found.push({ name: entry.name, started: startedAt(dir), unreadable: 'its order.json cannot be read, so whether it is a part 2 batch is not known.' });
      continue;
    }
    const part2 = Array.isArray(order?.questions) && order.questions.length > 0;
    if (!part2 || order.label === 'smoke' || isRehearsal(dir)) continue;
    try {
      found.push({ name: entry.name, started: startedAt(dir), decision: decide(dir) });
    } catch (error) {
      const first = String(error instanceof Error ? error.message : error).split('\n')[0];
      found.push({ name: entry.name, started: startedAt(dir), unreadable: `its files cannot be read (${first}), so its decision is not known.` });
    }
  }
  const byStart = (/** @type {{ started?: string }} */ x, /** @type {{ started?: string }} */ y) => (x.started === y.started ? 0 : x.started === undefined ? 1 : y.started === undefined ? -1 : x.started < y.started ? -1 : 1);
  return found.sort((x, y) => byStart(x, y) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}
