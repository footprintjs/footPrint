/** Source-only checkouts borrow the app's whole dependency tree, as its own CI does.
 * They are not package installations. Never hide an existing install or alias a single package.
 */
import { lstatSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function installedBelow(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.name === 'node_modules') return path;
    if (entry.isSymbolicLink()) return `symbolic link ${path}`;
    if (entry.isDirectory()) {
      const nested = installedBelow(path);
      if (nested) return nested;
    }
  }
  return null;
}

/** Refuse ambiguous ownership BEFORE npm installs anything, including on a fallback leg. */
export function sourceWorkspaceProblem(consumer, sourceOnly) {
  if (!sourceOnly.length) return null;
  const home = dirname(consumer);
  for (const dir of sourceOnly) {
    if (dirname(dir) !== home || resolve(dir) === resolve(consumer))
      return `source-only checkout is not a sibling: ${dir}`;
    const installed = installedBelow(dir);
    if (installed) return `source-only checkout contains a separate install or link: ${installed}`;
  }
  const ancestor = join(home, 'node_modules');
  if (exists(ancestor)) {
    try {
      if (
        !lstatSync(ancestor).isSymbolicLink() ||
        realpathSync(ancestor) !== realpathSync(join(consumer, 'node_modules'))
      ) {
        return `source workspace already has a different dependency tree: ${ancestor}`;
      }
    } catch {
      return `source workspace has a broken dependency link: ${ancestor}`;
    }
  }
  return null;
}

function resolvedPackage(root, name) {
  try {
    return realpathSync(createRequire(join(root, '__audit__.cjs')).resolve(`${name}/package.json`));
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
}

/** Connect the complete installed app tree, then prove module lookup uses its canonical owners. */
export function connectSourceWorkspace(consumer, sourceOnly) {
  const problem = sourceWorkspaceProblem(consumer, sourceOnly);
  if (problem || !sourceOnly.length) return problem;
  const ancestor = join(dirname(consumer), 'node_modules');
  if (!exists(ancestor)) symlinkSync(join(consumer, 'node_modules'), ancestor, 'dir');
  for (const name of ['footprintjs', 'foottrace']) {
    const owner = resolvedPackage(consumer, name);
    if (!owner && name === 'footprintjs') return 'source workspace is missing the installed footprintjs';
    for (const sibling of sourceOnly) {
      if (resolvedPackage(sibling, name) !== owner)
        return `${sibling}: ${name} does not resolve to the consumer's owner`;
    }
  }
  return null;
}
