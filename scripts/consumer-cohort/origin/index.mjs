/** Source identities are not registry versions. Only AF has a reviewed native RC stage. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import semver from 'semver';
import { parseManifest } from '../../publish-release/archive/inspector.cjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function oneBumpRC(source, target) {
  const base = semver.parse(source),
    next = semver.parse(target);
  return (
    !!base &&
    !base.prerelease.length &&
    !base.build.length &&
    !!next &&
    next.prerelease.length === 2 &&
    next.prerelease[0] === 'rc' &&
    Number.isSafeInteger(next.prerelease[1]) &&
    next.prerelease[1] >= 0 &&
    !next.build.length &&
    ['patch', 'minor', 'major'].some((kind) => semver.inc(base, kind) === `${next.major}.${next.minor}.${next.patch}`)
  );
}
export function sourceStrategy(name, authored, target) {
  if (authored === target && semver.valid(authored) === authored) return 'authored';
  if (name === 'agentfootprint' && oneBumpRC(authored, target)) return 'agentfootprint-native-rc-after-build';
  throw new Error('authored candidate version differs: no reviewed native strategy');
}
export function sourceOrigin(repo, row, tree, original) {
  const text = original.toString('utf8'),
    manifest = parseManifest(original);
  if (manifest.name !== row.package || original.length > 1024 * 1024)
    throw new Error('source manifest identity differs');
  const strategy = sourceStrategy(row.package, manifest.version, row.version);
  if (!/^[a-f0-9]{40}$/.test(tree) || !/^[a-f0-9]{40}$/.test(row.head) || !Number.isSafeInteger(row.pr))
    throw new Error('source identity is incomplete');
  return {
    kind: 'source',
    repo,
    pr: row.pr,
    head: row.head,
    tree,
    sourceManifestText: text,
    sourceManifestHash: sha256(original),
    sourceVersion: manifest.version,
    archiveVersion: row.version,
    strategy,
  };
}
export function verifySourceOrigin(origin, recipe, requested, packed) {
  if (
    !origin ||
    origin.kind !== 'source' ||
    !/^[a-f0-9]{64}$/.test(origin.installManifestHash) ||
    !/^[a-f0-9]{64}$/.test(origin.installLockHash) ||
    origin.repo !== recipe.repo ||
    origin.pr !== requested.pr ||
    origin.head !== requested.head ||
    !/^[a-f0-9]{40}$/.test(origin.tree) ||
    typeof origin.sourceManifestText !== 'string' ||
    Buffer.byteLength(origin.sourceManifestText) > 1024 * 1024 ||
    sha256(Buffer.from(origin.sourceManifestText)) !== origin.sourceManifestHash
  )
    throw new Error('source origin differs');
  const source = parseManifest(Buffer.from(origin.sourceManifestText));
  const strategy = sourceStrategy(requested.package, source.version, requested.version);
  if (
    origin.strategy !== strategy ||
    origin.sourceVersion !== source.version ||
    origin.archiveVersion !== requested.version ||
    source.name !== requested.package ||
    !isDeepStrictEqual({ ...source, version: requested.version }, packed)
  )
    throw new Error('source manifest/version projection differs');
  return source;
}
/** Stable authored SOURCE input makes no registry-byte claim. Every RC retains collision checks. */
export function needsCollisionCheck(row) {
  return (
    row.origin?.kind !== 'source' ||
    row.origin.strategy !== 'authored' ||
    row.origin.sourceVersion !== row.version ||
    semver.prerelease(row.version) !== null
  );
}
