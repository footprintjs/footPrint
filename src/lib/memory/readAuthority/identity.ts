import {
  dataField,
  objectPrototype,
  ownDescriptor,
  prototypeOf,
  sameDataField,
  weaklyAdd,
  weaklyHas,
} from './intrinsics.js';

/** Minted by the real constructor, before any observation can reflect on an argument. */
export function originalOwners(prototype: object, methods: readonly string[]) {
  const owners = new WeakSet<object>();
  const descriptors = ['constructor', ...methods].map((key) => [key, dataField(prototype, key)] as const);
  return {
    register(owner: object, direct: boolean): void {
      if (direct) weaklyAdd(owners, owner);
    },
    admits(owner: unknown): owner is object {
      if (!weaklyHas(owners, owner)) return false;
      if (prototypeOf(owner) !== prototype || prototypeOf(prototype) !== objectPrototype) return false;
      for (const [key, descriptor] of descriptors) {
        if (!descriptor || !sameDataField(prototype, key, descriptor)) return false;
        if (ownDescriptor(owner, key) !== undefined) return false;
      }
      return true;
    },
  };
}
