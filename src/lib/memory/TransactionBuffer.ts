/**
 * TransactionBuffer — Transactional write buffer for stage mutations
 *
 * Collects writes during execution and commits them atomically.
 * Like a database transaction buffer:
 * - Changes staged here before being committed to SharedMemory
 * - Enables read-after-write consistency within a stage
 * - Records operation trace for deterministic replay
 */

import _get from 'lodash.get';
import _set from 'lodash.set';

import type { MemoryPatch } from './types';
import { deepSmartMerge, normalisePath } from './utils';

export class TransactionBuffer {
  private readonly baseSnapshot: any;
  private workingCopy: any;

  private overwritePatch: MemoryPatch = {};
  private updatePatch: MemoryPatch = {};
  private opTrace: { path: string; verb: 'set' | 'merge' }[] = [];
  private redactedPaths = new Set<string>();

  constructor(base: any) {
    this.baseSnapshot = structuredClone(base);
    this.workingCopy = structuredClone(base);
  }

  /** Hard overwrite at the specified path. */
  set(path: (string | number)[], value: any, shouldRedact = false): void {
    _set(this.workingCopy, path, value);
    _set(this.overwritePatch, path, structuredClone(value));
    if (shouldRedact) {
      this.redactedPaths.add(normalisePath(path));
    }
    this.opTrace.push({ path: normalisePath(path), verb: 'set' });
  }

  /** Deep union merge at the specified path. */
  merge(path: (string | number)[], value: any, shouldRedact = false): void {
    const existing = _get(this.workingCopy, path) ?? {};
    const merged = deepSmartMerge(existing, value);
    _set(this.workingCopy, path, merged);
    _set(this.updatePatch, path, deepSmartMerge(_get(this.updatePatch, path) ?? {}, value));
    if (shouldRedact) {
      this.redactedPaths.add(normalisePath(path));
    }
    this.opTrace.push({ path: normalisePath(path), verb: 'merge' });
  }

  /** Read current value at path (includes uncommitted changes). */
  get(path: (string | number)[], defaultValue?: any) {
    return _get(this.workingCopy, path, defaultValue);
  }

  /**
   * Flush all staged mutations and return the commit bundle.
   * Resets the buffer to empty state after commit.
   */
  commit(): {
    overwrite: MemoryPatch;
    updates: MemoryPatch;
    redactedPaths: Set<string>;
    trace: { path: string; verb: 'set' | 'merge' }[];
  } {
    const payload = {
      overwrite: structuredClone(this.overwritePatch),
      updates: structuredClone(this.updatePatch),
      redactedPaths: new Set(this.redactedPaths),
      trace: [...this.opTrace],
    };

    this.overwritePatch = {};
    this.updatePatch = {};
    this.opTrace.length = 0;
    this.redactedPaths.clear();
    this.workingCopy = {};

    return payload;
  }
}
