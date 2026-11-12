/**
 * The chart's shape, read from the BUILT chart of the working copy
 * (`chart.buildTimeStructure`), never from a hand-written list.
 *
 * One address scheme for every record tool: the ids the run record uses.
 * A step inside a sub-flowchart is `<mount>/<step>` (for example
 * `tax/find-rate`), exactly as its record id.
 * Example: `addressesOf(chart)` → `[{ address: 'receive-order', kind: 'stage', … }, …]`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {object} Place
 * @property {string} address      the record id
 * @property {string} kind         stage | decision | branch | parallel branch | sub-flowchart
 * @property {string} purpose      the one-line purpose
 * @property {number} level        0 for the main line, 1 for a branch or a parallel branch
 * @property {string} [parent]     the decision or stage it hangs from
 * @property {string[]} [branches] a decision's branch ids
 * @property {string} [loopTo]     a branch that loops back to this address
 * @property {string[]} [parallel] a stage followed by parallel branches
 * @property {string} [mount]      the sub-flowchart it belongs to
 * @property {Place[]} [inner]     a sub-flowchart's own places
 */

/** The code file(s) of an address in a working copy, as `src/...` paths. */
export function codeFiles(workdir, address) {
  const parts = address.split('/');
  /** @type {string[]} */
  const candidates =
    parts.length === 1
      ? [`src/steps/${parts[0]}/index.mjs`, `src/subflows/${parts[0]}/chart.mjs`, `src/subflows/${parts[0]}/mappers.mjs`]
      : [`src/subflows/${parts[0]}/steps/${parts.slice(1).join('/')}/index.mjs`];
  return candidates.filter((rel) => existsSync(join(workdir, rel)));
}

/** A parallel branch declares no description; its step module's `purpose` is the same text. */
async function purposeOf(workdir, node, mount) {
  if (node.description) return node.description;
  const address = mount ? `${mount}/${node.id}` : node.id;
  for (const rel of codeFiles(workdir, address)) {
    try {
      const mod = await import(pathToFileURL(join(workdir, rel)).href);
      if (typeof mod.purpose === 'string') return mod.purpose;
    } catch {
      // A broken step file has no purpose to read; the map says so below.
    }
  }
  return node.subflowName ? `the ${node.subflowName} sub-flowchart` : '(no purpose given)';
}

/**
 * Lists the places of a structure's main line, in order.
 * @param {string} workdir
 * @param {any} root a SerializedPipelineStructure
 * @param {string} [mount] the sub-flowchart these places belong to
 * @returns {Promise<Place[]>}
 */
export async function placesOf(workdir, root, mount) {
  /** @type {Place[]} */
  const places = [];
  const at = (/** @type {string} */ id) => (mount ? `${mount}/${id}` : id);
  let guard = 0;
  for (let node = root; node && guard < 500; node = node.next, guard++) {
    if (node.isLoopReference) break;
    const address = at(node.id);
    if (node.isSubflowRoot || node.subflowStructure) {
      places.push({
        address,
        kind: 'sub-flowchart',
        level: 0,
        purpose: await purposeOf(workdir, node, mount),
        inner: node.subflowStructure ? await placesOf(workdir, node.subflowStructure, address) : [],
        ...(mount ? { mount } : {}),
      });
      continue;
    }
    const isDecision = node.type === 'decider' || node.hasDecider;
    const children = (node.children ?? []).filter((c) => !c.isLoopReference);
    const parallel = !isDecision && children.length > 0 ? children.map((c) => at(c.id)) : undefined;
    places.push({
      address,
      kind: isDecision ? 'decision' : 'stage',
      level: 0,
      purpose: await purposeOf(workdir, node, mount),
      ...(isDecision ? { branches: children.map((c) => at(c.id)) } : {}),
      ...(parallel ? { parallel } : {}),
      ...(mount ? { mount } : {}),
    });
    for (const child of children) {
      const loopRef = child.next && child.next.isLoopReference ? child.next.id : child.loopTarget;
      places.push({
        address: at(child.id),
        kind: isDecision ? 'branch' : 'parallel branch',
        level: 1,
        parent: address,
        purpose: await purposeOf(workdir, child, mount),
        ...(loopRef ? { loopTo: at(loopRef) } : {}),
        ...(mount ? { mount } : {}),
      });
    }
  }
  return places;
}

/** Every place, sub-flowchart places included, flattened. @param {Place[]} places */
export function allPlaces(places) {
  return places.flatMap((p) => [p, ...(p.inner ? allPlaces(p.inner) : [])]);
}

/** Loads the working copy's chart. */
export async function loadChart(workdir) {
  const mod = await import(pathToFileURL(join(workdir, 'src', 'chart.mjs')).href);
  return mod.buildChart();
}
