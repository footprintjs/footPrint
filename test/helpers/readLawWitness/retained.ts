import type { ValueFact } from '../readWitness.js';
import { type CheckedRead, type RetainedSite, type Segment, equal, refuse } from './types.js';

const own = (value: unknown, key: PropertyKey) => {
  if (value === null || typeof value !== 'object') return refuse('missing retained owner');
  const d = Object.getOwnPropertyDescriptor(value, key);
  return d && Object.hasOwn(d, 'value') ? d.value : refuse('missing own retained slot');
};
/** This is fixture serialization only, not an engine read, merge or retention implementation. */
export function delivered(fact: ValueFact): unknown {
  switch (fact.kind) {
    case 'undefined':
      return '«undefined»';
    case 'null':
      return null;
    case 'string':
    case 'boolean':
      return fact.value;
    case 'number': {
      if (typeof fact.value !== 'string') return refuse('unsupported number observation');
      const n = fact.value === '-0' ? -0 : Number(fact.value);
      return Number.isFinite(n) ? n : null;
    }
    case 'date':
      return `«date:${String(fact.value)}»`;
    case 'array':
    case 'object': {
      const array = fact.kind === 'array';
      if (array && !(Number.isSafeInteger(fact.value) && (fact.value as number) >= 0))
        return refuse('unsupported array observation');
      const out: Record<string, unknown> | unknown[] = array ? new Array(fact.value as number) : Object.create(null);
      for (const item of fact.entries ?? []) {
        if (!Array.isArray(item) || item.length !== 3 || typeof item[0] !== 'string' || typeof item[1] !== 'boolean')
          return refuse('unsupported own-value observation');
        if (!item[1]) continue;
        if (array && !/^(0|[1-9]\d*)$/.test(item[0])) return refuse('array expando not in closed delivery proof');
        Object.defineProperty(out, item[0], {
          value: delivered(item[2] as ValueFact),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    default:
      return refuse('unsupported fixture serialization');
  }
}

function canonicalLine(text: string, line: number | undefined): { lines: string[]; line: number; value: unknown } {
  const lines = text.split('\n');
  const i = line ?? 0;
  if (!Number.isSafeInteger(i) || i < 0 || i >= lines.length || (line === undefined && lines.length !== 1))
    return refuse('invalid retained line');
  let value: unknown;
  try {
    value = JSON.parse(lines[i]);
  } catch {
    return refuse('retained value is not canonical fixture JSON');
  }
  if (JSON.stringify(value) !== lines[i]) return refuse('refusing to normalize retained bytes');
  return { lines, line: i, value };
}
function nodeAt(root: unknown, path: readonly Segment[]): unknown {
  let node = root;
  for (let i = 0; i < path.length; i++) {
    if (path[i] === 'next') node = own(node, 'next');
    else if (
      path[i] === 'children' &&
      typeof path[i + 1] === 'number' &&
      Number.isSafeInteger(path[i + 1]) &&
      (path[i + 1] as number) >= 0
    ) {
      node = own(own(node, 'children'), path[++i]);
    } else return refuse('path is not an execution-tree edge');
  }
  return node;
}

/** The selected stage's own record; next/children belong to other stage owners. */
export function retainedStage(text: string, site: Exclude<RetainedSite, { kind: 'read-line' }>): unknown {
  let tree = canonicalLine(text, site.line).value;
  if (site.treeRoot !== undefined) {
    if (site.treeRoot.length !== 3 || site.treeRoot[1] !== 'treeContext' || site.treeRoot[2] !== 'stageContexts')
      return refuse('unknown retained stage-tree root');
    tree = own(own(own(tree, site.treeRoot[0]), 'treeContext'), 'stageContexts');
  }
  const node = nodeAt(tree, site.nodePath);
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return refuse('missing retained stage');
  return Object.fromEntries(Object.entries(node).filter(([name]) => name !== 'next' && name !== 'children'));
}

/** Rewrites one exact observed read leaf in a detached comparison copy; never an output or a root. */
export function projectSite(
  text: string,
  side: 'baseline' | 'build',
  site: RetainedSite,
  checked: CheckedRead,
  replacement?: unknown,
): { text: string; value: unknown; key: string } {
  if (site.kind === 'read-line') {
    const parsed = canonicalLine(text, site.line);
    const native = checked.read.result!;
    const expected = native.kind === 'undefined' || native.kind === 'null' ? null : delivered(native);
    if (!equal(parsed.value, expected)) return refuse('read-list value is not the actual native delivery');
    if (side === 'baseline') parsed.lines[parsed.line] = JSON.stringify(replacement);
    return { text: parsed.lines.join('\n'), value: parsed.value, key: `reads:${site.line}` };
  }
  const subflow = site.field === 'subflowResults' || site.field === 'redactedSubflows';
  if (!subflow && !['executionTree', 'snapshots'].includes(site.field) && !/^cp\d+\.tree$/.test(site.field))
    return refuse('not a closed read-retention field');
  if ((site.field === 'snapshots') !== (site.line !== undefined)) return refuse('wrong snapshot line form');
  const captured = site[side];
  if (
    !captured.eligibility ||
    !['full', 'summary'].includes(captured.eligibility.mode) ||
    !['baseline-own-readTracking', 'build-own-policy'].includes(captured.eligibility.layout) ||
    Object.getOwnPropertyDescriptor(checked.read, 'retention')?.value !== captured ||
    captured.nativeId !== checked.read.id ||
    captured.frame !== checked.read.frame ||
    typeof captured.key !== 'string' ||
    !captured.key.length ||
    (side === 'build' && captured.value.kind !== 'undefined')
  )
    return refuse('retention does not join this actual native read');
  const parsed = canonicalLine(text, site.line);
  let tree = parsed.value;
  if (subflow) {
    if (
      site.treeRoot?.length !== 3 ||
      typeof site.treeRoot[0] !== 'string' ||
      site.treeRoot[1] !== 'treeContext' ||
      site.treeRoot[2] !== 'stageContexts'
    )
      return refuse('not an actual subflow stage-tree root');
    tree = own(own(own(tree, site.treeRoot[0]), 'treeContext'), 'stageContexts');
  } else if (site.treeRoot !== undefined) return refuse('unexpected retained-tree root');
  const node = nodeAt(tree, site.nodePath);
  if (own(node, 'id') !== checked.read.header?.stageId) return refuse('retained stage has another owner');
  const runtime = checked.read.header?.runtimeStageId;
  if (runtime && own(node, 'runtimeStageId') !== runtime) return refuse('retained execution has another owner');
  const reads = own(node, 'stageReads');
  const value = own(reads, captured.key);
  if (!equal(value, delivered(captured.value))) return refuse('retained slot differs from native retention capture');
  if (side === 'baseline') {
    Object.defineProperty(reads, captured.key, {
      value: replacement,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    parsed.lines[parsed.line] = JSON.stringify(parsed.value);
  }
  return {
    text: parsed.lines.join('\n'),
    value,
    key: `${site.field}:${site.line ?? ''}:${JSON.stringify(site.treeRoot)}:${JSON.stringify(
      site.nodePath,
    )}:${JSON.stringify(captured.key)}`,
  };
}
