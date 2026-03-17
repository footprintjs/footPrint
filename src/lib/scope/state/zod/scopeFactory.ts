/**
 * Scope Proxy Factory — Build lazy, copy-on-write scope from a Zod object schema
 */

import { type ZodTypeAny, z } from 'zod';

import type { StageContextLike, StrictMode } from '../../providers/types.js';
import { getRecordValueType, isZodNode, parseWithThis, unwrap } from './utils/validateHelper.js';

function validateOnWrite(
  schema: ZodTypeAny,
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
  schema: ZodTypeAny;
  fields?: Record<string, Node>;
  value?: Node;
  element?: Node;
};

function analyze(schema: ZodTypeAny): Node {
  const base = unwrap(schema) ?? schema;

  if (base instanceof z.ZodObject) {
    const def = (base as any)._def;
    const shapeOrFn = def?.shape;
    const shapeObj: Record<string, ZodTypeAny> = typeof shapeOrFn === 'function' ? shapeOrFn() : shapeOrFn ?? {};
    const fields: Record<string, Node> = {};
    for (const [k, v] of Object.entries(shapeObj)) fields[k] = analyze(v as ZodTypeAny);
    return { kind: 'object', schema: base, fields };
  }

  if (base instanceof z.ZodRecord) {
    const valueType = getRecordValueType(base);
    return { kind: 'record', schema: base, value: analyze((valueType ?? z.any()) as ZodTypeAny) };
  }

  if (base instanceof z.ZodArray) {
    const def = (base as any)._def;
    const elemType = def?.type as ZodTypeAny;
    return { kind: 'array', schema: base, element: analyze((elemType ?? z.any()) as ZodTypeAny) };
  }

  return { kind: 'scalar', schema: base };
}

const join = (path: string[], key?: string) => (key ? [...path, key].join('.') : path.join('.'));
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

/** Build lazy, copy-on-write scope from a Zod object schema */
export function createScopeProxyFromZod<S extends z.ZodObject<any>>(
  ctx: StageContextLike,
  schema: S,
  strict: StrictMode = 'warn',
  readOnly?: unknown,
): z.infer<S> & { ro?: unknown } {
  if (!isZodNode(schema)) throw new TypeError('createScopeProxyFromZod: expected a Zod object schema');
  const root = analyze(schema as unknown as ZodTypeAny);
  const proxy = makeProxy(ctx, root, [], undefined, strict);
  Object.defineProperty(proxy, 'ro', { value: readOnly, enumerable: false });
  return proxy;
}
