/**
 * Scope Proxy Factory — Build lazy, copy-on-write scope from a Zod object schema
 */

import { isDeniedSegment } from 'foottrace/paths';

import { createFrozenArgs } from '../../protection/readonlyInput.js';
import type { StageContextLike, StrictMode } from '../../providers/types.js';
import {
  type ZodSchema,
  getArrayElementType,
  getObjectShape,
  getRecordValueType,
  getZodKind,
  isZodNode,
  parseWithThis,
  unwrap,
} from './utils/validateHelper.js';

function validateOnWrite(
  schema: ZodSchema,
  value: unknown,
  ctx?: StageContextLike,
  strict: StrictMode = 'warn',
  tag?: string,
): boolean {
  if (strict === 'off') return true;
  try {
    parseWithThis(schema, value);
    return true;
  } catch (err) {
    const msg = `[schema] invalid value in ${tag ?? 'set'}: ${(err as any)?.message ?? 'zod error'}`;
    ctx?.addError?.('schema', msg);
    if (strict === 'warn') return false;
    throw err;
  }
}

type NodeKind = 'object' | 'record' | 'array' | 'scalar';
type Node = {
  kind: NodeKind;
  schema: ZodSchema;
  fields?: Record<string, Node>;
  value?: Node;
  element?: Node;
};

function analyze(schema: ZodSchema): Node {
  const base = unwrap(schema) ?? schema;

  if (getZodKind(base) === 'object') {
    const shapeObj = getObjectShape(base);
    const fields: Record<string, Node> = Object.create(null);
    for (const [k, v] of Object.entries(shapeObj)) fields[k] = analyze(v);
    return { kind: 'object', schema, fields };
  }

  if (getZodKind(base) === 'record') {
    const valueType = getRecordValueType(base);
    if (!valueType) throw new TypeError('Zod record has no valid value schema.');
    return { kind: 'record', schema, value: analyze(valueType) };
  }

  if (getZodKind(base) === 'array') {
    const element = getArrayElementType(base);
    if (!element) throw new TypeError('Zod array has no valid element schema.');
    return { kind: 'array', schema, element: analyze(element) };
  }

  return { kind: 'scalar', schema };
}

const join = (path: string[], key?: string) => (key !== undefined ? [...path, key].join('.') : path.join('.'));
const readAt = <T>(ctx: StageContextLike, path: string[], key?: string) => ctx.getValue(path, key) as T | undefined;

