/** Test-only native observations; returns, throws and ordinary records remain unchanged. */
import { type OriginPort, type Profile, installCommitOrigins } from './commitOrigin.js';
import { createHeapObservation } from './heapObservation.js';
import { identityGraph } from './identityGraph.js';
import type {
  Header,
  HeapProfile,
  Hooks,
  Method,
  NativeFact,
  NativeReadScope,
  Receipt,
  Segment,
  ValueFact,
} from './observationTypes.js';
import { createOperationPort } from './operationPort.js';
export type { Header, Hooks, NativeFact, Receipt, ValueFact } from './observationTypes.js';

export class UnsupportedReadLawObservation extends Error {
  constructor() {
    super('Unsupported native read-law observation; no #124 proof may be admitted.');
  }
}
const bad = (): never => {
  throw new UnsupportedReadLawObservation();
};
const own = (object: object, key: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor !== undefined && !Object.hasOwn(descriptor, 'value')) return bad();
  return descriptor?.value;
};
const ACTIVE = new WeakSet<object>();
const STAGE = [
  ['getValue', true],
  ['getValueDirect', false],
  ['setObject', true],
  ['updateObject', true],
  ['setGlobal', false],
  ['updateGlobal', false],
  ['appendToArray', false],
  ['mergeObject', false],
  ['commit', true],
] as const;
const BUFFER = ['set', 'merge', 'delete', 'get', 'commit'] as const;

/** Closed inert-fixture value domain, detached immediately, without invoking accessors. */
function valueFact(value: unknown): ValueFact {
  const seen = new Map<object, number>();
  let nodes = 0;
  const visit = (item: unknown): ValueFact => {
    if (++nodes > 10_000) return bad();
    if (item === undefined) return Object.freeze({ kind: 'undefined' });
    if (item === null) return Object.freeze({ kind: 'null' });
    if (typeof item !== 'object') {
      if (!['string', 'number', 'boolean'].includes(typeof item)) return bad();
      return Object.freeze({
        kind: typeof item,
        value: typeof item === 'number' ? (Object.is(item, -0) ? '-0' : String(item)) : item,
      });
    }
    const prior = seen.get(item);
    if (prior !== undefined) return Object.freeze({ kind: 'ref', ref: prior });
    seen.set(item, seen.size + 1);
    if (item instanceof Date) {
      if (Reflect.ownKeys(item).length !== 0) return bad();
      return Object.freeze({ kind: 'date', value: Date.prototype.getTime.call(item) });
    }
    const array = Array.isArray(item);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return bad();
    const entries: unknown[] = [];
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string') return bad();
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!Object.hasOwn(descriptor, 'value')) return bad();
      if (array && key === 'length') continue;
      entries.push(Object.freeze([key, descriptor.enumerable === true, visit(descriptor.value)]));
    }
    return Object.freeze({
      kind: array ? 'array' : 'object',
      ...(array ? { value: own(item, 'length') } : {}),
      entries: Object.freeze(entries),
    });
  };
  return visit(value);
}
function addressOf(value: unknown): readonly Segment[] {
  if (!Array.isArray(value)) return bad();
  const result: Segment[] = [];
  for (let i = 0; i < value.length; i++) {
    const segment = own(value, String(i));
    if (typeof segment !== 'string' && !(typeof segment === 'number' && Number.isSafeInteger(segment))) return bad();
    result.push(segment);
  }
  return Object.freeze(result);
}
function at(root: unknown, address: readonly Segment[]): { found: boolean; value: unknown } {
  let current = root;
  for (const segment of address) {
    if (current === null || typeof current !== 'object') return { found: false, value: undefined };
    const descriptor = Object.getOwnPropertyDescriptor(current, String(segment));
    if (descriptor === undefined) return { found: false, value: undefined };
    if (!Object.hasOwn(descriptor, 'value')) return bad();
    current = descriptor.value;
  }
  return { found: true, value: current };
}

