/** Data port for the exact declaration-only reference, outside the root install. */
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const PUBLISHED_REFERENCE_INSTALL_COMMAND =
  'npm --prefix test/fixtures/published-reference ci --ignore-scripts --strict-peer-deps --registry=https://registry.npmjs.org';

/** Explicit repo-root data; no environment path, ambient alias or runtime import. */
export function publishedReferenceRoot(repoRoot: string): string {
  if (!isAbsolute(repoRoot))
    throw new TypeError('The published declaration reference needs an absolute repository root');
  const root = join(repoRoot, 'test', 'fixtures', 'published-reference', 'node_modules', 'footprintjs');
  let manifest: unknown;
  try {
    const directory = lstatSync(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error('The published declaration reference must be an ordinary fixture installation');
    }
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch (cause: unknown) {
    const missing = object(cause) && Object.hasOwn(cause, 'code') && cause.code === 'ENOENT';
    throw new Error(
      `Published declaration reference ${
        missing ? 'is not installed' : 'cannot be read'
      }. Run: ${PUBLISHED_REFERENCE_INSTALL_COMMAND}`,
      { cause },
    );
  }
  if (
    !object(manifest) ||
    !Object.hasOwn(manifest, 'name') ||
    manifest.name !== 'footprintjs' ||
    !Object.hasOwn(manifest, 'version') ||
    manifest.version !== '10.1.0' ||
    !Object.hasOwn(manifest, 'exports') ||
    manifest.exports === null ||
    typeof manifest.exports !== 'object' ||
    Array.isArray(manifest.exports) ||
    Object.keys(manifest.exports).length === 0
  ) {
    throw new Error(
      `Expected footprintjs10.1.0 declaration metadata in its fixture. Run: ${PUBLISHED_REFERENCE_INSTALL_COMMAND}`,
    );
  }
  return root;
}
