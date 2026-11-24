/**
 * Runs the working copy's chart on one fixture and keeps its record:
 * the commit log, what each step read and wrote (collected by a scope
 * recorder DURING the run), each decision's evidence, the control edges and
 * the narrative.
 *
 * Why collected during the run: that is the library's law (collect during
 * traversal, never post-process), so the tools show what the library gives
 * a user, not something rebuilt afterwards.
 * Example: `const rec = await recordRun(dir, 'school-paper')` →
 * `rec.writes.get('grand-total#17')` = `[{ key: 'grandTotal', value: 78.05 }]`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FlowChartExecutor } from 'footprintjs';
import { commitValueAt, keysReadFromExecutionTree } from 'foottrace';
import { pathSegments } from 'foottrace/paths';
import { controlDepRecorder } from 'footprintjs/trace';

import { loadChart } from './structure.mjs';

/**
 * @typedef {object} RunRecord
 * @property {any} chart
 * @property {any} snapshot                          getSnapshot() after the run
 * @property {Map<string, {key: string, value: unknown}[]>} reads   by runtime stage id
 * @property {Map<string, {key: string, value: unknown}[]>} writes  by runtime stage id
 * @property {Map<string, any>} decisions             decision events by runtime stage id
 * @property {string[]} order                         runtime stage ids in the order they first acted
 * @property {any} control                            the control-dependence recorder
 * @property {Map<string, any>} controlRecords         its decision records (ControlDecisionRecord) by the decision's runtime stage id
 * @property {any[]} narrative                        narrative entries
 * @property {string | undefined} failure             the run's error message, when it failed
 */

/** @param {Map<string, any[]>} map @param {string} id @param {any} item */
function push(map, id, item) {
  const list = map.get(id);
  if (list) list.push(item);
  else map.set(id, [item]);
}

/**
 * @param {string} workdir
 * @param {string} fixture a checked fixture name
 * @returns {Promise<RunRecord>}
 */
export async function recordRun(workdir, fixture) {
  const order = JSON.parse(readFileSync(join(workdir, 'fixtures', `${fixture}.json`), 'utf8')).order;
  return recordOrder(await loadChart(workdir), order);
}

/**
 * Runs a built chart on one order and keeps its record (as `recordRun`).
 * The question generator (questions/observe.mjs) uses it on orders that are
 * not fixtures; the record tools use it through `recordRun`.
 * @param {any} chart a built chart @param {object} order
 * @returns {Promise<RunRecord>}
 */
