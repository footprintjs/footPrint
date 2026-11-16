/** Archive and physical-file evidence; lock metadata alone is insufficient. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspectFoottraceWorkspace } from '../../foottrace-install.mjs';
import { inspectCohortArchive, parseManifest } from '../../publish-release/archive/inspector.cjs';
import { recipes } from '../plan/index.mjs';
import { verifySourceOrigin } from '../origin/index.mjs';
import { cohortLimits, cohortEntryLimit } from '../../publish-release/archive/cohort-profile.cjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** Only the canonical closed archive inspector admits bytes; system tar reads a local npm pack. */
export function inspectPacked(path, manifest, archiveVersion = manifest.version) {
  const bytes = packedBytes(path, manifest.name);
  return {
    ...inspectCohortArchive(bytes, { package: manifest.name, version: archiveVersion, sourceManifest: manifest }),
    manifest: { ...manifest, version: archiveVersion },
  };
}

function packedBytes(path, expectedName) {
  const limit = cohortLimits(expectedName).maxArchiveBytes;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit)
    throw new Error('archive input exceeds its closed package profile');
  const bytes = readFileSync(path);
  if (bytes.length > limit) throw new Error('archive input changed beyond its closed package profile');
  return bytes;
}

export function packedManifest(path, expectedName = 'footprintjs') {
  // Callers write immutable, private copies before this read. The inspector subsequently rejects
  // malformed containers before extraction or installation; tar here never writes to disk.
  const bytes = packedBytes(path, expectedName);
  return parseManifest(
    execFileSync('tar', ['-xOzf', '-', 'package/package.json'], {
      input: bytes,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    }),
  );
}

function actualFiles(root, policy, prefix = '', found = new Map(), state = { bytes: 0, entries: 0 }) {
  if (prefix.split('/').length > 64) throw new Error('installed artifact exceeds depth bound');
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (++state.entries > policy.entries) throw new Error('installed artifact exceeds entry bound');
    if (!prefix && entry.name === 'node_modules') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`installed artifact has a symlink: ${relative}`);
    if (entry.isDirectory()) actualFiles(root, policy, relative, found, state);
    else if (entry.isFile()) {
      state.bytes += stat.size;
      if (state.bytes > policy.maxExpandedBytes) throw new Error('installed artifact exceeds byte bound');
      found.set(`package/${relative}`, sha256(readFileSync(path)));
    } else throw new Error('installed artifact has a nonregular member');
    if (found.size > policy.maxFiles) throw new Error('installed artifact exceeds file bound');
  }
  return found;
}

/** Until an additional install root has an explicit paired recipe, it cannot go uninspected. */
export function requireSingleInstallRoot(root, relative = '', state = { entries: 0 }) {
  if (relative.split('/').length > 64) throw new Error('workspace exceeds depth bound');
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    if (++state.entries > 100_000) throw new Error('workspace exceeds scan bound');
    if (entry.name === '.git') continue;
    if (entry.name === 'node_modules') {
      if (relative) throw new Error(`unpaired independent install root: ${relative}`);
      continue;
    }
    if (entry.isDirectory()) requireSingleInstallRoot(root, relative ? `${relative}/${entry.name}` : entry.name, state);
  }
}

export function verifyFiles(root, expected) {
  const files = actualFiles(root, {
    ...cohortLimits(expected.package),
    entries: cohortEntryLimit(expected.package, expected.files),
  });
  if (files.size !== expected.files.length || expected.files.some((file) => files.get(file.path) !== file.sha256))
    throw new Error(`${expected.package}: installed file bytes differ from the admitted archive`);
}

/** Recheck every selected package and the full one-copy graph before/after EACH runtime command. */
export function verifyInstalled(root, selections, expectedTrace, inspect = inspectFoottraceWorkspace) {
  requireSingleInstallRoot(root);
  const graph = inspect([root], { required: true });
  if (!graph.ok || graph.reports.some((row) => row.version !== expectedTrace))
    throw new Error(`expected one physical Foottrace ${expectedTrace}: ${graph.message ?? 'version differs'}`);
  const lock = JSON.parse(readFileSync(join(root, 'node_modules/.package-lock.json'), 'utf8'));
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages))
    throw new Error('installed graph unreadable');
  for (const [name, selected] of selections) {
    const path = `node_modules/${name}`;
    const installed = lock.packages[path];
    if (!installed || installed.version !== selected.version || installed.integrity !== selected.integrity)
      throw new Error(`${name}: installed source/version/integrity differs`);
    if (
      !installed.resolved?.startsWith('file:') ||
      realpathSync(resolve(root, installed.resolved.slice(5))) !== realpathSync(selected.path)
    )
      throw new Error(`${name}: installed archive provenance differs`);
    verifyFiles(join(root, path), selected);
    for (const key of Object.keys(lock.packages)) {
      if (key !== path && key.endsWith(`/node_modules/${name}`))
        throw new Error(`${name}: nested unswapped copy at ${key}`);
    }
  }
}

/** Bundle file receipt is source/run-bound, not a substitute for its separate service ZIP digest. */
export function verifyBundle(receipt, plan, context, folder) {
  if (
    receipt.schema !== 1 ||
    receipt.planHash !== plan.hash ||
    receipt.context.checkout !== context.checkout ||
    receipt.context.tree !== context.tree ||
    receipt.context.head !== context.head ||
    receipt.context.base !== context.base ||
    receipt.context.run !== context.run ||
    receipt.context.attempt !== context.attempt
  )
    throw new Error('bundle source/plan/run identity differs');
  const expected = new Map([
    ['footprintjs', { version: plan.engineVersion, head: context.head, tree: context.tree }],
    ...plan.packages.map((row) => [row.package, row]),
    ...plan.registry.map((row) => [row.package, row]),
  ]);
  if (!Array.isArray(receipt.packages) || receipt.packages.length !== expected.size)
    throw new Error('incomplete artifact bundle');
  const selected = new Map();
  for (const row of receipt.packages) {
    const requested = expected.get(row.package);
    if (
      !requested ||
      selected.has(row.package) ||
      requested.version !== row.version ||
      row.filename !== `${row.package}.tgz` ||
      (requested.head && requested.head !== row.head) ||
      (requested.tree && requested.tree !== row.tree)
    )
      throw new Error('artifact selection differs');
    const path = join(folder, row.filename);
    const manifest = row.manifest;
    if (!manifest || manifest.name !== row.package || manifest.version !== row.version)
      throw new Error('artifact manifest missing');
    const source =
      requested.head && row.package !== 'footprintjs'
        ? verifySourceOrigin(row.origin, recipes[row.package], requested, manifest)
        : manifest;
    if (row.origin && row.origin.tree !== row.tree) throw new Error('source tree differs');
    const observed = inspectPacked(
      path,
      row.package === 'footprintjs' && context.manifest ? { ...context.manifest, version: plan.engineVersion } : source,
      row.version,
    );
    if (
      manifest.name !== row.package ||
      manifest.version !== row.version ||
      observed.integrity !== row.integrity ||
      (requested.integrity && requested.integrity !== observed.integrity) ||
      JSON.stringify(observed.files) !== JSON.stringify(row.files)
    )
      throw new Error('artifact bytes differ');
    selected.set(row.package, { ...observed, path });
  }
  return selected;
}
