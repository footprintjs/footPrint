'use strict';
const { fail } = require('./refusal.cjs');

// Canonical comparison from foottrace bb3c18244655b794d7c3660b0c35f2a510b45ea0.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
      .join(',') +
    '}'
  );
}

/** Accept JSON data only: no inherited/accessor values or coercion callbacks. */
function requireObjectRoot(value) {
  let count = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    if (++count > 100000 || depth > 64) fail('manifest-source', 'root');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item)) fail('manifest-source', 'root');
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array))
      fail('manifest-source', 'root');
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (array && keys.length !== item.length + 1) fail('manifest-source', 'root');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = descriptors[key];
      if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        fail('manifest-source', 'root');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) fail('manifest-source', 'root');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('manifest-source', 'root');
  visit(value, 0);
  if (Buffer.byteLength(canonical(value)) > 1024 * 1024) fail('manifest-source', 'root');
  for (const key of ['name', 'version'])
    if (!Object.hasOwn(value, key) || typeof value[key] !== 'string') fail('manifest-source', key);
}

function requireSourceManifest(manifest, source) {
  requireObjectRoot(manifest);
  requireObjectRoot(source);
  const keys = [...new Set([...Object.keys(manifest), ...Object.keys(source)])]
    .filter((key) => key !== 'version')
    .sort();
  for (const key of keys)
    if (
      !Object.hasOwn(manifest, key) ||
      !Object.hasOwn(source, key) ||
      canonical(manifest[key]) !== canonical(source[key])
    )
      fail('manifest-source', key);
}
module.exports = { requireSourceManifest };
