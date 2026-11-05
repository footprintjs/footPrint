/** Passive native wrappers: each original call runs once, with its exact return/throw. */
import { addressOf, bad, BUFFER, definedness, own, readMethod, STAGE } from './data.js';
import type { Header, Hooks, Method, NativeFact, Receipt } from './observationTypes.js';
export { UnsupportedReadLawObservation } from './data.js';
export type { Header, Hooks, NativeFact, Receipt } from './observationTypes.js';
export { requireDeletedReadInput, sameStageDeletedReadInputs } from './selector.js';

const ACTIVE = new WeakSet<object>();
export function installReadLawObservation(hooks: Hooks, leg: string) {
  if (typeof leg !== 'string' || !leg.length) return bad();
  const stage = hooks.StageContext.prototype;
  const buffer = hooks.TransactionBuffer.prototype;
  const surfaces = [stage, buffer];
  if (new Set(surfaces).size !== surfaces.length || surfaces.some((surface) => ACTIVE.has(surface))) return bad();
  const patches: { object: object; key: string; descriptor: PropertyDescriptor; wrap: (native: Method) => Method }[] =
    [];
  const events: NativeFact[] = [];
  const issues: string[] = [];
  const frames = new WeakMap<object, number>();
  const buffers = new WeakMap<object, number>();
  const epochs = new WeakMap<object, number>();
  const bufferOwners = new WeakMap<object, { epoch: number; frame: number }>();
  const owners: { context: object; phase: 'read' | 'write' | 'commit' }[] = [];
  const reading: { context: object; gets: number[] }[] = [];
  let frameCount = 0;
  let bufferCount = 0;
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
  const idOf = (map: WeakMap<object, number>, value: object, next: () => number) => {
    let id = map.get(value);
    if (id === undefined) {
      id = next();
      map.set(value, id);
    }
    return id;
  };
  const ownerOf = (context: object | undefined) =>
    context === undefined
      ? {}
      : {
          frame: idOf(frames, context, () => ++frameCount),
          header: capture((): Header => {
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
    events.push(Object.freeze(event));
  };
  const prepare = (object: object, key: string, required: boolean, wrap: (native: Method) => Method) => {
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
  for (const [method, required] of STAGE)
    prepare(
      stage,
      method,
      required,
      (native) =>
        function (...args) {
          const phase = method === 'commit' ? 'commit' : readMethod(method) ? 'read' : 'write';
          const owner = ownerOf(this);
          owners.push({ context: this, phase });
          const read = { context: this, gets: [] as number[] };
          if (readMethod(method)) reading.push(read);
          const start = ++clock;
          let result: unknown;
          let outcome: 'returned' | 'threw' = 'returned';
          try {
            result = Reflect.apply(native, this, args);
            return result;
          } catch (error) {
            outcome = 'threw';
            throw error;
          } finally {
            publish({
              id: start,
              start,
              end: ++clock,
              leg,
              tier: 'stage-call',
              method,
              outcome,
              phase,
              ...owner,
              ...(readMethod(method) && { gets: Object.freeze([...read.gets]) }),
              ...(readMethod(method) && outcome === 'returned' && { result: definedness(result) }),
            });
            if (readMethod(method)) reading.pop();
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
          const owner = ownerOf(active?.context);
          const start = ++clock;
          const id = idOf(buffers, this, () => ++bufferCount);
          const epoch = epochs.get(this) ?? 0;
          if (owner.frame !== undefined) {
            const bound = bufferOwners.get(this);
            if (bound?.epoch === epoch && bound.frame !== owner.frame) issues.push('native buffer owner conflict');
            else bufferOwners.set(this, { epoch, frame: owner.frame });
          }
          const address = method === 'commit' ? undefined : capture(() => addressOf(args[0]));
          let result: unknown;
          let outcome: 'returned' | 'threw' = 'returned';
          try {
            result = Reflect.apply(native, this, args);
            return result;
          } catch (error) {
            outcome = 'threw';
            throw error;
          } finally {
            publish({
              id: start,
              start,
              end: ++clock,
              leg,
              tier: 'buffer-call',
              method,
              outcome,
              phase: active?.phase,
              ...owner,
              buffer: id,
              epoch,
              address,
              ...((method === 'set' || method === 'merge') && { value: definedness(args[1]) }),
              ...(method === 'get' && outcome === 'returned' && { result: definedness(result) }),
            });
            if (method === 'get' && active?.phase === 'read')
              for (const read of reading) if (read.context === active.context) read.gets.push(start);
            if (method === 'commit') epochs.set(this, epoch + 1);
          }
        },
    );
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
    for (const surface of surfaces) ACTIVE.delete(surface);
    throw error;
  }
  return {
    receipt(): Receipt {
      return Object.freeze({
        leg,
        events: Object.freeze([...events].sort((a, b) => a.start - b.start)),
        issues: Object.freeze([...issues]),
      });
    },
    assertUsable(): void {
      if (issues.length) return bad();
    },
    restore(): void {
      if (restored) return;
      const failures: unknown[] = [];
      for (const patch of [...changed].reverse())
        try {
          Object.defineProperty(patch.object, patch.key, patch.descriptor);
        } catch (error) {
          failures.push(error);
        }
      for (const surface of surfaces) ACTIVE.delete(surface);
      restored = true;
      if (failures.length) throw new AggregateError(failures, 'Native read-law observation restoration failed.');
    },
  };
}
