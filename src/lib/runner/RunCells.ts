import type { CellBank } from '../memory/RunFrame.js';
import type { CellValue, RunCells, RunSlot } from './RunLifecycle.js';

const INITIALIZING = Symbol('initializing run cell');

/** Namespace and slot law; the L4 carrier stores only opaque keys and values. */
export class RunSlots {
  private readonly keys = new WeakMap<object, 'leg' | 'runtime'>();
  private frozen = false;

  issue<T>(lifetime: 'leg' | 'runtime'): RunSlot<T> {
    if (this.frozen) throw new TypeError('Run slots must be declared before the first use');
    if (lifetime !== 'leg' && lifetime !== 'runtime') throw new TypeError('Unknown run slot lifetime');
    const slot = Object.freeze({}) as RunSlot<T>;
    this.keys.set(slot, lifetime);
    return slot;
  }

  freeze(): void {
    this.frozen = true;
  }

  cells(
    bankFor: (namespace: object, lifetime: 'leg' | 'runtime') => CellBank,
    allowRead: () => void,
    allowWrite: () => void,
  ): RunCells {
    const bank = <T>(slot: RunSlot<T>): CellBank => {
      const lifetime =
        slot && (typeof slot === 'object' || typeof slot === 'function') ? this.keys.get(slot) : undefined;
      if (!lifetime) throw new TypeError('Run slot belongs to another lifecycle or is fabricated');
      return bankFor(this, lifetime);
    };
    const read = <T>(slot: RunSlot<T>): CellValue<T> => {
      allowRead();
      const cells = bank(slot);
      if (!cells.has(slot)) return { present: false };
      const value = cells.get(slot);
      if (value === INITIALIZING) throw new TypeError('Run cell is being initialized');
      return { present: true, value: value as T };
    };
    return {
      read,
      local: <T>(slot: RunSlot<T>, initialize: () => T): T => {
        const existing = read(slot);
        if (existing.present) return existing.value;
        allowWrite();
        const cells = bank(slot);
        cells.set(slot, INITIALIZING);
        try {
          const value = initialize();
          cells.set(slot, value);
          return value;
        } catch (error) {
          cells.delete(slot);
          throw error;
        }
      },
      set: <T>(slot: RunSlot<T>, value: T): void => {
        allowWrite();
        const cells = bank(slot);
        if (cells.get(slot) === INITIALIZING) throw new TypeError('Run cell is being initialized');
        cells.set(slot, value);
      },
      take: <T>(slot: RunSlot<T>): CellValue<T> => {
        allowWrite();
        const value = read(slot);
        bank(slot).delete(slot);
        return value;
      },
    };
  }
}
