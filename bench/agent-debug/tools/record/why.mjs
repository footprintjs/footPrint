/**
 * `why`: the chain of steps behind a key's final value in one run of the
 * working copy. Each link names the step, what it wrote (short summaries),
 * the keys it read, and for a decision which rule matched. A sub-flowchart
 * link also shows what its own steps wrote.
 *
 * From the run's own record through the published readers (walk.mjs).
 * Example first line: `grandTotal = 78.05, written last by grand-total#17.`
 */
import { addressOf, describeDecision, writesOf } from './run-record.mjs';
import { summarize } from './summary.mjs';
import { walkBack } from './walk.mjs';

/**
 * @param {import('./run-record.mjs').RunRecord} record
 * @param {string} fixture
 * @param {string} key
 */
export function renderWhy(record, fixture, key) {
  const walk = walkBack(record, key);
  if (!walk) {
    const known = Object.keys(record.snapshot.sharedState ?? {}).sort().join(', ');
    throw new Error(`no step wrote "${key}" in the run of ${fixture}. Keys in the final state: ${known}`);
  }
  const final = record.snapshot.sharedState?.[key];
  const lines = [`${key} = ${summarize(final)} at the end of the run of ${fixture}, written last by ${walk.writer}.`];
  lines.push('The steps behind it, nearest first (depth = links from the writer):');
  for (const node of walk.nodes) {
    const writes = writesOf(record, node.id, node.wrote);
    // A mapper's reads are not scope reads; the reader's data edges name them.
    const readKeys = [...new Set([
      ...(record.reads.get(node.id) ?? []).map((r) => r.key),
      ...node.parents.filter((e) => e.kind === 'data' && e.key).map((e) => /** @type {string} */ (e.key)),
    ])];
    const feeds = node.parents
      .filter((e) => e.kind === 'control')
      .map((e) => `under decision ${e.parent}${e.key ? ` ("${e.key}")` : ''}`);
    let text = `[${node.depth}] ${node.id} wrote ${writes.length ? writes.map((w) => `${w.key} = ${summarize(w.value, 80)}`).join(', ') : '(nothing)'}`;
    text += `; read ${readKeys.length ? readKeys.join(', ') : '(nothing)'}`;
    if (feeds.length) text += `; ${feeds.join(', ')}`;
    lines.push(text);
    const decision = record.decisions.get(node.id);
    if (decision) lines.push(`    decision: ${describeDecision(decision)}`);
    for (const inner of record.order.filter((id) => id.startsWith(`${addressOf(node.id)}/`))) {
      const innerWrites = writesOf(record, inner);
      const innerReads = [...new Set((record.reads.get(inner) ?? []).map((r) => `${r.key} = ${summarize(r.value, 40)}`))];
      lines.push(`    inside: ${inner} wrote ${innerWrites.map((w) => `${w.key} = ${summarize(w.value, 60)}`).join(', ') || '(nothing)'}; read ${innerReads.join(', ') || '(nothing)'}`);
    }
  }
  if (walk.truncated) lines.push('(the walk was cut by its limit; older steps are not shown)');
  if (record.failure) lines.push(`The run failed: ${record.failure}`);
  return lines.join('\n');
}
