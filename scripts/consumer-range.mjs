/**
 * consumer-range.mjs — which footprintjs versions a consumer says it works with. Pure: data in, data out.
 *
 * The audit (`audit-consumers.mjs · audit`) asks it two questions, answered from different facts:
 *
 * 1. MAY THIS CONSUMER BLOCK? Only its statements to its users count: its authored manifests'
 *    `dependencies` / `peerDependencies` / `optionalDependencies` and its registry pins' published peers
 *    (`statement: true`). They are asked about the BASE version, the version of the branch the change
 *    merges into, never the candidate's own label: the label is written by the change under test, and
 *    an ordinary edit of the version must not decide who may block it. A consumer whose statements
 *    all accept the base may block; one that refuses it has not opted in to the line the branch is on,
 *    and reports only.
 *    WHY not the installed tree: a package only the consumer's tests or demos install says nothing to
 *    the people who install the consumer (hcifootprint's demos lock an agentfootprint that refuses 12,
 *    yet hcifootprint itself has opted in to 12 and must keep its power to block 12).
 *
 * 2. UNDER WHICH LABEL IS THE CANDIDATE'S CODE INSTALLED? Every declaration in the install graph counts,
 *    the tree's peers included (`statement: false`), because npm refuses them all. If any refuses the
 *    candidate's version, the code is installed relabelled as the newest published version that every
 *    declaration accepts (`consumer-relabel.mjs`).
 *
 * Example: base 11.2.0, candidate 12.0.0, agentfootprint-lens peers `^11.0.0`. It accepts the base, so
 * it may block; it refuses 12.0.0, so the code is tested as 11.2.0, and a break there still blocks.
 *
 * Every input comes from other repositories or the registry, so every value is checked for its type
 * and size. Anything malformed THROWS: the caller then judges the consumer exactly as before (strict).
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
 * The package name of a registry pin `name@version` (a scoped `@scope/name@version` too). One parser
 * for the audit's plan (`consumer-install.mjs · planAuditInstall`) and this module.
 */
export function pinName(pin) {
  const separator = typeof pin === 'string' ? pin.indexOf('@', 1) : -1;
  if (separator < 1) throw new Error(`invalid named audit pin: ${pin}`);
  return pin.slice(0, separator);
}

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

function declarationsOf(fields, who, manifest, labels, statement) {
  if (!isRecord(manifest)) malformed(`${who}: manifest is not an object`);
  const found = [];
  for (const field of fields) {
    if (!Object.hasOwn(manifest, field)) continue;
    const declared = manifest[field];
    if (!isRecord(declared)) malformed(`${who}: ${field} is not an object`);
    if (!Object.hasOwn(declared, ENGINE)) continue;
    const parsed = rangeOf(declared[ENGINE], `${who} ${field}`);
    if (parsed) found.push({ who, field: labels[field] ?? field, range: parsed.range, statement });
  }
  return found;
}

/** The authored manifest of the consumer (`who: 'own'`) or of a participating sibling. */
export function manifestDeclarations(who, manifest) {
  return declarationsOf(STATEMENT_FIELDS, who, manifest, {}, true);
}

