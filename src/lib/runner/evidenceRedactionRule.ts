import { bindChildEvidencePolicy } from '../engine/handlers/childEvidencePolicy.js';
import { dataField, objectPrototype, ownDescriptor, prototypeOf } from '../memory/readAuthority/intrinsics.js';
import { type RedactionPolicy, RedactionRule } from '../memory/redaction.js';

const regex = RegExp.prototype;
const array = Array.prototype;
const regexSource = ownDescriptor(regex, 'source')!.get!;
const knownPrototypes = [regex, array, objectPrototype, Array].map((owner) => ({
  owner,
  parent: prototypeOf(owner),
  fields: Object.getOwnPropertyDescriptors(owner),
}));

function nativePrototypes(): boolean {
  return knownPrototypes.every(({ owner, parent, fields }) => {
    const keys = Reflect.ownKeys(fields);
    return (
      prototypeOf(owner) === parent &&
      Reflect.ownKeys(owner).length === keys.length &&
      keys.every((key) => {
        const current = ownDescriptor(owner, key);
        const known = fields[key as keyof typeof fields];
        return current && current.get === known.get && current.value === known.value;
      })
    );
  });
}

/** Check each slot before cloning so verification does not invoke policy accessors. */
function selectorData(value: unknown): boolean {
  if (!value || typeof value !== 'object') return value === undefined || typeof value === 'string';
  const prototype = prototypeOf(value);
  const keys = Reflect.ownKeys(value);
  if (prototype === regex) {
    // This native getter also rejects objects that only inherit from RegExp.
    Reflect.apply(regexSource, value, []);
    return keys.length === 1 && keys[0] === 'lastIndex';
  }
  const list = Array.isArray(value);
  if (list ? prototype !== array : prototype !== objectPrototype && prototype !== null) return false;
  return keys.every((key, index) => {
    if (typeof key !== 'string') return false;
    if (list && key === 'length') return index === dataField(value, key)?.value;
    const field = dataField(value, key);
    return (!list || key === String(index)) && !!field?.enumerable && selectorData(field.value);
  });
}

function policyStamp(policy: RedactionPolicy | undefined): string | undefined {
  if (!policy) return '';
  try {
    if (!nativePrototypes() || !selectorData(policy)) return undefined;
    // The descriptor walk also protects the native clone from policy getters.
    // The clone refuses proxy objects that can emulate ordinary descriptors.
    return JSON.stringify(structuredClone(policy), (_, value) =>
      value instanceof RegExp ? 'r' + String(value) : typeof value === 'string' ? 's' + value : value,
    );
  } catch {
    return undefined;
  }
}

export function evidenceRedactionRule(policy?: RedactionPolicy): RedactionRule {
  const rule = new RedactionRule(policy);
  const admitted = policyStamp(policy);
  return bindChildEvidencePolicy(rule, () => {
    // The native rule caches path and diagnostic selectors when installed.
    if (admitted === undefined || policyStamp(rule.getPolicy()) !== admitted) return undefined;
    const marks = rule.marksForCheckpoint();
    const declared = marks?.keys.length ? new RedactionRule(policy) : undefined;
    return JSON.stringify([admitted, marks?.keys.filter((key) => !declared?.isKeyRedacted(key)) ?? [], marks?.fields]);
  });
}
