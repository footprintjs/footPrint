/** Candidate installation: one authored-manifest plan, linked or packaged materialization. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import semver from 'semver';
import { run, read, quote } from './audit-process.mjs';
import { inspectFoottraceWorkspace } from './foottrace-install.mjs';
import { sourceWorkspaceProblem, connectSourceWorkspace } from './consumer-workspace.mjs';

const CONCRETE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const DEPENDENCY_FIELDS = [...CONCRETE_FIELDS, 'peerDependencies'];

/** Only the named audit packages may change; all other declarations and metadata stay original. */
export function auditManifestProblem(before, after, packages) {
  const withoutOverrides = (manifest) => {
    const rest = structuredClone(manifest);
    for (const field of CONCRETE_FIELDS) {
      if (!rest[field] || typeof rest[field] !== 'object') continue;
      for (const name of packages) delete rest[field][name];
      if (!Object.keys(rest[field]).length) delete rest[field];
    }
    return rest;
  };
  return isDeepStrictEqual(withoutOverrides(before), withoutOverrides(after))
    ? null
    : 'audit installation changed unrelated manifest declarations or metadata';
}

/** Change only concrete installation requests; peer requirements remain the consumer's own. */
export function auditInstallManifest(original, replacements) {
  const planned = structuredClone(original);
  for (const [name, spec] of replacements) {
    const fields = CONCRETE_FIELDS.filter((field) => Object.hasOwn(planned[field] ?? {}, name));
    if (!fields.length) fields.push('devDependencies');
    for (const field of fields) {
      planned[field] ??= {};
      planned[field][name] = spec;
    }
  }
  return planned;
}

/** npm can shadow a peer with the same package's dev dependency, even in a linked graph. */
export function auditPeerProblem(original, replacements) {
  for (const [name, version] of replacements) {
    if (!semver.valid(version)) return `${name}: invalid exact audit version ${JSON.stringify(version)}`;
    if (!Object.hasOwn(original.peerDependencies ?? {}, name)) continue;
    const range = original.peerDependencies[name];
    if (typeof range !== 'string' || semver.validRange(range) === null) {
      return `${name}: invalid original peer requirement ${JSON.stringify(range)}`;
    }
    if (!semver.satisfies(version, range)) {
      return `${name}@${version}: incompatible with original peer requirement ${JSON.stringify(range)}`;
    }
  }
  return null;
}

function auditPackageVersion(name, spec) {
  if (!spec.endsWith('.tgz')) return spec;
  const archive = spec.startsWith('file:') ? spec.slice('file:'.length) : spec;
  const packed = JSON.parse(read('tar', ['-xOzf', archive, 'package/package.json']));
  if (packed.name !== name || typeof packed.version !== 'string') {
    throw new Error(`audit archive does not identify ${name}: ${archive}`);
  }
  return packed.version;
}

/** Capture the authored declarations before either installation or consumer setup can change them. */
export function captureAuditManifests(dirs) {
  return new Map(dirs.map((dir) => [dir, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))]));
}

/** One plan for both installation strategies; validate every target before mutating any of them. */
export function planAuditInstall(dirs, spec, pins, notes, originalManifests = new Map()) {
  const tarball = spec.endsWith('.tgz');
  // Siblings are already in producer order in family.json. Refresh their manifests and locks
  // before a dependent reads them; registry pins belong only to the consumer, not the first install.
  const consumer = dirs[0];
  const plans = [];
  for (const dir of [...dirs.slice(1), consumer]) {
    const sources = new Map([
      ['footprintjs', tarball ? spec : spec.slice('footprintjs@'.length)],
      ...(dir === consumer
        ? pins.map((pin) => {
            const separator = pin.indexOf('@', 1);
            if (separator < 1) throw new Error(`invalid named audit pin: ${pin}`);
            const name = pin.slice(0, separator);
            return [name, pin.slice(separator + 1)];
          })
        : []),
    ]);
    const replacements = new Map([...sources].map(([name, source]) => [name, auditPackageVersion(name, source)]));
    const names = [...replacements.keys()];
    const packageFile = join(dir, 'package.json');
    if (!originalManifests.has(dir)) originalManifests.set(dir, JSON.parse(readFileSync(packageFile, 'utf8')));
    const original = originalManifests.get(dir);
    for (const name of names) {
      const declarations = DEPENDENCY_FIELDS.filter((field) => Object.hasOwn(original[field] ?? {}, name));
      notes.add(
        `${basename(dir)}: audit-only override of ${name}; original ` +
          (declarations.length
            ? declarations.map((field) => `${field}.${name}=${JSON.stringify(original[field][name])}`).join(', ')
            : 'not directly declared'),
      );
    }
    const peerProblem = auditPeerProblem(original, replacements);
    if (peerProblem) {
      notes.add(`${basename(dir)}: ${peerProblem}`);
      return null;
    }
    const beforeProblem = auditManifestProblem(original, JSON.parse(readFileSync(packageFile, 'utf8')), names);
    if (beforeProblem) {
      notes.add(`${basename(dir)}: ${beforeProblem}`);
      return null;
    }
    plans.push({ dir, packageFile, original, names, sources, replacements });
  }
  return plans;
}

