/** A finite inheritance allowance for ordinary Error subclasses and metadata. */
const MAX_ERROR_FIELD_DEPTH = 32;

// Capture the platform intrinsic once; never call a later caller replacement.
const DOM_EXCEPTION_PROTOTYPE = typeof DOMException === 'function' ? DOMException.prototype : undefined;
const DOM_EXCEPTION_NAME = DOM_EXCEPTION_PROTOTYPE
  ? Object.getOwnPropertyDescriptor(DOM_EXCEPTION_PROTOTYPE, 'name')?.get
  : undefined;
const APPLY_INTRINSIC = Reflect.apply;

/** Caller accessors shadow farther data. Only the captured platform name getter may run. */
export function errorField(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < MAX_ERROR_FIELD_DEPTH; depth++) {
    const property = Object.getOwnPropertyDescriptor(current, key);
    if (property) {
      if (Object.prototype.hasOwnProperty.call(property, 'value')) return property.value;
      if (
        key === 'name' &&
        current === DOM_EXCEPTION_PROTOTYPE &&
        DOM_EXCEPTION_NAME &&
        property.get === DOM_EXCEPTION_NAME
      ) {
        // The intrinsic brand-checks its receiver, refusing forged prototypes and proxies.
        return APPLY_INTRINSIC(DOM_EXCEPTION_NAME, value, []);
      }
      return undefined;
    }
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}