/** Every native function is called once; capture failure poisons proof, never its return/throw. */
export function installReadLawObservation(
  hooks: Hooks,
  leg: string,
  producer?: { profile: Profile; snapshotRows: OriginPort['snapshotRows']; snapshotPaths: OriginPort['snapshotPaths'] },
  heapProfile?: HeapProfile,
) {
  if (typeof leg !== 'string' || leg.length === 0) return bad();
  if (heapProfile !== undefined && !['baseline-stage-shared-memory', 'build-record-state'].includes(heapProfile))
    return bad();
  const stage = hooks.StageContext.prototype;
  const buffer = hooks.TransactionBuffer.prototype;
  const memory = heapProfile === undefined ? undefined : hooks.SharedMemory?.prototype;
  if (heapProfile !== undefined && !memory) return bad();
  const surfaces = memory ? [stage, buffer, memory] : [stage, buffer];
  if (new Set(surfaces).size !== surfaces.length || surfaces.some((surface) => ACTIVE.has(surface))) return bad();
  const patches: { object: object; key: string; descriptor: PropertyDescriptor; wrap: (method: Method) => Method }[] =
    [];
  const events: NativeFact[] = [];
  const issues: string[] = [];
  const frames = new WeakMap<object, number>();
  const buffers = new WeakMap<object, number>();
  const objects = new WeakMap<object, number>();
  const epochs = new WeakMap<object, number>();
  const bufferOwners = new WeakMap<object, { epoch: number; frame: number }>();
  const owners: { context: object; phase: 'read' | 'write' | 'commit' }[] = [];
  const reading: NativeReadScope[] = [];
  let frameCount = 0;
  let bufferCount = 0;
  let objectCount = 0;
  let clock = 0;
  let restored = false;
  const capture = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      issues.push('unsupported native evidence');
      return undefined;
    }
  };
  const idOf = (map: WeakMap<object, number>, item: object, next: () => number) => {
    let id = map.get(item);
    if (id === undefined) {
      id = next();
      map.set(item, id);
    }
    return id;
  };
  const objectOf = (value: unknown) =>
    value !== null && typeof value === 'object' ? idOf(objects, value, () => ++objectCount) : undefined;
  const operations = createOperationPort({
    tick: () => ++clock,
    objectId: (value) => objectOf(value)!,
    snapshot: valueFact,
  });
  const lastCommits = new WeakMap<object, NativeFact>();
  const retainedKeys = new WeakMap<object, Map<string, string>>();
  const retentionMode = (context: object) => {
    const legacy = Object.getOwnPropertyDescriptor(context, 'readTracking');
    const modern = Object.getOwnPropertyDescriptor(context, 'policy');
    if (legacy && modern) return undefined; // No guessed precedence between incompatible private layouts.
    const mode = legacy
      ? own(context, 'readTracking')
      : modern
      ? (() => {
          const policy = own(context, 'policy');
          return policy !== null && typeof policy === 'object' ? own(policy, 'readTracking') : undefined;
        })()
      : undefined;
    if (mode !== 'full' && mode !== 'summary') return undefined; // OFF / unknown cannot create a retention claim.
    return Object.freeze({
      layout: legacy ? ('baseline-own-readTracking' as const) : ('build-own-policy' as const),
      mode,
    });
  };
  const readBag = (context: object): Map<string, unknown> | undefined => {
    const bag = own(context, '_stageReads');
    if (bag === undefined) return undefined; // no retained slot is claimed on a moved/absent optional surface
    if (bag === null || typeof bag !== 'object') return bad();
    const rows = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(bag)) {
      if (typeof key !== 'string' || rows.size >= 10_000) return bad();
      rows.set(key, own(bag, key));
    }
    return rows;
  };
  const retainedAfter = (
    context: object,
    args: unknown[],
    before: Map<string, unknown> | undefined,
    nativeId: number,
    frame: number | undefined,
    eligibility: ReturnType<typeof retentionMode>,
  ) => {
    if (
      !eligibility ||
      JSON.stringify(retentionMode(context)) !== JSON.stringify(eligibility) ||
      frame === undefined ||
      !before ||
      typeof args[1] !== 'string' ||
      !Array.isArray(args[0])
    )
      return undefined;
    const after = readBag(context);
    if (!after) return undefined;
    const path = addressOf(args[0]);
    const signature = JSON.stringify([path, args[1]]);
    const known = retainedKeys.get(context) ?? new Map<string, string>();
    retainedKeys.set(context, known);
    // No userKeyOf reimplementation. Observe the one own retained slot the actual read changed.
    const changed = [...after.keys()].filter((key) => !before.has(key) || !Object.is(before.get(key), after.get(key)));
    const key =
      path.length === 0 && after.has(args[1]) ? args[1] : changed.length === 1 ? changed[0] : known.get(signature);
    if (key === undefined || !after.has(key)) return undefined;
    if (known.has(signature) && known.get(signature) !== key) return bad();
    known.set(signature, key);
    return Object.freeze({ nativeId, frame, key, value: valueFact(after.get(key)), eligibility });
  };
  const ownerOf = (context: object | undefined) =>
    context === undefined
      ? {}
      : {
          frame: idOf(frames, context, () => ++frameCount),
          header: capture(() => {
            const stageId = own(context, 'stageId');
            const runId = own(context, 'runId');
            const runtimeStageId = own(context, 'runtimeStageId');
            if (
              typeof stageId !== 'string' ||
              typeof runId !== 'string' ||
              (runtimeStageId !== undefined && typeof runtimeStageId !== 'string')
            )
              return bad();
            return Object.freeze({ stageId, runId, ...(runtimeStageId !== undefined && { runtimeStageId }) });
          }),
        };
  const publish = (event: NativeFact) => {
    if (events.length >= 10_000) {
      issues.push('native observation bound exceeded');
      return;
    }
    const frozen = Object.freeze(event);
    events.push(frozen);
    return frozen;
  };
  const prepare = (object: object, key: string, required: boolean, wrap: (method: Method) => Method) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined && !required) return;
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'function' ||
      (!descriptor.configurable && !descriptor.writable)
    )
      return bad();
    patches.push({ object, key, descriptor, wrap });
  };
  const heap =
    heapProfile && memory
      ? createHeapObservation(heapProfile, memory, leg, {
          tick: () => ++clock,
          objectId: objectOf,
          snapshot: valueFact,
          capture,
          publish,
          currentRead: () => {
            const read = reading.at(-1);
            const owner = owners.at(-1);
            return read && owner?.context === read.context && owner.phase === 'read' ? read : undefined;
          },
        })
      : undefined;
  if (heap && memory) prepare(memory, 'getValue', true, heap.wrap);
  for (const [method, required] of STAGE)
    prepare(
      stage,
      method,
      required,
      (native) =>
        function (...args) {
          const phase =
            method === 'commit' ? 'commit' : method === 'getValue' || method === 'getValueDirect' ? 'read' : 'write';
          owners.push({ context: this, phase });
          const start = ++clock;
          const owner = ownerOf(this);
          const operation = operations.current()?.coordinate;
          const call = capture(() =>
            Object.freeze({
              args: Object.freeze(args.map(valueFact)),
              objects: Object.freeze(args.map(objectOf)),
              identities: Object.freeze(args.map((value) => identityGraph(value, (object) => objectOf(object)!))),
            }),
          );
          const isRead = method === 'getValue' || method === 'getValueDirect';
          const before = method === 'getValue' ? capture(() => readBag(this)) : undefined;
          const eligibility = method === 'getValue' ? capture(() => retentionMode(this)) : undefined;
          const heapBefore = isRead && heap ? capture(() => heap.point(this)) : undefined;
          const read: NativeReadScope = {
            id: start,
            context: this,
            ...owner,
            operation,
            gets: [],
            memoryGets: [],
          };
          if (isRead) reading.push(read);
          let result: unknown;
          let outcome: 'returned' | 'threw' = 'returned';
          try {
            result = Reflect.apply(native, this, args);
            return result;
          } catch (error) {
            outcome = 'threw';
            throw error;
          } finally {
            const heapAfter = isRead && heap ? capture(() => heap.point(this)) : undefined;
            publish({
              id: start,
              start,
              end: ++clock,
              leg,
              method,
              outcome,
              ...owner,
              phase,
              tier: 'stage-call',
              operation,
              call,
              ...(isRead &&
                outcome === 'returned' && {
                  result: capture(() => valueFact(result)),
                  resultObject: objectOf(result),
                  resultIdentities: capture(() => identityGraph(result, (object) => objectOf(object)!)),
                }),
              ...(method === 'getValue' &&
                outcome === 'returned' && {
                  retention: capture(() => retainedAfter(this, args, before, start, owner.frame, eligibility)),
                }),
              ...(isRead && { gets: Object.freeze([...read.gets]) }),
              ...(isRead && heap && { heapBefore, heapAfter, memoryGets: Object.freeze([...read.memoryGets]) }),
            });
            if (isRead) reading.pop();
            owners.pop();
          }
        },
    );
  for (const method of BUFFER)
    prepare(
      buffer,
      method,
      true,
      (native) =>
        function (...args) {
          const active = owners.at(-1);
          const start = ++clock;
          const owner = ownerOf(active?.context);
          const id = idOf(buffers, this, () => ++bufferCount);
          const epoch = epochs.get(this) ?? 0;
          const operation = operations.current()?.coordinate;
          if (owner.frame !== undefined) {
            const bound = bufferOwners.get(this);
            if (bound?.epoch === epoch && bound.frame !== owner.frame) issues.push('native buffer owner conflict');
            else bufferOwners.set(this, { epoch, frame: owner.frame });
          }
          const address = method === 'commit' ? undefined : capture(() => addressOf(args[0]));
          const base =
            method === 'get' && address !== undefined
              ? capture(() => {
                  const root = own(this, 'baseSnapshot');
                  // Missing optional ordinary-read base supplies no #124 provenance, not fabricated data.
                  if (root === undefined) return undefined;
                  const found = at(root, address);
                  return Object.freeze({
                    found: found.found,
                    value: valueFact(found.value),
                    object: objectOf(found.value),
                  });
                })
              : undefined;
          const value = method === 'set' || method === 'merge' ? capture(() => valueFact(args[1])) : undefined;
          const tombstone =
            active?.phase === 'write' &&
            active.context &&
            (method === 'delete' || (method === 'set' && args[1] === undefined));
          const heapBefore = tombstone && heap && active ? capture(() => heap.point(active.context)) : undefined;
          if (method === 'commit' && origins)
            capture(() => {
              const mode = own(this, 'commitValues');
              if (mode !== 'full' && mode !== 'delta') return bad();
              origins.begin(this, start, mode);
            });
          let result: unknown;
          let outcome: 'returned' | 'threw' = 'returned';
          try {
            result = Reflect.apply(native, this, args);
            return result;
          } catch (error) {
            outcome = 'threw';
            throw error;
          } finally {
            const encoder = method === 'commit' && origins ? capture(() => origins.finish(this)) : undefined;
            const heapAfter = tombstone && heap && active ? capture(() => heap.point(active.context)) : undefined;
            const event = publish({
              id: start,
              start,
              end: ++clock,
              leg,
              method,
              outcome,
              ...owner,
              phase: active?.phase,
              tier: 'buffer-call',
              operation,
              buffer: id,
              epoch,
              address,
              value,
              ...(method === 'set' || method === 'merge' ? { valueObject: objectOf(args[1]) } : {}),
              ...(encoder !== undefined && { encoder }),
              base,
              ...(tombstone && heap && { heapBefore, heapAfter }),
              ...(method === 'get' && outcome === 'returned' && { result: capture(() => valueFact(result)) }),
            });
            if (method === 'commit' && event) lastCommits.set(this, event);
            if (method === 'get' && reading.length) reading.at(-1)!.gets.push(start);
            if (method === 'commit') epochs.set(this, epoch + 1); // never carry a tombstone across commit/attempts
          }
        },
    );
  // The producer wraps actual inner encoders, never the outer commit return. It uses the SAME clock.
  const origins = producer
    ? installCommitOrigins(buffer, producer.profile, {
        tick: () => ++clock,
        snapshotRows: producer.snapshotRows,
        snapshotPaths: producer.snapshotPaths,
      })
    : undefined;
  // Validate every hook before changing any descriptor; partial installation still restores in reverse.
  for (const surface of surfaces) ACTIVE.add(surface);
  const changed: typeof patches = [];
  try {
    for (const patch of patches) {
      Object.defineProperty(patch.object, patch.key, {
        ...patch.descriptor,
        value: patch.wrap(patch.descriptor.value),
      });
      changed.push(patch);
    }
  } catch (error) {
    for (const patch of changed.reverse()) Object.defineProperty(patch.object, patch.key, patch.descriptor);
    origins?.restore();
    for (const surface of surfaces) ACTIVE.delete(surface);
    throw error;
  }
  return {
    operations,
    /** Actual receiver join used immediately by patchWitness before its independent replay. */
    commitOf: (actualBuffer: object) => lastCommits.get(actualBuffer),
    receipt(): Receipt {
      return Object.freeze({
        leg,
        events: Object.freeze([...events].sort((a, b) => a.start - b.start)),
        issues: Object.freeze([...issues, ...operations.receipt().issues]),
      });
    },
    assertUsable(): void {
      if (issues.length || operations.receipt().issues.length) return bad();
    },
    restore(): void {
      if (restored) return;
      const errors: unknown[] = [];
      for (const patch of [...changed].reverse()) {
        try {
          Object.defineProperty(patch.object, patch.key, patch.descriptor);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        origins?.restore();
      } catch (error) {
        errors.push(error);
      }
      for (const surface of surfaces) ACTIVE.delete(surface);
      restored = true;
      if (errors.length) throw new AggregateError(errors, 'Native read-law observation restoration failed.');
    },
  };
}

