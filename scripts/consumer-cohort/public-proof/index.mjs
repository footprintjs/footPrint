/** Actual installed public APIs, never AF source self-reference or a version-only fixture fallback. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPaired } from '../workspace/index.mjs';
import { verifyInstalled } from '../bytes/index.mjs';
import { specimenFiles, requireProofReceipt, requireProducerReport } from '../origin/proof.mjs';
import { parseManifest } from '../../publish-release/archive/inspector.cjs';
import { directNode } from './process.mjs';
import { publicTarget } from './exports.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const keys = (record, names) =>
  record &&
  typeof record === 'object' &&
  !Array.isArray(record) &&
  Object.keys(record).length === names.length &&
  names.every((key) => Object.hasOwn(record, key));

export function requireEntries(entries, format, root, selected) {
  if (!keys(entries, ['root', 'providers', 'observe'])) throw Error('public entry schema differs');
  const installed = join(realpathSync(root), 'node_modules/agentfootprint');
  if (
    lstatSync(join(root, 'node_modules')).isSymbolicLink() ||
    lstatSync(installed).isSymbolicLink() ||
    realpathSync(installed) !== resolve(installed)
  )
    throw Error('public entry root is not the neutral installed archive');
  const observed = {};
  for (const key of ['root', 'providers', 'observe']) {
    const entry = entries[key];
    if (typeof entry !== 'string' || entry.length > 4096 || (format === 'esm' && !entry.startsWith('file:')))
      throw Error('public entry path differs');
    if (format === 'esm' && (new URL(entry).search || new URL(entry).hash))
      throw Error('public entry URL contains an unowned query or fragment');
    const path = format === 'esm' ? fileURLToPath(entry) : entry;
    if (!path.startsWith('/')) throw Error('public entry is not absolute');
    const real = realpathSync(path),
      local = relative(installed, real);
    if (!local || local === '..' || local.startsWith('../'))
      throw Error('public entry resolves outside the admitted archive');
    const target = resolve(installed, publicTarget(selected, key, format));
    if (real !== target || realpathSync(target) !== target)
      throw Error('public entry differs from its declared format-specific export target');
    const member = selected.files.find((file) => file.path === 'package/' + local);
    if (!member || sha(readFileSync(real)) !== member.sha256) throw Error('public entry member differs');
    observed[key] = real;
  }
  return observed;
}

export async function provePublicVersions({ selected, family, folder }, services = {}) {
  const ports = { installPaired, verifyInstalled, directNode, ...services };
  const root = mkdtempSync(join(tmpdir(), 'fp-cohort-public-'));
  const receipts = [];
  const files = new Map();
  const persist = () =>
    writeFileSync(join(folder, 'af-public-version-processes.json'), JSON.stringify(receipts, null, 2) + '\n');
  try {
    const af = selected.get('agentfootprint'),
      engine = selected.get('footprintjs'),
      trace = selected.get('foottrace');
    if (!af || !engine || !trace) throw Error('public version proof needs admitted AF/engine/trace');
    const manifest = {
      name: 'footprint-cohort-public-probe',
      version: '1.0.0',
      private: true,
      dependencies: { agentfootprint: af.version, footprintjs: engine.version, foottrace: trace.version },
    };
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    const used = ports.installPaired(root, manifest, selected, family);
    const setupManifest = readFileSync(join(root, 'package.json')),
      setupLock = readFileSync(join(root, 'package-lock.json'));
    if (JSON.parse(setupManifest).name !== manifest.name || JSON.parse(setupManifest).private !== true)
      throw Error('public proof is not a neutral package scope');
    const specimens = join(root, 'specimens');
    mkdirSync(specimens);
    for (const [name, bytes] of specimenFiles()) {
      files.set(name, bytes);
      writeFileSync(join(specimens, name), bytes);
    }
    const verify = () => {
      ports.verifyInstalled(root, used, trace.version);
      if (
        !readFileSync(join(root, 'package.json')).equals(setupManifest) ||
        !readFileSync(join(root, 'package-lock.json')).equals(setupLock)
      )
        throw Error('public proof setup changed');
      for (const [name, bytes] of files)
        if (!readFileSync(join(specimens, name)).equals(bytes)) throw Error('public proof specimen changed');
    };
    const execute = (name, args) => {
      verify();
      const result = ports.directNode(join(specimens, name), args, root);
      receipts.push({ script: name, scriptSHA256: sha(files.get(name)), ...result });
      persist();
      verify();
      if (result.status !== 0 || result.signal || result.errorCode) throw Error('public proof process failed: ' + name);
      let parsed;
      try {
        parsed = parseManifest(Buffer.from(result.stdout));
      } catch {
        throw Error('public proof result is not one JSON object');
      }
      return parsed;
    };
    const reports = [];
    for (const [format, ext] of [
      ['cjs', 'cjs'],
      ['esm', 'mjs'],
    ]) {
      const preflight = execute('preflight.' + ext, []);
      if (!keys(preflight, ['format', 'entries']) || preflight.format !== format)
        throw Error('public preflight schema differs');
      const entries = requireEntries(preflight.entries, format, root, af);
      const report = execute('run.' + ext, [af.version, engine.version]);
      requireProducerReport(report, format, af, engine);
      if (report.node !== process.versions.node) throw Error('public node version result differs');
      const after = requireEntries(report.resolvedPublicEntries, format, root, af);
      if (JSON.stringify(after) !== JSON.stringify(entries)) throw Error('public entries changed after preflight');
      reports.push(report);
    }
    return requireProofReceipt(
      {
        reports,
        processes: receipts,
        installManifestHash: sha(setupManifest),
        installLockHash: sha(setupLock),
        afIntegrity: af.integrity,
        engineIntegrity: engine.integrity,
        traceIntegrity: trace.integrity,
        traceVersion: trace.version,
      },
      selected,
    );
  } catch (error) {
    // Structured single-line diagnostics cannot become Actions workflow commands.
    console.error(JSON.stringify({ publicVersionFailure: error.message, processes: receipts }));
    throw error;
  } finally {
    try {
      persist();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
