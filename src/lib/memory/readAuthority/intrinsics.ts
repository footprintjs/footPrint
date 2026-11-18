/** Captured operations over identity-admitted owners; none dispatches a user method. */
export const ownDescriptor = Object.getOwnPropertyDescriptor;
export const prototypeOf = Object.getPrototypeOf;
export const objectPrototype = Object.prototype;
const apply = Reflect.apply;
const has = Object.prototype.hasOwnProperty;
const weakHas = WeakSet.prototype.has;
const weakAdd = WeakSet.prototype.add;
const setPrototype = Set.prototype;
const setSize = ownDescriptor(setPrototype, 'size');

export const weaklyHas = (owners: WeakSet<object>, value: unknown): value is object => apply(weakHas, owners, [value]);
export const weaklyAdd = (owners: WeakSet<object>, value: object): void => {
  apply(weakAdd, owners, [value]);
};

export function dataField(owner: object, key: string): PropertyDescriptor | undefined {
  const field = ownDescriptor(owner, key);
  return field && apply(has, field, ['value']) ? field : undefined;
}

export function sameDataField(owner: object, key: string, original: PropertyDescriptor): boolean {
  const field = dataField(owner, key);
  return (
    field !== undefined &&
    field.value === original.value &&
    field.writable === original.writable &&
    field.enumerable === original.enumerable &&
    field.configurable === original.configurable
  );
}

/** Brand first: a Proxy around a Set fails without executing any of its traps. */
export function nativeSetSize(value: unknown): number | undefined {
  try {
    if (!setSize || typeof setSize.get !== 'function') return undefined;
    const size = apply(setSize.get, value, []);
    if (prototypeOf(value) !== setPrototype || ownDescriptor(value, 'size') !== undefined) return undefined;
    const current = ownDescriptor(setPrototype, 'size');
    if (
      !current ||
      !apply(has, current, ['get']) ||
      current.get !== setSize.get ||
      current.set !== setSize.set ||
      current.enumerable !== setSize.enumerable ||
      current.configurable !== setSize.configurable ||
      prototypeOf(setPrototype) !== objectPrototype
    )
      return undefined;
    return size;
  } catch {
    return undefined;
  }
}