const prefix = (a: readonly Segment[], b: readonly Segment[]) =>
  a.length <= b.length && a.every((part, i) => part === b[i]);
const overlaps = (a: readonly Segment[], b: readonly Segment[]) => prefix(a, b) || prefix(b, a);
const mutation = (event: NativeFact) => ['set', 'merge', 'delete'].includes(event.method);

/** Closed local-law INPUTS only: no cross-engine admission or causal replay is implemented here. */
export function sameStageDeletedReadInputs(receipt: Receipt): readonly {
  read: NativeFact;
  get: NativeFact;
  deletedBy: NativeFact;
}[] {
  if (receipt.issues.length) return bad();
  const result: { read: NativeFact; get: NativeFact; deletedBy: NativeFact }[] = [];
  const byId = new Map(receipt.events.map((event) => [event.id, event]));
  for (const read of receipt.events) {
    if (
      read.leg !== receipt.leg ||
      !['getValue', 'getValueDirect'].includes(read.method) ||
      read.outcome !== 'returned' ||
      read.frame === undefined ||
      read.header === undefined ||
      read.result === undefined ||
      read.gets?.length !== 1
    )
      continue;
    const get = byId.get(read.gets[0]);
    if (
      !get ||
      get.leg !== receipt.leg ||
      get.method !== 'get' ||
      get.phase !== 'read' ||
      get.outcome !== 'returned' ||
      get.frame !== read.frame ||
      get.buffer === undefined ||
      get.epoch === undefined ||
      get.address === undefined ||
      get.base === undefined
    )
      continue;
    const writes = receipt.events.filter(
      (event) =>
        event.leg === receipt.leg &&
        mutation(event) &&
        event.outcome === 'returned' &&
        event.buffer === get.buffer &&
        event.epoch === get.epoch &&
        event.address !== undefined &&
        event.end < read.start,
    );
    const deleted = [...writes]
      .reverse()
      .find(
        (event) =>
          event.phase === 'write' &&
          event.frame === read.frame &&
          prefix(event.address!, get.address!) &&
          (event.method === 'delete' || (event.method === 'set' && event.value?.kind === 'undefined')),
      );
    if (!deleted) continue;
    if (
      writes.some(
        (event) =>
          event.start > deleted.end &&
          (overlaps(event.address!, deleted.address!) || overlaps(event.address!, get.address!)),
      )
    )
      continue;
    result.push(Object.freeze({ read, get, deletedBy: deleted }));
  }
  return Object.freeze(result);
}

/** A caller asking to admit a particular read cannot treat missing/ambiguous evidence as success. */
export function requireDeletedReadInput(receipt: Receipt, readId: number) {
  const input = sameStageDeletedReadInputs(receipt).find(({ read }) => read.id === readId);
  return input ?? bad();
}
