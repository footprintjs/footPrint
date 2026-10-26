import type { ReadSource } from 'foottrace/write';

/** Native per-execution totals, independent of last-value retention and the bounded source book. */
export interface SourceReadCounts {
  readonly observed: number;
  readonly retained: number;
  /** Counts the native writer's returned kinds, never classifies values or chooses sources. */
  readonly kinds: Readonly<Record<ReadSource['kind'], number>>;
}

export const EMPTY_SOURCE_READ_COUNTS: SourceReadCounts = Object.freeze({
  observed: 0,
  retained: 0,
  kinds: Object.freeze({ base: 0, committed: 0, staged: 0, unavailable: 0 }),
});

/** Fixed scalar counters only; discarded attempts remain part of this execution's history. */
export class SourceReadCounter {
  private observed = 0;
  private retained = 0;
  private kinds = { ...EMPTY_SOURCE_READ_COUNTS.kinds };

  observe(): boolean {
    if (this.observed === Number.MAX_SAFE_INTEGER) return false;
    this.observed++;
    return true;
  }

  retain(kind: ReadSource['kind']): void {
    if (this.retained < this.observed) {
      this.retained++;
      this.kinds[kind]++;
    }
  }

  snapshot(): SourceReadCounts {
    return Object.freeze({ observed: this.observed, retained: this.retained, kinds: Object.freeze({ ...this.kinds }) });
  }
}
