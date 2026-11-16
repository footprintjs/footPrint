import { errorEnvelope } from '../../errors/failureRetention/index.js';
import type { MaskedErrors } from './maskedErrors.js';
import { genericMaskProjection } from './origins.js';

const KEEP: unique symbol = Symbol('kept as it is');
/** A masked error's served form — KEEP for anything else. Never swap null/undefined/boolean. */
function leaf(value: unknown, memo: MaskedErrors | undefined, rule: object): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') return KEEP;
  if (typeof value === 'object') {
    const info = genericMaskProjection(rule, value, memo);
    return info ? { ...info } : KEEP;
  }
  const swappable = typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint';
  const info = swappable ? memo?.get(value) : undefined;
  return info ? info.message : KEEP;
}

/** Every container under root from which some path reaches a masked value or native result slot. */
function reaching(root: object, memo: MaskedErrors | undefined, rule: object): Set<object> {
  const parents = new Map<object, object[]>();
  const holders: object[] = [];
  const seen = new Set<object>([root]);
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    const envelope = errorEnvelope(rule, node);
    for (const [key, child] of Object.entries(node)) {
      const slot = key === 'result' ? envelope : undefined;
      if (slot?.replace || (!slot && leaf(child, memo, rule) !== KEEP)) {
        holders.push(node);
        continue;
      }
      if (child === null || typeof child !== 'object') continue;
      const of = parents.get(child);
      if (of === undefined) parents.set(child, [node]);
      else of.push(node);
      if (!seen.has(child)) {
        seen.add(child);
        stack.push(child);
      }
    }
  }
  const result = new Set<object>();
  while (holders.length) {
    const node = holders.pop()!;
    if (result.has(node)) continue;
    result.add(node);
    holders.push(...(parents.get(node) ?? []));
  }
  return result;
}

/**
 * Copy-on-write over containers: every remembered masked error becomes its
 * served form — an object error its masked structured info, a thrown
 * string/number its masked text (the value keeps being a scalar). A legacy generic scalar is
 * matched by VALUE, so an unrelated field that happens to equal a masked
 * thrown string is masked too: over-masking is the safe direction.
 * `undefined`/`null`/booleans are never swapped — they carry no text, and
 * swapping them would rewrite ordinary data shapes.
 *
 * CYCLE-SAFE (review finding 2). The containers that can REACH a masked
 * error are found first ({@link reaching} — the whole reachable
 * graph, cycles included); each of them is copied, its copy allocated and
 * remembered BEFORE its children are filled, so an edge back to it — a cycle
 * — lands on the copy, never on the original that still holds the raw error.
 * Every other container keeps its identity.
 */
export function serveErrorBoundary(value: unknown, memo: MaskedErrors | undefined, rule: object): unknown {
  const first = leaf(value, memo, rule);
  if (first !== KEEP || value === null || typeof value !== 'object') return first === KEEP ? value : first;
  const needed = reaching(value, memo, rule);
  if (!needed.has(value)) return value;
  const copies = new Map<object, Record<string, unknown>>();
  const copyOf = (node: object): Record<string, unknown> => {
    const known = copies.get(node);
    if (known !== undefined) return known;
    const copy = (Array.isArray(node) ? node.slice() : { ...node }) as Record<string, unknown>;
    copies.set(node, copy);
    const envelope = errorEnvelope(rule, node);
    for (const [key, child] of Object.entries(node)) {
      const slot = key === 'result' ? envelope : undefined;
      if (slot?.replace) {
        copy[key] = slot.value !== null && typeof slot.value === 'object' ? { ...slot.value } : slot.value;
        continue;
      }
      const served = slot ? KEEP : leaf(child, memo, rule);
      if (served !== KEEP) copy[key] = served;
      else if (child !== null && typeof child === 'object' && needed.has(child)) copy[key] = copyOf(child);
    }
    return copy;
  };
  return copyOf(value);
}
