import { registerRedactionDisclosure } from './readAuthority/disclosure.js';
import { dataField, objectPrototype, ownDescriptor, prototypeOf } from './readAuthority/intrinsics.js';
import { type RedactionPolicy, disclosureMarks, effectiveSelectors, RedactionRule } from './redaction.js';

const array = Array.prototype;
const regex = RegExp.prototype;
const regexSource = ownDescriptor(regex, 'source')?.get;
const ownKeys = Reflect.ownKeys;
const apply = Reflect.apply;
const isArray = Array.isArray;
const clone = structuredClone;
const encode = JSON.stringify;
const every = Function.call.bind(Array.prototype.every) as <T>(
  values: readonly T[],
  test: (value: T, index: number) => boolean,
) => boolean;
const prototypes = [regex, array, objectPrototype, Array].map((owner) => ({
  owner,
  parent: prototypeOf(owner),
  fields: Object.getOwnPropertyDescriptors(owner),
}));

function nativePrototypes(): boolean {
  // Use the captured iteration operation rather than methods we are checking.
  return every(prototypes, ({ owner, parent, fields }) => {
    const keys = ownKeys(fields);
    return (
      prototypeOf(owner) === parent &&
      ownKeys(owner).length === keys.length &&
      every(keys, (key) => {
        const current = ownDescriptor(owner, key);
        const known = fields[key as keyof typeof fields];
        return !!current && current.get === known.get && current.value === known.value;
      })
    );
  });
}

/** Check each slot before cloning so verification does not invoke policy accessors. */
function selectorData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return value === undefined || typeof value === 'string';
  const prototype = prototypeOf(value);
  const keys = ownKeys(value);
  if (prototype === regex) {
    // The native source getter rejects objects that only inherit from RegExp.
    return (
      keys.length === 1 && keys[0] === 'lastIndex' && !!regexSource && typeof apply(regexSource, value, []) === 'string'
    );
  }
  const list = isArray(value);
  if (list ? prototype !== array : prototype !== objectPrototype && prototype !== null) return false;
  return every(keys, (key, index) => {
    if (typeof key !== 'string') return false;
    const field = dataField(value, key);
    if (list && key === 'length') return index === field?.value;
    return !!field?.enumerable && (!list || key === String(index)) && selectorData(field.value);
  });
}

function selectorStamp(rule: RedactionRule): string | undefined {
  try {
    const inputs = effectiveSelectors(rule);
    if (!nativePrototypes() || !selectorData(inputs)) return undefined;
    // The descriptor walk also protects the native clone from policy getters.
    // The clone refuses proxy objects that can emulate ordinary descriptors.
    return encode(clone(inputs), (_, value) =>
      value instanceof RegExp ? 'r' + String(value) : typeof value === 'string' ? 's' + value : value,
    );
  } catch {
    return undefined;
  }
}

export function evidenceRedactionRule(policy?: RedactionPolicy): RedactionRule {
  const rule = new RedactionRule(policy);
  const installed = selectorStamp(rule);
  return registerRedactionDisclosure(rule, () => {
    if (installed === undefined || selectorStamp(rule) !== installed) return undefined;
    const marks = disclosureMarks(rule);
    return encode([installed, marks?.keys ?? [], marks?.fields]);
  });
}
