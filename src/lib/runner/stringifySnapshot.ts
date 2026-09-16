/**
 * stringifySnapshot — `JSON.stringify` for a run's record, without the
 * engine's recursion limit.
 *
 * WHY. A run's `executionTree` links stages by `next`, one level per stage,
 * so a long linear run is a deep chain. V8's `JSON.parse` reads a chain ten
 * thousand levels deep (measured), but `JSON.stringify` is recursive and
 * throws `RangeError: Maximum call stack size exceeded` well before that —
 * the record of such a run could not be saved as one artifact. This encoder
 * walks with its own stack and emits the SAME bytes `JSON.stringify` would
 * (pinned byte-for-byte by test/lib/runner/stringifySnapshot.test.ts, on real
 * snapshots and on a fast-check property over JSON values), so nothing that
 * reads a record changes: the shape stays nested, `JSON.parse` reads it.
 *
 * Same contract as `JSON.stringify(value)` with no replacer and no indent:
 * `toJSON` is honoured, `undefined` / functions / symbols vanish from objects
 * and become `null` in arrays, non-finite numbers become `null`, a BigInt or
 * a cycle throws the same `TypeError`. Use it wherever a record is written —
 * a recording, an artifact, a fixture — in place of `JSON.stringify`.
 */

type Frame =
  | { readonly kind: 'array'; readonly value: readonly unknown[]; index: number }
  | {
      readonly kind: 'object';
      readonly value: Record<string, unknown>;
      readonly keys: readonly string[];
      index: number;
      first: boolean;
    };

/** `value` as JSON.stringify would see it at `key`: after `toJSON`, or absent. */
function seen(value: unknown, key: string): unknown {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') value = (toJSON as (k: string) => unknown).call(value, key);
  }
  return value;
}

function absent(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

export function stringifySnapshot(root: unknown): string {
  const out: string[] = [];
  const stack: Frame[] = [];
  const ancestors = new Set<object>();

  // Emit a scalar, or open a container and push its frame. `value` is already `seen`.
  const emit = (value: unknown): void => {
    if (value === null) {
      out.push('null');
      return;
    }
    switch (typeof value) {
      case 'string':
        out.push(JSON.stringify(value));
        return;
      case 'number':
        out.push(Number.isFinite(value) ? String(value) : 'null');
        return;
      case 'boolean':
        out.push(value ? 'true' : 'false');
        return;
      case 'bigint':
        throw new TypeError('Do not know how to serialize a BigInt');
      case 'object': {
        if (ancestors.has(value as object)) throw new TypeError('Converting circular structure to JSON');
        ancestors.add(value as object);
        if (Array.isArray(value)) {
          out.push('[');
          stack.push({ kind: 'array', value, index: 0 });
        } else {
          out.push('{');
          stack.push({
            kind: 'object',
            value: value as Record<string, unknown>,
            keys: Object.keys(value as object),
            index: 0,
            first: true,
          });
        }
        return;
      }
      default:
        // undefined / function / symbol at a place that must hold a value
        out.push('null');
    }
  };

  const top = seen(root, '');
  if (absent(top)) return undefined as unknown as string;
  emit(top);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.kind === 'array') {
      if (frame.index >= frame.value.length) {
        out.push(']');
        ancestors.delete(frame.value);
        stack.pop();
        continue;
      }
      if (frame.index > 0) out.push(',');
      const element = seen(frame.value[frame.index], String(frame.index));
      frame.index += 1;
      emit(absent(element) ? null : element);
      continue;
    }
    // object
    let advanced = false;
    while (frame.index < frame.keys.length) {
      const key = frame.keys[frame.index]!;
      frame.index += 1;
      const value = seen(frame.value[key], key);
      if (absent(value)) continue;
      out.push(frame.first ? JSON.stringify(key) + ':' : ',' + JSON.stringify(key) + ':');
      frame.first = false;
      emit(value);
      advanced = true;
      break;
    }
    if (!advanced) {
      out.push('}');
      ancestors.delete(frame.value);
      stack.pop();
    }
  }
  return out.join('');
}
