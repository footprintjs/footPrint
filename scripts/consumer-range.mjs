/**
 * consumer-range.mjs — which footprintjs versions a consumer says it works with. Pure: data in, data out.
 *
 * WHY: a version range is a consumer's own statement to its users. Inside it, a fresh install picks a
 * new footprintjs up by itself, so a red check there is a real break and must block. Outside it, no
 * install picks the candidate up, so the consumer has nothing to lose and nothing to veto. The audit
 * (`audit-consumers.mjs · audit`) asks this module whether any declaration refuses the candidate, and
 * if one does, which published version every declaration accepts, to test the candidate's code under.
 *
 * Example: agentfootprint-lens peers `footprintjs ^11.0.0` and takes agentfootprint@14.3.1 from npm,
 * which peers `^11.1.0`. Candidate 12.0.0: both refuse, and the accepted version is the newest
 * published 11.x at or above 11.1.0.
 *
 * Every input comes from other repositories or the registry, so every value is checked for its type
 * and size. Anything malformed THROWS: the caller then judges the consumer exactly as before (strict).
 * A consumer is "out of range" only when a range was positively parsed and refuses the candidate.
 */
import semver from 'semver';

/** The manifest fields that are a statement to the consumer's users. `devDependencies` is a test setup. */
export const STATEMENT_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const ENGINE = 'footprintjs';
// A real range is a few dozen characters. A longer one is not parsed (semver's own cost grows with it).
const MAX_RANGE_LENGTH = 1024;
// npm's own spec kinds that name a place, not a version: no statement about which version works.
const PLACE_SPEC = /^(?:file:|link:|workspace:|git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:)/;
// npm reads any other bare name as a dist-tag (`latest`, `next`): no statement either.
const TAG_SPEC = /^[A-Za-z][A-Za-z0-9._-]*$/;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const malformed = (message) => {
  throw new Error(message);
};

/**
 * What one dependency spec says: `{ range }` for a semver range, `null` for a spec that names a place
 * or a tag (`file:../x`, a git URL, `latest`). Throws for anything else, such as a number or `^11.x.y`.
 */
export function rangeOf(spec, who) {
  if (typeof spec !== 'string') malformed(`${who}: ${ENGINE} spec is not a string`);
  if (spec.length > MAX_RANGE_LENGTH) malformed(`${who}: ${ENGINE} spec is longer than ${MAX_RANGE_LENGTH}`);
  if (PLACE_SPEC.test(spec)) return null;
  // `user/repo` is npm's GitHub shorthand.
  if (/^[^\s@/]+\/[^\s/]+$/.test(spec) && semver.validRange(spec) === null) return null;
  if (semver.validRange(spec) !== null) return { range: spec };
  if (TAG_SPEC.test(spec)) return null;
  return malformed(`${who}: ${ENGINE} spec ${JSON.stringify(spec.slice(0, 80))} is not a valid range`);
}

function declarationsOf(fields, who, manifest, labels) {
  if (!isRecord(manifest)) malformed(`${who}: manifest is not an object`);
  const found = [];
  for (const field of fields) {
    if (!Object.hasOwn(manifest, field)) continue;
    const declared = manifest[field];
    if (!isRecord(declared)) malformed(`${who}: ${field} is not an object`);
    if (!Object.hasOwn(declared, ENGINE)) continue;
    const parsed = rangeOf(declared[ENGINE], `${who} ${field}`);
    if (parsed) found.push({ who, field: labels[field] ?? field, range: parsed.range });
  }
  return found;
}

/** The authored manifest of the consumer (`who: 'own'`) or of a participating sibling. */
export function manifestDeclarations(who, manifest) {
  return declarationsOf(STATEMENT_FIELDS, who, manifest, {});
}

/** A registry pin's published manifest: its `peerDependencies.footprintjs`. `who` is `name@version`. */
export function pinDeclarations(who, published) {
  return declarationsOf(['peerDependencies'], who, published, { peerDependencies: 'peer' });
}

/** The package name of a lock entry: its `name`, or the path's last `node_modules/` segment. */
function lockName(path, entry) {
  if (typeof entry.name === 'string') return entry.name;
  const at = path.lastIndexOf('node_modules/');
  return at < 0 ? path : path.slice(at + 'node_modules/'.length);
}

/**
 * Every installed package's peer on footprintjs, from an npm lock (`node_modules/.package-lock.json`
 * or `package-lock.json`). The root entry (`""`) is the authored manifest, read on its own; a link
 * entry points at another entry; a package a registry pin replaces (`skip`) is read from the registry.
 * An optional peer counts: npm refuses an incompatible optional peer that is installed, too.
 */
export function treeDeclarations(lock, skip = new Set()) {
  if (!isRecord(lock) || !isRecord(lock.packages)) malformed('installed tree: no packages map');
  const found = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '') continue;
    if (!isRecord(entry)) malformed(`installed tree: ${path.slice(0, 120)} is not an object`);
    if (entry.link === true || !Object.hasOwn(entry, 'peerDependencies')) continue;
    const name = lockName(path, entry);
    if (skip.has(name)) continue;
    const version = typeof entry.version === 'string' ? entry.version.slice(0, 64) : '?';
    const optional = isRecord(entry.peerDependenciesMeta) && entry.peerDependenciesMeta[ENGINE]?.optional === true;
    const who = `${name.slice(0, 214)}@${version}`;
    found.push(
      ...declarationsOf(['peerDependencies'], who, entry, { peerDependencies: optional ? 'optional peer' : 'peer' }),
    );
  }
  return found;
}

/** One list, each declaration once (two workspace demos can lock the same package at one version). */
export function uniqueDeclarations(declarations) {
  const seen = new Set();
  return declarations.filter((d) => {
    const key = `${d.who}\u0000${d.field}\u0000${d.range}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The declarations that do not accept `version`, npm's way (`semver.satisfies`, no prerelease widening). */
export function refusals(declarations, version) {
  if (!semver.valid(version)) malformed(`candidate version ${JSON.stringify(version)} is not a version`);
  return declarations.filter((d) => !semver.satisfies(version, d.range));
}

/** The newest version in `published` that every declaration accepts, or null. */
export function acceptedVersion(declarations, published) {
  if (!Array.isArray(published) || published.some((v) => typeof v !== 'string'))
    malformed('published versions are not a list of texts');
  const accepted = published.filter((v) => semver.valid(v) && declarations.every((d) => semver.satisfies(v, d.range)));
  return accepted.length ? semver.rsort(accepted)[0] : null;
}

/** `own peerDependencies ^11.0.0; agentfootprint@14.3.1 peer ^11.1.0`. */
export const describeDeclarations = (declarations) =>
  declarations.map((d) => `${d.who} ${d.field} ${d.range}`).join('; ');

/** The report line: `range: accepts 12.0.0`, or `range: refuses 12.0.0 — <every refusing declaration>`. */
export const rangeLine = (version, refusing) =>
  refusing.length ? `range: refuses ${version} — ${describeDeclarations(refusing)}` : `range: accepts ${version}`;
