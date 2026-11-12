/**
 * `map`: the chart one level deep, one line per step:
 * `address · kind · purpose`. A sub-flowchart is one collapsed line until
 * its address is asked for.
 *
 * Example line: `more-lines · decision (branches: next-line, lines-priced) · Decide whether another line is left to price.`
 */
import { allPlaces, placesOf } from './structure.mjs';

/** @param {import('./structure.mjs').Place} p */
function line(p) {
  const indent = p.level > 0 ? '  ' : '';
  let kind = p.kind;
  if (p.kind === 'decision' && p.branches) kind = `decision (branches: ${p.branches.join(', ')})`;
  if (p.kind === 'branch') kind = `branch of ${p.parent}${p.loopTo ? `, then back to ${p.loopTo}` : ''}`;
  if (p.kind === 'parallel branch') kind = `parallel branch after ${p.parent}`;
  if (p.kind === 'sub-flowchart') kind = `sub-flowchart, ${p.inner?.length ?? 0} steps (ask map("${p.address}"))`;
  if (p.parallel) kind = `stage, then in parallel: ${p.parallel.join(', ')}`;
  return `${indent}${p.address} · ${kind} · ${p.purpose}`;
}

/**
 * @param {string} workdir
 * @param {any} chart
 * @param {string} [address]
 */
export async function renderMap(workdir, chart, address) {
  const places = await placesOf(workdir, chart.buildTimeStructure);
  if (!address) {
    return ['The chart, in run order (addresses are the ids the run record uses):', ...places.map(line)].join('\n');
  }
  const place = allPlaces(places).find((p) => p.address === address);
  if (!place) throw new Error(`no step has the address "${address}"; call map() for the list`);
  if (place.kind === 'sub-flowchart') {
    return [`Inside ${place.address} (${place.purpose}):`, ...(place.inner ?? []).map(line)].join('\n');
  }
  const lines = [line({ ...place, level: 0 })];
  if (place.branches) {
    for (const b of allPlaces(places).filter((p) => p.parent === place.address)) lines.push(line(b));
  }
  return lines.join('\n');
}