/** A registry pin's published manifest: its `peerDependencies.footprintjs`. `who` is `name@version`. */
export function pinDeclarations(who, published) {
  return declarationsOf(['peerDependencies'], who, published, { peerDependencies: 'peer' }, true);
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
 * An optional peer counts: npm refuses an incompatible optional peer that is installed, too. These
 * decide only the install label (question 2), never whether the consumer may block. npm `overrides`
 * are not read: a peer the consumer overrides still counts as declared here.
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
      ...declarationsOf(
        ['peerDependencies'],
        who,
        entry,
        { peerDependencies: optional ? 'optional peer' : 'peer' },
        false,
      ),
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

/**
 * The release of a version: `11.3.0-rc.0` → `11.3.0`. A statement accepts a prerelease base when it
 * accepts the base AS WRITTEN or ITS RELEASE. Only as written, npm's reading would put an rc on `main`
 * outside every caret range of its own line (`^12.0.0` refuses `12.0.0-rc.0`) and so free every consumer
 * from blocking for as long as `main` carries it. Only the release would free a consumer that pins the
 * rc itself (`"12.0.0-rc.0"`, `>=12.0.0-rc.0 <12.0.0`). Both readings together free neither. The
 * candidate's own label is still read npm's way (question 2).
 */
export function releaseOf(version) {
  const parsed = semver.parse(version);
  if (!parsed) malformed(`version ${JSON.stringify(String(version).slice(0, 80))} is not a version`);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

/** How the report names the base: the versions it was asked about. */
export function baseAsAsked(base) {
  const release = releaseOf(base);
  return release === base ? base : `${base} (as written or as ${release})`;
}

/**
 * Both answers, from the declarations `declaredRange` collected:
 * `mayBlock` (every statement accepts the base as written or its release), `baseRefusing` (the statements
 * that accept neither), `candidateRefusing` (every declaration that refuses the candidate's own version:
 * relabel when any).
 */
export function decideRange(declarations, base, candidate) {
  const release = releaseOf(base);
  const accepts = (range) => semver.satisfies(base, range) || semver.satisfies(release, range);
  const baseRefusing = declarations.filter((d) => d.statement && !accepts(d.range));
  return { mayBlock: baseRefusing.length === 0, baseRefusing, candidateRefusing: refusals(declarations, candidate) };
}

/**
 * The statements that refuse the candidate for a reason the consumer must act on. A statement that
 * refuses a prerelease candidate but accepts its release (`^12.0.0` and `12.0.0-rc.1`) has already
 * opted in to that version: npm only skips prereleases. It is not told to opt in.
 */
export function optInRefusals(decision, candidate) {
  const release = releaseOf(candidate);
  return decision.candidateRefusing.filter((d) => d.statement && !semver.satisfies(release, d.range));
}

/**
 * The report's `range:` line, both facts in plain words:
 *   range: accepts base 11.2.0, so it can block. Refuses 12.0.0 (own peerDependencies ^11.1.0): must opt
 *     in before 12.0.0 is the newest version. Tested as 11.2.0.
 *   range: refuses base 12.0.0 (own dependencies ^11.2.0): reports only. Tested as 11.2.0.
 *   range: accepts base 12.0.0 and candidate 12.0.0.
 * `testedAs` is the label the code was installed under (absent: the real candidate); `untested` says why
 * no relabelled archive was made, when one was needed.
 */
export function rangeLine({ base, candidate, decision, testedAs, untested }) {
  const { mayBlock, baseRefusing, candidateRefusing } = decision;
  const optIn = optInRefusals(decision, candidate);
  const prereleaseOnly = candidateRefusing.filter((d) => d.statement && !optIn.includes(d));
  const tree = candidateRefusing.filter((d) => !d.statement);
  const asked = baseAsAsked(base);
  if (mayBlock && !candidateRefusing.length) return `range: accepts base ${asked} and candidate ${candidate}.`;
  const parts = [
    mayBlock
      ? `range: accepts base ${asked}, so it can block.`
      : `range: refuses base ${asked} (${describeDeclarations(baseRefusing)}): reports only.`,
  ];
  if (!candidateRefusing.length) parts.push(`Accepts candidate ${candidate}.`);
  if (optIn.length && (mayBlock || candidate !== base))
    parts.push(
      `Refuses ${candidate} (${describeDeclarations(optIn)}): must opt in before ${candidate} is the newest version.`,
    );
  if (prereleaseOnly.length)
    parts.push(
      `Refuses ${candidate} only as a prerelease (${describeDeclarations(prereleaseOnly)}): it accepts ${releaseOf(
        candidate,
      )}.`,
    );
  if (tree.length) parts.push(`Its install graph refuses ${candidate} (${describeDeclarations(tree)}).`);
  if (testedAs) parts.push(`Tested as ${testedAs}.`);
  if (untested) parts.push(untested);
  return parts.join(' ');
}
