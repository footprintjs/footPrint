/**
 * `step`: one step's card: its kind, where its code is, its purpose, and,
 * with a fixture, what it read and wrote in that run (key names and short
 * value summaries) and, for a decision, the rules it weighed by label.
 *
 * It never prints source code, only the path of the file.
 * Example: `step('check-credit', 'harbour-chairs')` → `code: src/steps/check-credit/index.mjs`, then
 * `run check-credit#19: read customer = {…}, grandTotal = 1864.08; wrote runs.check-credit.creditOk = true …`.
 */
import { addressOf, committedKeys, describeDecision, readKeysOf, writesOf } from './run-record.mjs';
import { allPlaces, codeFiles, placesOf } from './structure.mjs';
import { summarize } from './summary.mjs';

/** Executions of one address shown at most; a loop can run a step many times. */
const MAX_EXECUTIONS = 6;

/**
 * @param {string} workdir
 * @param {any} chart
 * @param {string} address
 * @param {import('./run-record.mjs').RunRecord} [record]
 * @param {string} [fixture]
 */
export async function renderStep(workdir, chart, address, record, fixture) {
  const places = allPlaces(await placesOf(workdir, chart.buildTimeStructure));
  const place = places.find((p) => p.address === address);
  if (!place) throw new Error(`no step has the address "${address}"; call map() for the list`);
  const lines = [`step ${place.address}`, `kind: ${place.kind}${place.parent ? ` (of ${place.parent})` : ''}`];
  const files = codeFiles(workdir, address);
  lines.push(`code: ${files.length > 0 ? files.join(', ') : '(no file found for this address)'}`);
  lines.push(`purpose: ${place.purpose}`);
  if (place.branches) lines.push(`branches: ${place.branches.join(', ')}`);
  if (place.loopTo) lines.push(`after it runs, the chart goes back to ${place.loopTo}`);
  if (place.inner) lines.push(`steps inside: ${place.inner.map((p) => p.address).join(', ')}`);
  if (place.kind === 'parallel branch') lines.push(`its writes land under runs.${place.address}.<key>`);
  if (!record) {
    if (place.kind === 'decision') lines.push('rule labels: give a fixture; they come from the run\'s decision record.');
    return lines.join('\n');
  }
  const runs = record.order.filter((id) => addressOf(id) === address);
  lines.push(`In the run of fixture ${fixture}: ${runs.length === 0 ? 'this step did not run.' : `ran ${runs.length} time(s).`}`);
  for (const id of runs.slice(0, MAX_EXECUTIONS)) {
    const reads = dedupe(record.reads.get(id) ?? []);
    const writes = writesOf(record, id, committedKeys(record, id));
    lines.push(`run ${id}:`);
    const readText = reads.length
      ? reads.map((r) => `${r.key} = ${summarize(r.value)}`).join('; ')
      : readKeysOf(record, id).join(', ') || '(nothing)';
    lines.push(`  read: ${readText}`);
    lines.push(`  wrote: ${writes.length ? writes.map((w) => `${w.key} = ${summarize(w.value)}`).join('; ') : '(nothing)'}`);
    const decision = record.decisions.get(id);
    if (decision) lines.push(`  decision: ${describeDecision(decision)}`);
  }
  if (runs.length > MAX_EXECUTIONS) lines.push(`(${runs.length - MAX_EXECUTIONS} more runs of this step not shown)`);
  if (record.failure) lines.push(`The run failed: ${record.failure}`);
  return lines.join('\n');
}

/** Keeps the last value seen for each key, in first-seen order. @param {{key: string, value: unknown}[]} items */
function dedupe(items) {
  const byKey = new Map();
  for (const item of items) byKey.set(item.key, item);
  return [...byKey.values()];
}
