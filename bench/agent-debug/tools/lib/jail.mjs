/**
 * The path jail: every file tool resolves a model-given path INSIDE the run's
 * working folder, or refuses.
 *
 * Why so strict: the path is untrusted model output. Refused: an empty path,
 * a NUL byte, an absolute path, any `..` segment, a backslash, and any
 * symbolic link on the way (a link could point out of the folder even when
 * the text of the path does not). The real path is checked against the real
 * root as the last word.
 * Example: `resolveInside('/tmp/run', 'src/chart.mjs')` → `/tmp/run/src/chart.mjs`;
 * `resolveInside('/tmp/run', '../x')` throws.
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

export class JailError extends Error {}

/**
 * @param {string} root the working folder (a real path)
 * @param {string} given the model's path, relative to the root
 * @param {{ mustExist?: boolean }} [options]
 * @returns {{ abs: string, rel: string }}
 */
export function resolveInside(root, given, options = {}) {
  if (typeof given !== 'string' || given.trim() === '') throw new JailError('the path is empty');
  if (given.includes('\0')) throw new JailError('the path holds a NUL byte');
  if (given.includes('\\')) throw new JailError('use / in paths');
  if (isAbsolute(given) || given.startsWith('~')) throw new JailError('give a path relative to the working folder');
  const segments = given.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) throw new JailError('".." is not allowed in a path');
  const realRoot = realpathSync(root);
  let current = realRoot;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existsSync(current)) {
      if (options.mustExist !== false) throw new JailError(`no such file or folder: ${segments.join('/')}`);
      break;
    }
    if (lstatSync(current).isSymbolicLink()) throw new JailError('symbolic links are not followed');
  }
  const abs = join(realRoot, ...segments);
  const check = existsSync(abs) ? realpathSync(abs) : abs;
  const rel = relative(realRoot, check);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new JailError('the path leaves the working folder');
  return { abs: check, rel: rel.split(sep).join('/') };
}
