type Method = (this: object, ...args: any[]) => any;
export type Profile = 'baseline-full-payload' | 'rows-plus-redacted-paths';
export interface OriginPort {
  tick(): number;
  /** Existing witness projection: same bytes(), and ONLY its existing trace.readKeys omission. */
  snapshotRows(value: unknown): string;
  snapshotPaths(value: unknown): string;
}
export interface OriginProof {
  readonly method: 'toChangeOnlyPayload' | 'toDeltaPayload';
  readonly start: number;
  readonly end: number;
  readonly bytes: string;
  readonly mode: 'full' | 'delta';
}
interface Capture {
  mode: 'full' | 'delta';
  commitStart: number;
  errors: string[];
  rows?: { method: OriginProof['method']; start: number; end: number; bytes: string };
  paths?: string;
}
const own = (value: object, key: string): unknown => {
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d || !Object.hasOwn(d, 'value')) throw new Error('Missing native producer field.');
  return d.value;
};
/** Own native methods only; every method is forwarded once and every descriptor restored. */
export function installCommitOrigins(prototype: object, profile: Profile, port: OriginPort) {
  const active = new WeakMap<object, Capture>();
  const patches: { key: string; descriptor: PropertyDescriptor; value: Method }[] = [];
  const prepare = (key: string, wrap: (native: Method) => Method) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (
      !descriptor ||
      !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'function' ||
      (!descriptor.configurable && !descriptor.writable)
    )
      throw new Error('Native producer layout moved.');
    patches.push({ key, descriptor, value: wrap(descriptor.value) });
  };
  const capture = (state: Capture, go: () => void) => {
    try {
      go();
    } catch {
      state.errors.push('unsupported native producer output');
    }
  };
  for (const method of ['toChangeOnlyPayload', 'toDeltaPayload'] as const)
    prepare(
      method,
      (native) =>
        function (...args) {
          const state = active.get(this);
          const start = port.tick();
          // Call/throw untouched. The snapshot is AFTER the final admit, BEFORE an outer commit wrapper can edit it.
          const output = Reflect.apply(native, this, args);
          if (state)
            capture(state, () => {
              if (state.rows) throw new Error('Repeated native encoder.');
              state.rows = { method, start, end: port.tick(), bytes: port.snapshotRows(output) };
            });
          return output;
        },
    );
  if (profile === 'rows-plus-redacted-paths')
    prepare(
      'survivingRedactedPaths',
      (native) =>
        function (...args) {
          const output = Reflect.apply(native, this, args);
          const state = active.get(this);
          if (state)
            capture(state, () => {
              if (state.paths !== undefined) throw new Error('Repeated native path producer.');
              state.paths = port.snapshotPaths(output);
            });
          return output;
        },
    );
  const changed: typeof patches = [];
  try {
    for (const patch of patches) {
      Object.defineProperty(prototype, patch.key, { ...patch.descriptor, value: patch.value });
      changed.push(patch);
    }
  } catch (error) {
    for (const patch of changed.reverse()) Object.defineProperty(prototype, patch.key, patch.descriptor);
    throw error;
  }
  return {
    /** Called by the SAME observer's actual buffer.commit wrapper on actual this, before it calls native. */
    begin(buffer: object, commitStart: number, mode: 'full' | 'delta') {
      if (active.has(buffer)) throw new Error('Overlapping native commit observation.');
      active.set(buffer, { commitStart, mode, errors: [] });
    },
    /** Called from that wrapper's finally. No outer return value enters this function. */
    finish(buffer: object): OriginProof | undefined {
      const state = active.get(buffer);
      active.delete(buffer);
      if (!state || state.errors.length || !state.rows) return undefined;
      const row = state.rows;
      const expected = state.mode === 'full' ? 'toChangeOnlyPayload' : 'toDeltaPayload';
      if (row.method !== expected || row.start <= state.commitStart) return undefined;
      try {
        const parsed = JSON.parse(row.bytes);
        if (
          JSON.stringify(parsed) !== row.bytes ||
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        )
          return undefined;
        let bytes: string;
        if (profile === 'baseline-full-payload') {
          if (
            JSON.stringify(Object.keys(parsed)) !== JSON.stringify(['overwrite', 'updates', 'redactedPaths', 'trace'])
          )
            return undefined;
          bytes = row.bytes;
        } else {
          if (
            state.paths === undefined ||
            JSON.stringify(Object.keys(parsed)) !== JSON.stringify(['overwrite', 'updates', 'trace'])
          )
            return undefined;
          const paths = JSON.parse(state.paths);
          if (JSON.stringify(paths) !== state.paths) return undefined;
          bytes = JSON.stringify({
            overwrite: own(parsed, 'overwrite'),
            updates: own(parsed, 'updates'),
            redactedPaths: paths,
            trace: own(parsed, 'trace'),
          });
        }
        return Object.freeze({ method: row.method, start: row.start, end: row.end, bytes, mode: state.mode });
      } catch {
        return undefined;
      }
    },
    restore() {
      const failures: unknown[] = [];
      for (const patch of [...changed].reverse()) {
        try {
          Object.defineProperty(prototype, patch.key, patch.descriptor);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Native producer restoration failed.');
    },
  };
}
