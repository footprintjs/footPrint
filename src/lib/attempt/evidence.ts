/** Bounded capture-only adapter observations. Never inspect arbitrary business answers. */
import type { CallEvidence } from './types.js';

export type CallEvidenceData = Readonly<Record<string, unknown>>;
const encoder = new TextEncoder();
const own = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new TypeError('Evidence must be data');
  return descriptor?.value;
};
const fits = (value: string) => value.length <= 200 && encoder.encode(JSON.stringify(value)).length <= 200;

function refs(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new TypeError('Evidence references must be an array');
  const length = own(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    throw new TypeError('Invalid evidence length');
  const kept: string[] = [];
  // Bound examined positions, including oversized entries that retain nothing.
  const inspected = Math.min(length, 32);
  for (let i = 0; i < inspected; i++) {
    const item = own(value, String(i));
    if (typeof item !== 'string') throw new TypeError('Evidence references must be strings');
    if (fits(item)) kept.push(item);
  }
  const omitted = length - kept.length;
  return { [name]: kept, ...(omitted > 0 && { [name + 'Omitted']: omitted }) };
}

export function readCallEvidence(options: unknown): {
  input: CallEvidenceData;
  observe?: CallEvidence['observe'];
  refused?: true;
} {
  try {
    const value = options && typeof options === 'object' ? own(options, 'evidence') : undefined;
    if (value === undefined) return { input: {} };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { input: {}, refused: true };
    const input = refs(own(value, 'inputRefs'), 'inputRefs');
    const observe = own(value, 'observe');
    if (observe !== undefined && typeof observe !== 'function') return { input: {}, refused: true };
    return { input, ...(observe !== undefined && { observe: observe as CallEvidence['observe'] }) };
  } catch {
    return { input: {}, refused: true };
  }
}

export function observeCallAnswer(
  observe: CallEvidence['observe'],
  answer: unknown,
): {
  data: CallEvidenceData;
  refused?: true;
} {
  try {
    if (!observe) return { data: {} };
    const observed = observe(answer) as unknown;
    try {
      // Brand-check with the intrinsic: native Promises from another realm also qualify. Never ask a thenable's
      // `then` getter, and never await unsupported async capture or add a hop to the business operation's chain.
      Promise.prototype.then.call(observed, undefined, () => undefined);
      return { data: {}, refused: true };
    } catch {
      // Ordinary metadata has no Promise slots. Arbitrary Promise subclasses/proxies are outside this seam.
    }
    if (observed === null || typeof observed !== 'object' || Array.isArray(observed))
      return { data: {}, refused: true };
    const result = refs(own(observed, 'outputRefs'), 'outputRefs');
    const remote = own(observed, 'remoteRequestId');
    if (remote !== undefined && typeof remote !== 'string') return { data: {}, refused: true };
    if (typeof remote === 'string' && !fits(remote)) return { data: result, refused: true };
    return { data: { ...result, ...(remote !== undefined && { remoteRequestId: remote }) } };
  } catch {
    return { data: {}, refused: true };
  }
}
