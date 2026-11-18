import {
  dataField,
  objectPrototype,
  ownDescriptor,
  prototypeOf,
  sameDataField,
  weaklyAdd,
  weaklyHas,
} from './intrinsics.js';

/** Private registration data; original method function identities remain descriptor DATA. */
export interface OwnerData {
  readonly owners: WeakSet<object>;
  readonly prototype: object;
  readonly descriptors: readonly (readonly [string, PropertyDescriptor | undefined])[];
}

/** Snapshot at real owner-module evaluation, never at first construction or observation. */
export function originalOwners(prototype: object, methods: readonly string[]): OwnerData {
  const owners = new WeakSet<object>();
  const descriptors = ['constructor', ...methods].map((key) => [key, dataField(prototype, key)] as const);
  return { owners, prototype, descriptors };
}

/** Minted by the real constructor, before any observation can reflect on an argument. */
export function registerOwner(data: OwnerData, owner: object, direct: boolean): void {
  if (direct) weaklyAdd(data.owners, owner);
}

export function admitsOwner(data: OwnerData, owner: unknown): owner is object {
  if (!weaklyHas(data.owners, owner)) return false;
  if (prototypeOf(owner) !== data.prototype || prototypeOf(data.prototype) !== objectPrototype) return false;
  for (const [key, descriptor] of data.descriptors) {
    if (!descriptor || !sameDataField(data.prototype, key, descriptor)) return false;
    if (ownDescriptor(owner, key) !== undefined) return false;
  }
  return true;
}
