/**
 * `story`: the run told step by step, from the library's own narrative,
 * optionally only one step or one sub-flowchart.
 *
 * Example: `story('school-paper', 'tax')` → the lines of the tax sub-flowchart only.
 */
import { addressOf } from './run-record.mjs';

/**
 * @param {import('./run-record.mjs').RunRecord} record
 * @param {string} [address]
 */
export function renderStory(record, address) {
  const entries = record.narrative.filter((entry) => {
    if (!address) return true;
    const id = entry.runtimeStageId ? addressOf(entry.runtimeStageId) : entry.stageId;
    return id === address || (typeof id === 'string' && id.startsWith(`${address}/`)) || entry.subflowId === address;
  });
  if (address && entries.length === 0) throw new Error(`nothing in this run's story has the address "${address}"`);
  const lines = entries.map((entry) => `${'  '.repeat(entry.depth ?? 0)}${entry.text}`);
  if (record.failure) lines.push(`The run failed: ${record.failure}`);
  return lines.join('\n');
}
