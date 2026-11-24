import { canonicalizeJson } from 'foottrace/canonical-json';
import { isDeniedSegment } from 'foottrace/paths';

import { MAX_CALL_RECORDS } from '../memory/callLimits/index.js';
import { admitAttemptName } from './name.js';
import { freezeDeep } from './record.js';
import type {
  AttemptCategory,
  AttemptRecord,
  DeclaredDispatch,
  DeclaredFailures,
  DeclaredSettlement,
  DeclaredWrite,
  DeclaredWriteObserver,
} from './types.js';

const CATEGORIES: ReadonlySet<unknown> = new Set<AttemptCategory>([
  'timeout',
  'rate-limited',
  'server',
  'network',
  'auth',
  'permanent',
  'unknown',
]);
const LIMITS = { maxDepth: 16, maxNodes: 256, maxFields: 256, maxBytes: 8192, maxStringBytes: 8192 };
const WHERE = 'declaredFailures';

export function declaredWriteObserver(sealScope: () => void): DeclaredWriteObserver {
  let pending: DeclaredWrite[] = [];
  return {
    written(path, declarations) {
      pending = pending.filter((write) => !writesOverlap(write.at, path));
      if (declarations) {
        for (const write of declarations) pending.push({ ...write, at: [...path, ...write.at] });
      }
    },
    seal(before) {
      sealScope();
      const writes = pending;
      pending = [];
      return (after) => {
        const records: AttemptRecord[] = [];
        for (const write of writes) {
          if (!matchesDeclaredWrite(before, write) && matchesDeclaredWrite(after, write)) records.push(write.record);
        }
        return records;
      };
    },
    discard() {
      pending = [];
    },
  };
}

function ownValue(value: unknown, key: PropertyKey): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && Object.hasOwn(field, 'value') ? field.value : undefined;
}

function ownPath(value: unknown, path: readonly string[]): unknown {
  for (const key of path) value = ownValue(value, key);
  return value;
}

function matchesDeclaredWrite(state: unknown, write: DeclaredWrite): boolean {
  try {
    return canonicalizeJson(ownPath(state, write.at), LIMITS) === write.value;
  } catch {
    // Missing, changed or out-of-bound values cannot prove this settlement.
    return false;
  }
}

function writesOverlap(left: readonly string[], right: readonly string[]): boolean {
  return left.length <= right.length
    ? left.every((key, index) => key === right[index])
    : right.every((key, index) => key === left[index]);
}

function settlementPath(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 16) throw new TypeError(`${WHERE}: invalid settlement path`);
  return Array.from({ length: value.length }, (_, index) => {
    const key = ownValue(value, index);
    if (typeof key !== 'string' || key.length > 128 || isDeniedSegment(key))
      throw new TypeError(`${WHERE}: invalid settlement path segment`);
    return key;
  });
}

export interface DeclaredFailureOwner {
  assertLive(): void;
  nextSeries(): string;
  stage(key: string, value: unknown, writes: readonly DeclaredWrite[]): void;
}

/** A scope's handles are private to its native attempt and never enter a record. */
export function declaredFailureScope(owner: DeclaredFailureOwner): DeclaredFailures {
  const issued = new WeakMap<DeclaredDispatch, { series: string; target: string }>();
  let count = 0;
  return Object.freeze({
    begin(target: string): DeclaredDispatch {
      owner.assertLive();
      if (count >= MAX_CALL_RECORDS) throw new RangeError(`${WHERE}: dispatch limit reached`);
      const name = admitAttemptName(WHERE, 'target', target);
      const dispatch = Object.freeze({}) as DeclaredDispatch;
      issued.set(dispatch, { series: owner.nextSeries(), target: name });
      count++;
      return dispatch;
    },
    setValue(key: string, value: unknown, settlements: readonly DeclaredSettlement[]): void {
      owner.assertLive();
      if (!Array.isArray(settlements) || settlements.length === 0 || settlements.length > MAX_CALL_RECORDS)
        throw new TypeError(`${WHERE}: invalid settlement batch`);
      const handles = new Set<DeclaredDispatch>();
      const positions = new Set<string>();
      const writes = Array.from({ length: settlements.length }, (_, index) => {
        const settlement = ownValue(settlements, index);
        const dispatch = ownValue(settlement, 'dispatch') as DeclaredDispatch;
        const known = issued.get(dispatch);
        if (!known || handles.has(dispatch)) throw new TypeError(`${WHERE}: unavailable dispatch`);
        const at = settlementPath(ownValue(settlement, 'at'));
        const position = JSON.stringify(at);
        if (positions.has(position)) throw new TypeError(`${WHERE}: duplicate settlement path`);
        const category = ownValue(settlement, 'category');
        const startedAt = ownValue(settlement, 'startedAt');
        const durationMs = ownValue(settlement, 'durationMs');
        if (!CATEGORIES.has(category)) throw new TypeError(`${WHERE}: invalid failure category`);
        if (!validTime(startedAt) || !validTime(durationMs)) throw new TypeError(`${WHERE}: invalid dispatch timing`);
        const expected = canonicalizeJson(ownPath(value, at), LIMITS);
        handles.add(dispatch);
        positions.add(position);
        return {
          at,
          value: expected,
          record: freezeDeep<AttemptRecord>({
            ...known,
            kind: 'observed',
            attempt: 1,
            startedAt,
            durationMs,
            outcome: 'failed',
            category: category as AttemptCategory,
            provenance: 'declared',
            decision: { rules: [], chosen: 'done', default: 'done', defaultLabel: 'answered' },
            next: 'done',
            reason: 'answered',
          }),
        };
      });
      owner.assertLive();
      for (const dispatch of handles) {
        if (!issued.has(dispatch)) throw new TypeError(`${WHERE}: unavailable dispatch`);
      }
      for (const dispatch of handles) issued.delete(dispatch);
      owner.stage(key, value, writes);
    },
  });
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}
