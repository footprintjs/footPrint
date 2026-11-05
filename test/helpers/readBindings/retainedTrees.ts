import type { RetainedSite } from '../readLawWitness.js';
import { ownsFinalSlot } from '../readLawWitness.js';
import type { NativeFact } from '../readWitness.js';
import { type ObservedKept, equal, own } from './types.js';

interface Node {
  field: string;
  line?: number;
  treeRoot?: readonly string[];
  path: readonly (string | number)[];
  value: unknown;
}
function roots(field: string, text: string): { value: unknown; line?: number; treeRoot?: readonly string[] }[] {
  if (field === 'snapshots')
    return text === '' ? [] : text.split('\n').map((line, i) => ({ value: JSON.parse(line), line: i }));
  if (field === 'executionTree' || /^cp[1-9]\d*\.tree$/.test(field)) return [{ value: JSON.parse(text) }];
  if (field !== 'subflowResults' && field !== 'redactedSubflows') return [];
  const parsed: unknown = JSON.parse(text);
  if (parsed === null) return [];
  if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Unknown subflow retention shape.');
  return Object.keys(parsed).flatMap((key) => {
    const tree = own(own(own(parsed, key), 'treeContext'), 'stageContexts');
    return tree === undefined ? [] : [{ value: tree, treeRoot: [key, 'treeContext', 'stageContexts'] }];
  });
}
function nodes(run: ObservedKept): Node[] {
  const found: Node[] = [];
  for (const [field, text] of Object.entries(run.kept)) {
    for (const root of roots(field, text)) {
      const work: { value: unknown; path: readonly (string | number)[] }[] = [{ value: root.value, path: [] }];
      while (work.length) {
        const next = work.pop()!;
        if (next.value === null || typeof next.value !== 'object' || Array.isArray(next.value))
          throw new Error('Unknown retained stage-tree shape.');
        found.push({ field, line: root.line, treeRoot: root.treeRoot, ...next });
        const child = own(next.value, 'next');
        const children = own(next.value, 'children');
        if (child !== undefined) work.push({ value: child, path: [...next.path, 'next'] });
        if (children !== undefined) {
          if (!Array.isArray(children)) throw new Error('Unknown retained child-tree shape.');
          children.forEach((value, index) => work.push({ value, path: [...next.path, 'children', index] }));
        }
      }
    }
  }
  return found;
}
function nativeOwner(run: ObservedKept, node: Node, read: NativeFact): boolean {
  if (own(node.value, 'id') !== read.header?.stageId) return false;
  const runtime = read.header?.runtimeStageId;
  if (runtime && own(node.value, 'runtimeStageId') !== runtime) return false;
  const owners = new Set(
    run.native.events
      .filter(
        (event) =>
          event.frame !== undefined &&
          event.header?.stageId === read.header?.stageId &&
          event.header?.runtimeStageId === runtime,
      )
      .map((event) => event.frame),
  );
  if (owners.size !== 1 || !owners.has(read.frame))
    throw new Error('Retained stage identity has ambiguous native frames.');
  return true;
}

/** Only declared stage-tree surfaces, including an ended leg's separately retained cpN.tree.
 * Live heaps/history/folds/the checkpoint itself are never searched or projected. */
export function retainedSites(a: ObservedKept, b: ObservedKept, x: NativeFact, y: NativeFact): RetainedSite[] {
  if (!x.retention || !y.retention) return [];
  if (x.retention.key !== y.retention.key) throw new Error('Different retained keys at paired native read.');
  const ownsA = ownsFinalSlot(a.native, x);
  const ownsB = ownsFinalSlot(b.native, y);
  if (!ownsA || !ownsB) return [];
  const right = nodes(b);
  const result: RetainedSite[] = [];
  for (const node of nodes(a)) {
    if (!nativeOwner(a, node, x)) continue;
    const reads = own(node.value, 'stageReads');
    if (!reads || !Object.hasOwn(reads as object, x.retention.key)) continue;
    const matches = right.filter(
      (candidate) =>
        candidate.field === node.field &&
        candidate.line === node.line &&
        equal(candidate.treeRoot, node.treeRoot) &&
        equal(candidate.path, node.path),
    );
    if (
      matches.length !== 1 ||
      !nativeOwner(b, matches[0], y) ||
      !Object.hasOwn(own(matches[0].value, 'stageReads') as object, y.retention.key)
    )
      throw new Error('Missing paired retained stage slot.');
    result.push({
      kind: 'stage-read',
      field: node.field,
      ...(node.line === undefined ? {} : { line: node.line }),
      ...(node.treeRoot === undefined ? {} : { treeRoot: node.treeRoot }),
      nodePath: node.path,
      baseline: x.retention,
      build: y.retention,
    } as RetainedSite);
  }
  return result;
}
