/**
 * The private L0 owner of own-slot writes. Selector validation belongs to
 * pathOps: payload names (including `__proto__`) are ordinary data here.
 * Neither operation flattens an existing own accessor or changes its flags.
 */

/**
 * `target[name] = value`, preserving existing own-slot behavior while making
 * a missing inherited name an OWN data property. Payload names such as
 * `__proto__` are data, not setters or selector instructions. Shared by the
 * record-serving and copy-on-write copies; this is not a public helper.
 */
export function putOwn(target: Record<string, unknown>, name: string | number, value: unknown): void {
  if (!Object.prototype.hasOwnProperty.call(target, name) && Reflect.has(target, name)) {
    defineOwnData(target, name, value);
  } else {
    target[name] = value;
  }
}

/**
 * Nested diagnostic writers require a missing slot to be CREATED, not merely
 * assigned. Keep that contract separate from putOwn: an out-of-range typed
 * array index is an assignment no-op, but cannot be defined as an own slot.
 */
export function setOwnValue(target: Record<string, unknown>, name: string | number, value: unknown): void {
  if (Object.prototype.hasOwnProperty.call(target, name)) {
    putOwn(target, name, value);
  } else {
    defineOwnData(target, name, value);
  }
}

function defineOwnData(target: Record<string, unknown>, name: string | number, value: unknown): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}