function makeProxy(
  ctx: StageContextLike,
  node: Node,
  path: string[],
  key: string | undefined,
  strict: StrictMode,
): any {
  switch (node.kind) {
    case 'scalar':
      return {
        get: () => readAt(ctx, path, key),
        exists: () => typeof readAt(ctx, path, key) !== 'undefined',
        set: (v: unknown) => {
          if (!validateOnWrite(node.schema, v, ctx, strict, `set:${join(path, key)}`)) return;
          ctx.setObject(path, key ?? '__', v);
        },
      };

    case 'array': {
      const base = makeProxy(ctx, { ...node, kind: 'scalar' }, path, key, strict);
      base.push = (item: unknown) => {
        const cur = readAt<any[]>(ctx, path, key) ?? [];
        const next = [...cur, item];
        if (!validateOnWrite(node.schema, next, ctx, strict, `push:${join(path, key)}`)) return;
        ctx.setObject(path, key ?? '__', next);
      };
      return base;
    }

    case 'record': {
      const get = () => readAt<Record<string, unknown>>(ctx, path, key);
      const set = (v: Record<string, unknown>) => {
        if (!validateOnWrite(node.schema, v, ctx, strict, `set:${join(path, key)}`)) return;
        ctx.setObject(path, key ?? '__', v);
      };
      const merge = (p: Record<string, unknown>) => {
        const cur = get() ?? {};
        const next = { ...cur, ...p };
        if (!validateOnWrite(node.schema, next, ctx, strict, `merge:${join(path, key)}`)) return;
        ctx.updateObject(path, key ?? '__', p);
      };
      return {
        at: (dynKey: string) => {
          if (typeof dynKey !== 'string') {
            throw new TypeError('Zod scope record key must be a string.');
          }
          if (isDeniedSegment(dynKey)) {
            throw new TypeError(`Zod scope record key '${dynKey}' is an unsafe path segment.`);
          }
          const parentPath = typeof key === 'string' ? [...path, key] : path;
          return makeProxy(ctx, node.value!, parentPath, dynKey, strict);
        },
        keys: () => Object.keys(get() ?? {}),
        get,
        set,
        merge,
        exists: () => typeof get() !== 'undefined',
      };
    }

    case 'object': {
      const cache = new Map<string, any>();
      return new Proxy(
        {},
        {
          get(target, prop: string | symbol) {
            if (Object.prototype.hasOwnProperty.call(target, prop)) return Reflect.get(target as any, prop as any);

            if (prop === 'then') return undefined;
            if (prop === 'asymmetricMatch') return undefined;
            if (prop === 'constructor') return Object;
            if (prop === Symbol.toStringTag) return 'ScopeProxy';

            if (prop === 'get') return () => readAt(ctx, path, key);
            if (prop === 'exists')
              return () => {
                const direct = readAt(ctx, path, key);
                if (typeof direct !== 'undefined') return true;
                if (node.fields) {
                  const parentPath = typeof key === 'string' ? [...path, key] : path;
                  for (const childKey of Object.keys(node.fields)) {
                    if (typeof readAt(ctx, parentPath, childKey) !== 'undefined') return true;
                  }
                }
                return false;
              };
            if (prop === 'toJSON') return () => readAt(ctx, path, key);

            if (typeof prop !== 'string') return undefined;
            if (!node.fields || !Object.prototype.hasOwnProperty.call(node.fields, prop)) {
              throw new Error(`Unknown field '${String(prop)}' under ${join(path, key) || '<root>'} `);
            }
            if (cache.has(prop)) return cache.get(prop);

            const child = node.fields[prop]!;
            const parentPath = typeof key === 'string' ? [...path, key] : path;
            const childProxy = makeProxy(ctx, child, parentPath, prop, strict);
            cache.set(prop, childProxy);
            return childProxy;
          },
        },
      );
    }
  }
}

const OBJECT_METHODS = new Set(['get', 'exists', 'then', 'asymmetricMatch', 'constructor', 'toJSON']);

function assertFieldNames(node: Node, path: string[], rootMethods: ReadonlySet<string>): void {
  if (node.kind === 'record') {
    assertFieldNames(node.value!, [...path, '*'], rootMethods);
  } else if (node.kind === 'object') {
    for (const [key, child] of Object.entries(node.fields!)) {
      if (isDeniedSegment(key)) {
        throw new TypeError(`Zod scope field '${join(path, key)}' contains an unsafe path segment.`);
      }
      if (OBJECT_METHODS.has(key) || (path.length === 0 && (key === 'ro' || rootMethods.has(key)))) {
        throw new TypeError(`Zod scope field '${join(path, key)}' is reserved for a scope method or runtime probe.`);
      }
      assertFieldNames(child, [...path, key], rootMethods);
    }
  }
}

/** Analyze once; each stage gets fresh proxies and a lazy owned argument view. */
export function prepareZodScope(schema: ZodSchema, rootMethods: readonly string[] = []) {
  if (!isZodNode(schema)) throw new TypeError('createScopeProxyFromZod: expected a Zod object schema');
  const root = analyze(schema);
  if (root.kind !== 'object') throw new TypeError('createScopeProxyFromZod: expected a Zod object schema');
  assertFieldNames(root, [], new Set(rootMethods));
  return (ctx: StageContextLike, strict: StrictMode, readArgs: () => unknown): any => {
    const proxy = makeProxy(ctx, root, [], undefined, strict);
    Object.defineProperty(proxy, 'ro', { get: readArgs, enumerable: false });
    return proxy;
  };
}

/** Low-level adapter; executor consumers should use defineScopeFromZod. */
export function createScopeProxyFromZod<S extends ZodSchema>(
  ctx: StageContextLike,
  schema: S,
  strict: StrictMode = 'warn',
  readOnly?: unknown,
): (S extends { _output: infer T } ? T : unknown) & { ro?: unknown } {
  const frozenArgs = createFrozenArgs(readOnly);
  return prepareZodScope(schema)(ctx, strict, () => frozenArgs);
}
