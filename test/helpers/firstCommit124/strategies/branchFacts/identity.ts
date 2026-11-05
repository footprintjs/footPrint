import { equal, refuse } from '../../../readLawWitness.js';
import type { IdentityGraph, NativeFact, ValueFact } from '../../../readWitness.js';
import type { FixtureCall } from '../../types.js';
import type { Write } from './types.js';
import { objectId, objectKind, objectPaths, rows } from './values.js';

/** Reads only the existing immutable observer metadata, never native values or equal-content aliases. */
export function identityRows(graph: IdentityGraph | undefined, root: number | undefined) {
  if (!Array.isArray(graph) || graph.length > 10_000 || !objectId(root))
    return refuse('embedded read identity graph/root is missing');
  const out = new Map<string, { path: readonly string[]; object: number }>();
  for (let i = 0; i < graph.length; i++) {
    const row = Object.getOwnPropertyDescriptor(graph, String(i))?.value;
    if (row === null || typeof row !== 'object') return refuse('unreadable embedded identity row');
    const path = Object.getOwnPropertyDescriptor(row, 'path')?.value;
    const object = Object.getOwnPropertyDescriptor(row, 'object')?.value;
    if (!Array.isArray(path) || path.length > 128 || !objectId(object))
      return refuse('unreadable embedded identity path/object');
    const parts: string[] = [];
    for (let j = 0; j < path.length; j++) {
      const part = Object.getOwnPropertyDescriptor(path, String(j))?.value;
      if (typeof part !== 'string') return refuse('non-data embedded identity segment');
      parts.push(part);
    }
    const key = JSON.stringify(parts);
    if (out.has(key)) return refuse('ambiguous embedded identity path');
    out.set(key, { path: parts, object });
  }
  if (out.get('[]')?.object !== root) return refuse('embedded identity graph has a different actual root');
  return [...out.values()];
}
export function sameEmbeddedRead(read: NativeFact, call: FixtureCall, selection: NonNullable<Write['embeddedRead']>) {
  const prefix = (a: readonly string[], b: readonly string[]) =>
    a.length <= b.length && a.every((part, i) => part === b[i]);
  const old = identityRows(read.resultIdentities, read.resultObject).filter((row) => prefix(selection.from, row.path));
  const now = identityRows(call.call.identities?.[2], call.call.objects[2]).filter((row) =>
    prefix(selection.to, row.path),
  );
  if (
    !old.some((row) => equal(row.path, selection.from)) ||
    !now.some((row) => equal(row.path, selection.to)) ||
    old.length !== now.length
  )
    return refuse('embedded read subtree root is missing or changed');
  const actual = new Map(now.map((row) => [JSON.stringify(row.path), row.object]));
  for (const row of old) {
    const target = [...selection.to, ...row.path.slice(selection.from.length)];
    if (actual.get(JSON.stringify(target)) !== row.object)
      return refuse('embedded value does not preserve that SAME read object/subtree');
  }
}

export function completeIdentityRows(graph: IdentityGraph | undefined, value: ValueFact, root: number | undefined) {
  const expected = objectPaths(value);
  if (!expected.length) {
    if (root !== undefined || !Array.isArray(graph) || graph.length !== 0)
      return refuse('primitive read lacks its explicit empty identity graph');
    return [];
  }
  const actual = identityRows(graph, root);
  const keys = new Set(actual.map((row) => JSON.stringify(row.path)));
  if (actual.length !== expected.length || expected.some((path) => !keys.has(JSON.stringify(path))))
    return refuse('identity graph does not cover its complete observed value shape');
  return actual;
}
/** Closed fixture spread/batch copies every retained own member; the overwritten member is not copied. */
export function copiedMembers(write: Write, read: ValueFact, overwritten?: string): Write {
  const nested = rows(read).filter(([, , value]) => objectKind(value));
  if (!nested.length) return write;
  return {
    ...write,
    copiedRead: nested.filter(([key]) => key !== overwritten).map(([key]) => ({ from: [key], to: [key] })),
  };
}
export function sameCopiedMembers(read: NativeFact, call: FixtureCall, selections: NonNullable<Write['copiedRead']>) {
  const before = completeIdentityRows(read.resultIdentities, read.result!, read.resultObject);
  completeIdentityRows(call.call.identities?.[2], call.call.args[2], call.call.objects[2]);
  if (before.some((row) => row.object === call.call.objects[2]))
    return refuse('copied-member outer container aliases an original read object');
  for (const selection of selections) sameEmbeddedRead(read, call, selection);
}
export function freshLiteral(read: NativeFact, call: FixtureCall, selected: NonNullable<Write['literal']>) {
  const before = completeIdentityRows(read.resultIdentities, read.result!, read.resultObject);
  const argument = completeIdentityRows(call.call.identities?.[2], call.call.args[2], call.call.objects[2]);
  const expected = objectPaths(selected.value).map((path) => [...selected.at, ...path]);
  const after = argument.filter(
    (row) => selected.at.length <= row.path.length && selected.at.every((part, i) => part === row.path[i]),
  );
  const ids = new Set(before.map((row) => row.object));
  const paths = new Set(after.map((row) => JSON.stringify(row.path)));
  if (
    !expected.length ||
    after.length !== expected.length ||
    expected.some((path) => !paths.has(JSON.stringify(path))) ||
    new Set(after.map((row) => row.object)).size !== after.length ||
    ids.has(call.call.objects[2]!) ||
    after.some((row) => ids.has(row.object))
  )
    return refuse('materialised literal/container has missing, aliased, or read-shared identity facts');
}
