/** A finite inheritance allowance for ordinary Error subclasses and metadata. */
const MAX_ERROR_FIELD_DEPTH = 32;

/** Accessors shadow farther data but never run while classifying a failure. */
export function errorField(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < MAX_ERROR_FIELD_DEPTH; depth++) {
    const property = Object.getOwnPropertyDescriptor(current, key);
    if (property) return Object.prototype.hasOwnProperty.call(property, 'value') ? property.value : undefined;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
