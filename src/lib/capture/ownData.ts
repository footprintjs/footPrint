/**
 * `target[name] = value`, preserving existing own-slot behavior while making
 * a missing inherited name an OWN data property. Payload names such as
 * `__proto__` are data, not setters or selector instructions. Shared by the
 * record-serving and copy-on-write copies; this is not a public helper.
 */
export function putOwn(target: Record<string, unknown>, name: string, value: unknown): void {
  if (!Object.prototype.hasOwnProperty.call(target, name) && Reflect.has(target, name)) {
    Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
  } else {
    target[name] = value;
  }
}
