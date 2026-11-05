/** Declared one-engine copy relations over existing complete snapshot identity graphs. */
import { equal, refuse } from '../../../readLawWitness.js';
import type { NativeFact, ValueFact } from '../../../readWitness.js';
import type { FixtureCall } from '../../types.js';
import {
  completeIdentityRows,
  copiedMembers,
  freshLiteral,
  objectKind,
  rows,
  sameCopiedMembers,
} from '../branchFacts.js';
import type { Profile } from './profiles.js';
import type { Projection } from './project.js';

type Identity = { readonly path: readonly string[]; readonly object: number };
const prefix = (a: readonly string[], b: readonly string[]) =>
  a.length <= b.length && a.every((part, i) => part === b[i]);
const at = (rows: readonly Identity[], path: readonly string[]) => {
  const exact = rows.filter((row) => equal(row.path, path));
  return exact.length === 1 ? exact[0].object : refuse('projection identity root/path is missing or ambiguous');
};
function valueAt(value: ValueFact, path: readonly string[]): ValueFact {
  for (const key of path) {
    const found = rows(value).filter((row) => row[0] === key);
    if (found.length !== 1) return refuse('projection identity path has no unique captured value');
    value = found[0][2];
  }
  return value;
}
function literalIsLocal(
  read: NativeFact,
  call: FixtureCall,
  projection: Projection,
  argument: readonly Identity[],
): void {
  if (!objectKind(projection.literal)) return;
  const path = projection.literalAt;
  if (!path) return refuse('projection literal has no declared placement');
  freshLiteral(read, call, { at: path, value: projection.literal });
  const selected = argument.filter((row) => prefix(path, row.path));
  const otherIds = new Set(argument.filter((row) => !prefix(path, row.path)).map((row) => row.object));
  if (selected.some((row) => otherIds.has(row.object)))
    return refuse('projection literal shares an output identity with a copied/container subtree');
}
function deepPrefix(
  read: NativeFact,
  call: FixtureCall,
  before: readonly Identity[],
  after: readonly Identity[],
): void {
  const beforeIds = new Set(before.map((row) => row.object));
  if (after.some((row) => beforeIds.has(row.object)))
    return refuse('deep-copy prefix/output shares an identity with the read graph');
  const mapping = new Map<number, number>();
  const reverse = new Map<number, number>();
  for (const row of before) {
    const target = at(after, row.path); // Existing array indices and outer root, never an equality search.
    const existing = mapping.get(row.object);
    const prior = reverse.get(target);
    if ((existing !== undefined && existing !== target) || (prior !== undefined && prior !== row.object))
      return refuse('deep-copy prefix changed its local alias partition');
    mapping.set(row.object, target);
    reverse.set(target, row.object);
    for (const other of before) {
      if (other.object !== row.object || other === row) continue;
      if (
        prefix(other.path, row.path) ||
        prefix(row.path, other.path) ||
        !equal(valueAt(read.result!, other.path), valueAt(read.result!, row.path))
      )
        return refuse('deep-copy graph has cyclic or inconsistent captured aliases');
    }
  }
  // The write value was already compared to the declared deep-copy/push value on THIS engine.
  // The ID map establishes observed disjoint copy identities, never provenance inferred from content.
}
function changedElement(
  read: NativeFact,
  call: FixtureCall,
  projection: Projection,
  before: readonly Identity[],
  after: readonly Identity[],
): void {
  const selected = projection.selected;
  if (selected === undefined || !projection.literalAt) return refuse('element projection lost its selected path');
  const oldIds = new Set(before.map((row) => row.object));
  const outer = at(after, []);
  const element = at(after, [selected]);
  at(before, [selected]);
  if (outer === element || oldIds.has(outer) || oldIds.has(element))
    return refuse('changed outer/element identity aliases the read or each other');
  for (const row of after) {
    if (!row.path.length || equal(row.path, [selected]) || prefix(projection.literalAt, row.path)) continue;
    if (at(before, row.path) !== row.object)
      return refuse('element surviving subtree is not the original SAME read identity');
  }
}

export function projectionIdentity(
  profile: Profile,
  projection: Projection,
  read: NativeFact,
  call: FixtureCall,
): void {
  const before = completeIdentityRows(read.resultIdentities, read.result!, read.resultObject);
  const after = completeIdentityRows(call.call.identities?.[2], call.call.args[2], call.call.objects[2]);
  switch (profile.identity) {
    case 'shallow-array': {
      if (read.result?.kind !== 'array') {
        if (before.some((row) => row.object === call.call.objects[2]))
          return refuse('absent append container aliases its unused read');
        break;
      }
      const shape = copiedMembers(
        { method: 'setObject', key: '', value: call.call.args[2], identity: 'fresh' },
        read.result!,
      );
      sameCopiedMembers(read, call, shape.copiedRead ?? []);
      break;
    }
    case 'disjoint-deep-prefix':
      deepPrefix(read, call, before, after);
      break;
    case 'changed-element':
      changedElement(read, call, projection, before, after);
      break;
    case 'literal-payload':
      break; // The WHOLE literal payload is checked below; no old object was written.
  }
  literalIsLocal(read, call, projection, after);
}
