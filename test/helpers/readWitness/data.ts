import type { Definedness, Segment } from './observationTypes.js';

export class UnsupportedReadLawObservation extends Error {
  constructor() {
    super('Unsupported native read-law observation; oracle domain is unknown.');
  }
}
export const bad = (): never => {
  throw new UnsupportedReadLawObservation();
};
export const own = (object: object, key: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) return bad();
  return descriptor?.value;
};
export const definedness = (value: unknown): Definedness =>
  Object.freeze({ kind: value === undefined ? 'undefined' : 'defined' });
export function addressOf(value: unknown): readonly Segment[] {
  if (!Array.isArray(value)) return bad();
  const result: Segment[] = [];
  for (let i = 0; i < value.length; i++) {
    const segment = own(value, String(i));
    if (typeof segment !== 'string' && !(typeof segment === 'number' && Number.isSafeInteger(segment))) return bad();
    result.push(segment);
  }
  return Object.freeze(result);
}
export const STAGE = [
  ['getValue', true],
  ['getValueDirect', false],
  ['setObject', true],
  ['updateObject', true],
  ['setGlobal', false],
  ['updateGlobal', false],
  ['appendToArray', false],
  ['mergeObject', false],
  ['commit', true],
] as const;
export const BUFFER = ['set', 'merge', 'delete', 'get', 'commit'] as const;
export const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
export const readMethod = (name: string) => name === 'getValue' || name === 'getValueDirect';
export const mutation = (name: string) => name === 'set' || name === 'merge' || name === 'delete';
