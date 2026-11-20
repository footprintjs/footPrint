import { admitAttemptName } from './name.js';

const MAX_OUTSIDE_INPUT_NAMES = 128;

/** Return an own data slot without calling an accessor. */
function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

/** Validate public names once and return a detached, frozen list, absent when empty. */
export function admitOutsideInputNames(names: unknown, where: string): readonly string[] | undefined {
  if (names === undefined) return undefined;
  const invalid = () => new TypeError(`${where}: outside inputs must be an array of public names`);
  let list: boolean;
  try {
    list = Array.isArray(names);
  } catch {
    throw invalid();
  }
  if (!list) throw invalid();
  const data = (key: string): unknown => {
    try {
      return ownData(names as object, key);
    } catch {
      throw invalid();
    }
  };
  const count = data('length');
  if (count === 0) return undefined;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > MAX_OUTSIDE_INPUT_NAMES) {
    throw new TypeError(`${where}: at most ${MAX_OUTSIDE_INPUT_NAMES} outside inputs may be declared on a stage`);
  }

  const admitted = new Set<string>();
  for (let index = 0; index < count; index++) {
    const name = admitAttemptName(where, `outside input name ${index + 1}`, data(String(index)));
    if (admitted.has(name)) throw new TypeError(`${where}: outside input name ${index + 1} is declared twice`);
    admitted.add(name);
  }
  return Object.freeze([...admitted]);
}

/** Read a runtime node's declaration defensively, including nodes supplied through advanced APIs. */
export function readDeclaredOutsideInputs(node: object): readonly string[] | undefined {
  try {
    return admitOutsideInputNames(ownData(node, 'outsideInputs'), 'outsideInputs');
  } catch {
    return undefined;
  }
}
