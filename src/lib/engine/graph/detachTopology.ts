import { declareRetryLoopBudget, retryLoopBudget } from '../../attempt/retryLoopContext.js';
import { copyRunComponentRoot } from '../../memory/RunComponent.js';
import type { StageNode } from './StageNode.js';

const MAX_TOPOLOGY_WORK = 100_000;

class UnavailableTopology extends Error {}

export interface DetachedStageTopology<TOut, TScope> {
  readonly root: StageNode<TOut, TScope>;
  detachedOf(authored: object): StageNode<TOut, TScope> | undefined;
  authoredOf(detached: object): StageNode<TOut, TScope> | undefined;
}

/**
 * A private immutable topology for a captured leg. Shared placements remain shared.
 * Functions and operational configuration keep their references. Author-owned
 * declarations can be read through the original placement while building the projection.
 */
export function detachStageTopology<TOut, TScope>(
  root: StageNode<TOut, TScope>,
  work = MAX_TOPOLOGY_WORK,
): DetachedStageTopology<TOut, TScope> | undefined {
  if (!Number.isSafeInteger(work) || work < 1 || work > MAX_TOPOLOGY_WORK) return undefined;
  type Node = StageNode<TOut, TScope>;
  const copies = new WeakMap<object, Node>();
  const originals = new WeakMap<object, Node>();
  const pending: Array<{ source: object; clone: Node }> = [];
  const charge = (units: number) => {
    work -= units;
    if (work < 0) throw new UnavailableTopology();
  };

  function cloneNode(source: unknown): Node {
    if (source === null || typeof source !== 'object') throw new UnavailableTopology();
    const existing = copies.get(source);
    if (existing) return existing;
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) throw new UnavailableTopology();
    charge(1);
    const clone = Object.create(prototype) as Node;
    pending.push({ source, clone });
    copies.set(source, clone);
    originals.set(clone, source as Node);
    return clone;
  }

  function copyChildren(source: unknown): readonly Node[] {
    if (!Array.isArray(source) || Object.getPrototypeOf(source) !== Array.prototype) throw new UnavailableTopology();
    const length: unknown = Object.getOwnPropertyDescriptor(source, 'length')?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new UnavailableTopology();
    charge(length + 1);
    if (Reflect.ownKeys(source).length !== length + 1) throw new UnavailableTopology();
    const items: Node[] = [];
    for (let i = 0; i < length; i++) {
      const slot = Object.getOwnPropertyDescriptor(source, String(i));
      if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) throw new UnavailableTopology();
      items.push(cloneNode(slot.value));
    }
    return Object.freeze(items);
  }

  try {
    const first = cloneNode(root);
    for (let index = 0; index < pending.length; index++) {
      const { source, clone } = pending[index];
      const keys = Reflect.ownKeys(source);
      charge(keys.length);
      for (const key of keys) {
        const slot = Object.getOwnPropertyDescriptor(source, key);
        if (typeof key !== 'string' || !slot?.enumerable || !Object.hasOwn(slot, 'value'))
          throw new UnavailableTopology();
        let value: unknown = slot.value;
        if (value !== undefined) {
          if (key === 'next') value = cloneNode(value);
          else if (key === 'children') value = copyChildren(value);
        }
        Object.defineProperty(clone, key, { value, enumerable: true });
      }
      if (typeof clone.id !== 'string' || typeof clone.name !== 'string') throw new UnavailableTopology();
      copyRunComponentRoot(source, clone);
      const retry = retryLoopBudget(source);
      if (retry) declareRetryLoopBudget(clone, retry);
      Object.freeze(clone);
    }
    return Object.freeze({
      root: first,
      detachedOf: (authored: object) => copies.get(authored),
      authoredOf: (detached: object) => originals.get(detached),
    });
  } catch {
    return undefined;
  }
}
