/** E4 onward: an installed dependency graph has at most one physical Foottrace instance. */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => object(value) && Object.hasOwn(value, key);
const failure = (message) => ({ ok: false, status: 'FAIL', message: `Foottrace: FAIL — ${message}` });

/** Inspect npm's complete tree: filtered `npm ls foottrace` omits uninstalled optional declarations. */
export function checkFoottraceTree(tree, { required = false } = {}) {
  try {
    if (!object(tree) || typeof tree.name !== 'string' || typeof tree.path !== 'string' || !object(tree._dependencies))
      throw new Error('npm did not provide a complete installed dependency tree');
    const copies = new Map();
    const versions = new Set();
    let declared = required;
    function walk(node, name, root = false) {
      if (!object(node)) throw new Error('npm returned a malformed dependency entry');
      for (const field of ['_dependencies', 'peerDependencies', ...(root ? ['devDependencies'] : [])])
        if (node[field] !== undefined && !object(node[field]))
          throw new Error(`npm returned malformed ${field} declarations`);
      declared ||= owns(node._dependencies, 'foottrace') || owns(node.peerDependencies, 'foottrace');
      if (root) declared ||= owns(node.devDependencies, 'foottrace');
      if (name === 'foottrace' || node.name === 'foottrace') {
        if (node.missing || node.invalid || node.error || node.problems?.length)
          throw new Error(`missing or invalid dependency at ${node.path ?? name}`);
        if (typeof node.version !== 'string' || !node.version || typeof node.path !== 'string')
          throw new Error('Foottrace dependency has no resolved version or installation path');
        const path = realpathSync(node.path);
        const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
        if (pkg.name !== 'foottrace' || pkg.version !== node.version)
          throw new Error(`installed package identity does not match npm's Foottrace entry at ${path}`);
        copies.set(path, node.version);
        versions.add(node.version);
      }
      if (node.dependencies !== undefined && !object(node.dependencies))
        throw new Error('npm returned a malformed dependency list');
      for (const [child, info] of Object.entries(node.dependencies ?? {})) walk(info, child);
    }
    walk(tree, tree.name, true);
    if (!copies.size) {
      if (declared) throw new Error('a Foottrace dependency is declared or required but none is installed');
      return {
        ok: true,
        status: 'NOT APPLICABLE',
        message: 'Foottrace: NOT APPLICABLE — not migrated / no Foottrace dependency',
      };
    }
    if (versions.size !== 1 || copies.size !== 1)
      throw new Error(
        `expected one physical instance; found ${copies.size} paths (${[...copies]
          .map(([path, version]) => `${path}@${version}`)
          .join(', ')})`,
      );
    const [version] = versions;
    const [path] = copies.keys();
    return {
      ok: true,
      status: 'PASS',
      version,
      path,
      message: `Foottrace: PASS — one physical instance of ${version}`,
    };
  } catch (error) {
    return failure(error.message);
  }
}

/** Read-only; an unsuccessful inspection never becomes legacy N/A, even if it emits valid JSON. */
export function inspectFoottrace(root, { required = false, run = spawnSync } = {}) {
  try {
    const result = run('npm', ['ls', '--all', '--json', '--long'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
      const detail = result.stderr?.trim().slice(0, 1000);
      return failure(
        `cannot inspect installed dependencies (npm ls ${result.error?.message ?? `exit ${result.status}`})${
          detail ? `: ${detail}` : ''
        }`,
      );
    }
    return checkFoottraceTree(JSON.parse(result.stdout), { required });
  } catch (error) {
    return failure(`cannot inspect npm's installed dependency tree: ${error.message}`);
  }
}

/** Linked siblings execute together: separately valid installs must also share physical identity. */
export function inspectFoottraceWorkspace(roots, options = {}) {
  if (!roots.length) return { ...failure('no installed dependency trees were supplied'), reports: [] };
  const reports = roots.map((root) => ({ root, ...inspectFoottrace(root, options) }));
  const failed = reports.find((report) => !report.ok);
  if (failed) return { ...failure(`installation inspection failed for ${failed.root}`), reports };
  const paths = new Set(reports.filter((report) => report.path).map((report) => report.path));
  if (paths.size > 1)
    return {
      ...failure(`consumer and siblings resolve different physical instances: ${[...paths].join(', ')}`),
      reports,
    };
  return { ok: true, reports };
}