/** Materialize only the approved plan; packaged apps need their replacements BEFORE the first ci. */
export function swap(dirs, spec, pins, notes, installedDirs = dirs, originalManifests = new Map(), options = {}) {
  const { strategy = 'linked', runCommand = run, sourceOnly = [] } = options;
  let seconds = 0;
  if (!['linked', 'packaged'].includes(strategy)) throw new Error(`unknown audit install strategy: ${strategy}`);
  if (strategy === 'packaged' && dirs.length !== 1) throw new Error('packaged installation has one dependency root');
  const plans = planAuditInstall(dirs, spec, pins, notes, originalManifests);
  if (!plans) return { ok: false, seconds };
  const sourceProblem = sourceWorkspaceProblem(dirs[0], sourceOnly);
  if (sourceProblem) {
    notes.add(sourceProblem);
    return { ok: false, seconds };
  }
  // Preflight every peer before changing any target, including the consumer installed last.
  for (const { dir, packageFile, original, names, sources, replacements } of plans) {
    const requests =
      strategy === 'packaged'
        ? new Map(
            [...sources].map(([name, source]) => [
              name,
              source.endsWith('.tgz') ? `file:${resolve(source.replace(/^file:/, ''))}` : source,
            ]),
          )
        : replacements;
    const planned = auditInstallManifest(original, requests);
    writeFileSync(packageFile, `${JSON.stringify(planned, null, 2)}\n`);
    // npm keeps an installed footprintjs of the asked version, even one a tarball put there.
    if (strategy === 'linked' && !spec.endsWith('.tgz'))
      rmSync(join(dir, 'node_modules/footprintjs'), { recursive: true, force: true });
    // Declare the exact version, then select its artifact without rewriting peer requirements.
    // npm's external-link graph lacks child tarball provenance, so file: requirements there
    // cannot validate; the installed version and the archive's landed source are checked separately.
    const specs = dir === dirs[0] ? [...pins, spec] : [spec];
    const commands =
      strategy === 'packaged'
        ? [
            `npm update --package-lock-only --strict-peer-deps --no-audit --no-fund ${names.map(quote).join(' ')}`,
            'npm ci --strict-peer-deps --no-audit --no-fund',
          ]
        : [`npm install --no-save --no-audit --no-fund ${specs.map(quote).join(' ')}`];
    for (const command of commands) {
      const step = runCommand(command, dir);
      seconds += step.seconds;
      const current = JSON.parse(readFileSync(packageFile, 'utf8'));
      const manifestProblem = auditManifestProblem(original, current, names);
      if (manifestProblem || !isDeepStrictEqual(current, planned)) {
        notes.add(`${basename(dir)}: ${manifestProblem ?? 'installation changed the planned audit requests'}`);
        return { ok: false, seconds };
      }
      if (!step.ok) return { ok: false, seconds };
    }
  }
  // A dependent installation must not replace an already-swapped sibling behind the audit.
  if (!verifyAuditSources(plans, notes)) return { ok: false, seconds };
  const connected = connectSourceWorkspace(dirs[0], sourceOnly);
  if (connected) {
    notes.add(connected);
    return { ok: false, seconds };
  }
  // This is installation evidence, not a consumer test: failure on both legs must still block.
  return { ok: checkFoottraceInstalls(installedDirs, notes), seconds };
}

/** Inspect every selected source only after all roots are installed; unreadable evidence fails closed. */
export function verifyAuditSources(plans, notes) {
  for (const { dir, sources, replacements } of plans) {
    try {
      const { packages } = JSON.parse(readFileSync(join(dir, 'node_modules/.package-lock.json'), 'utf8'));
      if (!packages || typeof packages !== 'object' || Array.isArray(packages))
        throw new Error('missing installed packages map');
      for (const [name, source] of sources) {
        const got = packages[`node_modules/${name}`];
        const fromFile = got?.resolved?.startsWith('file:');
        const archive = source.startsWith('file:') ? source.slice('file:'.length) : source;
        const landed = source.endsWith('.tgz')
          ? fromFile &&
            got.version === replacements.get(name) &&
            realpathSync(resolve(dir, got.resolved.slice('file:'.length))) === realpathSync(archive)
          : /^https?:\/\//.test(got?.resolved ?? '') && got?.version === replacements.get(name);
        if (!landed) {
          notes.add(`${basename(dir)}: ${name} did not resolve to ${source}`);
          return false;
        }
        if (source.endsWith('.tgz')) {
          const integrity = `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`;
          if (got.integrity !== integrity) {
            notes.add(`${basename(dir)}: ${name} archive integrity does not match ${source}`);
            return false;
          }
        }
      }
      for (const [path, { version }] of Object.entries(packages)) {
        const nested = path.startsWith('node_modules/') && path.endsWith('/node_modules/footprintjs');
        if (nested) notes.add(`${basename(dir)}: ${path} ${version} is not swapped`);
      }
    } catch (error) {
      notes.add(`${basename(dir)}: cannot verify installed sources: ${error.message}`);
      return false;
    }
  }
  return true;
}

export function checkFoottraceInstalls(dirs, notes) {
  const checked = inspectFoottraceWorkspace(dirs);
  for (const report of checked.reports) notes.add(`${basename(report.root)}: ${report.message}`);
  if (!checked.ok) notes.add(checked.message);
  return checked.ok;
}