export async function recordOrder(chart, order) {
  const executor = new FlowChartExecutor(chart);
  const control = controlDepRecorder();
  /** @type {RunRecord['reads']} */ const reads = new Map();
  /** @type {RunRecord['writes']} */ const writes = new Map();
  /** @type {RunRecord['decisions']} */ const decisions = new Map();
  /** @type {string[]} */ const seen = [];
  const note = (/** @type {string|undefined} */ id) => {
    if (id && !seen.includes(id)) seen.push(id);
  };
  executor.setReadTracking('full');
  executor.attachCombinedRecorder(control);
  executor.attachScopeRecorder({
    id: 'agent-debug-reads-writes',
    onRead: (e) => {
      note(e.runtimeStageId);
      push(reads, e.runtimeStageId, { key: e.key, value: e.value });
    },
    onWrite: (e) => {
      note(e.runtimeStageId);
      push(writes, e.runtimeStageId, { key: e.key, value: e.value });
    },
  });
  executor.attachFlowRecorder({
    id: 'agent-debug-decisions',
    onDecision: (e) => {
      const id = e.traversalContext?.runtimeStageId;
      if (id) decisions.set(id, e);
    },
  });
  executor.enableNarrative();
  let failure;
  try {
    await executor.run({ input: { order } });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const snapshot = executor.getSnapshot();
  for (const bundle of snapshot.commitLog) note(bundle.runtimeStageId);
  const controlRecords = new Map(control.getDecisions().map((d) => [d.deciderRuntimeStageId, d]));
  return { chart, snapshot, reads, writes, decisions, order: seen, control, controlRecords, narrative: executor.getNarrativeEntries(), failure };
}

/** The address (stage id with its sub-flowchart path) of a runtime stage id: `tax/find-rate#13` → `tax/find-rate`. */
export function addressOf(runtimeStageId) {
  const at = runtimeStageId.lastIndexOf('#');
  return at < 0 ? runtimeStageId : runtimeStageId.slice(0, at);
}

/**
 * How a decision's label is shown. A decision made by the DEFAULT has no
 * rule label; its decision record carries `defaultLabel` (footprintjs 12.1),
 * shown marked as the default so a reader can tell: `default: "Every line priced"`.
 * @param {any} controlRecord a ControlDecisionRecord, when there is one
 * @param {string} [ruleLabel] a rule label from elsewhere (the walk's edge)
 * @returns {string} the label in quotes, or '' when there is none
 */
export function decisionLabel(controlRecord, ruleLabel) {
  if (controlRecord?.defaultLabel) return `default: "${controlRecord.defaultLabel}"`;
  const label = controlRecord?.ruleLabel ?? ruleLabel;
  return label ? `"${label}"` : '';
}

/**
 * One line per decision: the rules weighed, which matched, and the branch chosen.
 * @param {any} event the onDecision event
 * @param {any} [controlRecord] the decision record of the same execution, for the default's label
 */
export function describeDecision(event, controlRecord) {
  const evidence = event.evidence;
  if (!evidence) return `chose ${event.chosen}`;
  const rules = (evidence.rules ?? []).map((rule) => {
    const conditions = (rule.conditions ?? [])
      .map((c) => `${c.key} ${c.actualSummary} ${c.op} ${JSON.stringify(c.threshold)}`)
      .join(' and ');
    return `"${rule.label ?? `rule ${rule.ruleIndex}`}" (${conditions || 'a function'}) ${rule.matched ? 'matched' : 'did not match'}`;
  });
  const matched = (evidence.rules ?? []).find((rule) => rule.matched);
  const outcome = matched
    ? `chose ${evidence.chosen} by rule "${matched.label ?? matched.ruleIndex}"`
    : `no rule matched, so the default ${evidence.chosen}${controlRecord?.defaultLabel ? ` (${decisionLabel(controlRecord)})` : evidence.defaultLabel ? ` (default: "${evidence.defaultLabel}")` : ''}`;
  return `${outcome}; rules weighed: ${rules.join('; ')}`;
}

/**
 * What one execution wrote, last value per key. The scope recorder sees a
 * stage's own writes; a sub-flowchart mount's merge-back is not a scope
 * write, so for it the values are read from its commits (`commitValueAt`).
 * @param {RunRecord} record
 * @param {string} id runtime stage id
 * @param {string[]} [keys] the keys the commit trace says it wrote
 * @returns {{ key: string, value: unknown }[]}
 */
export function writesOf(record, id, keys = []) {
  const byKey = new Map();
  for (const item of record.writes.get(id) ?? []) byKey.set(item.key, item);
  if (byKey.size > 0 || keys.length === 0) return [...byKey.values()];
  const log = record.snapshot.commitLog;
  let last = -1;
  for (let i = 0; i < log.length; i++) if (log[i].runtimeStageId === id) last = i;
  if (last < 0) return [];
  return keys.map((key) => ({ key, value: commitValueAt(log, last, key) }));
}

/** The keys one execution's commits say it wrote (dotted paths). @param {RunRecord} record @param {string} id */
export function committedKeys(record, id) {
  const keys = new Set();
  for (const bundle of record.snapshot.commitLog) {
    if (bundle.runtimeStageId !== id) continue;
    for (const entry of bundle.trace ?? []) keys.add(pathSegments(entry.path).join('.'));
  }
  return [...keys];
}

/**
 * The keys one execution read: its scope reads, or, for a sub-flowchart
 * mount whose mapper read the parent, what the execution tree recorded.
 * @param {RunRecord} record @param {string} id
 */
export function readKeysOf(record, id) {
  const own = (record.reads.get(id) ?? []).map((r) => r.key);
  if (own.length > 0) return [...new Set(own)];
  return [...(keysReadFromExecutionTree(record.snapshot.executionTree).lookup(id) ?? [])];
}
