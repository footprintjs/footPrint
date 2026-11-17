/** Closed AF public export-map shapes; unsupported conditions require an explicit adapter change. */
export function publicTarget(selected, key, format) {
  if (!['root', 'providers', 'observe'].includes(key) || !['cjs', 'esm'].includes(format))
    throw Error('unsupported public export role');
  const exports = selected.manifest?.exports;
  const subpath = key === 'root' ? '.' : './' + key;
  const mapping = exports && typeof exports === 'object' && !Array.isArray(exports) ? exports[subpath] : null;
  if (
    !mapping ||
    typeof mapping !== 'object' ||
    Array.isArray(mapping) ||
    Object.keys(mapping).length !== 2 ||
    !Object.hasOwn(mapping, 'import') ||
    !Object.hasOwn(mapping, 'require')
  )
    throw Error('unsupported public export conditions');
  let target = mapping[format === 'esm' ? 'import' : 'require'];
  if (target && typeof target === 'object' && !Array.isArray(target)) {
    if (Object.keys(target).length !== 2 || typeof target.types !== 'string' || typeof target.default !== 'string')
      throw Error('unsupported public export target conditions');
    target = target.default;
  }
  if (
    typeof target !== 'string' ||
    !target.startsWith('./') ||
    !selected.files.some((member) => member.path === 'package/' + target.slice(2))
  )
    throw Error('public export target is not an admitted member');
  return target.slice(2);
}
