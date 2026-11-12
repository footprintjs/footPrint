/**
 * consumer-relabel.mjs — a copy of the candidate archive whose only change is its version label.
 *
 * WHY: when a declaration in a consumer's install graph refuses the candidate's version
 * (`consumer-range.mjs`, question 2), the consumer is still tested on the candidate's code, through
 * the same strict installation as everyone else. npm refuses a version the graph does not accept, so
 * the code goes in under a version it does: `footprintjs-candidate-as-11.2.0.tgz`
 * holds candidate 12.0.0's files byte for byte, with `"version": "11.2.0"` in its package.json.
 * Nothing in the installation is loosened (no `--force`, no `--legacy-peer-deps`).
 *
 * How: the input's bytes are read ONCE and written to a private copy in the work folder; everything
 * after reads that copy, so a file swapped in at the input's path cannot be extracted uninspected.
 * The bytes are admitted by the release archive inspector (`publish-release/archive/inspector.cjs ·
 * inspectArchive`: one gzip member, a closed tar profile, only `package/` regular files) before
 * anything is extracted. System `tar` extracts the copy, the version is replaced, and
 * `npm pack --ignore-scripts` packs it again, which is how the candidate was made in the first place.
 * The inspector holds no tar WRITER, and a second parser is the thing not to add, so the writer is npm.
 *
 * The result is then checked against the input with the same inspector: the same members, every other
 * member's bytes equal by SHA-256, and `package.json` EXACTLY the text `relabelledManifest` writes (the
 * input's manifest, keys in their order, only `version` replaced). The text and not a key-sorted
 * comparison, because key order in `exports` decides which file a condition resolves to.
 * The input archive is never written: its hash is taken before and after. The copy lives in the given
 * folder, which must not be the input's, and is never uploaded or published.
 *
 * What it cannot change: a version constant built into `dist` still says the candidate's real version.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { read } from './audit-process.mjs';
import { archiveRefusalCode, inspectArchive, parseManifest } from './publish-release/archive/inspector.cjs';

const MANIFEST = 'package/package.json';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The one text of a relabelled `package.json`: the input's manifest, keys in order, `version` replaced. */
export const relabelledManifest = (sourceManifest, version) =>
  `${JSON.stringify({ ...sourceManifest, version }, null, 2)}\n`;

/** The archive's file name for a relabelled copy: it says what it is. */
export const relabelledName = (version) => `footprintjs-candidate-as-${version}.tgz`;

function admit(bytes, version, sourceManifest, what) {
  try {
    return inspectArchive(bytes, { package: sourceManifest.name, version, sourceManifest });
  } catch (error) {
    throw new Error(`${what} refused by the archive inspector: ${archiveRefusalCode(error) ?? error.message}`);
  }
}

/**
 * Throws unless `relabelled` is `input` with only `package.json · version` changed to `version`:
 * its `package.json` is exactly `relabelledManifest(sourceManifest, version)`, the member lists are
 * equal, and every other member's bytes are equal. `sourceManifest` is the input's own manifest.
 */
export function checkRelabelled(input, relabelled, version, sourceManifest) {
  const before = admit(input, sourceManifest.version, sourceManifest, 'the candidate archive');
  const after = admit(relabelled, version, sourceManifest, 'the relabelled archive');
  const paths = (files) => files.map((f) => f.path).sort();
  if (JSON.stringify(paths(before.files)) !== JSON.stringify(paths(after.files)))
    throw new Error('the relabelled archive does not hold the same members as the candidate');
  const hashes = new Map(after.files.map((f) => [f.path, f.sha256]));
  const changed = before.files.filter((f) => f.path !== MANIFEST && hashes.get(f.path) !== f.sha256);
  if (changed.length) throw new Error(`the relabelled archive changed ${changed[0].path.slice(0, 120)}`);
  if (hashes.get(MANIFEST) !== sha256(Buffer.from(relabelledManifest(sourceManifest, version))))
    throw new Error('the relabelled package.json is not the input manifest with only its version replaced');
}

/**
 * Write `<folder>/footprintjs-candidate-as-<version>.tgz` from `input` and check it. Returns its path.
 * `io.read(cmd, args, cwd)` runs a program without a shell (`audit-process.mjs · read`).
 */
export function relabelCandidate(input, version, folder, io = { read }) {
  if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(version))
    throw new Error(`not a version label: ${JSON.stringify(String(version).slice(0, 80))}`);
  mkdirSync(folder, { recursive: true });
  if (realpathSync(folder) === realpathSync(dirname(input)))
    throw new Error('the relabelled archive must not be written beside the candidate');
  const inputBytes = readFileSync(input);
  const inputHash = sha256(inputBytes);
  const work = join(folder, `unpacked-${version}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'tree'), { recursive: true, mode: 0o700 });
  try {
    // The private copy: the only file tar reads from here on.
    const copy = join(work, 'candidate.tgz');
    writeFileSync(copy, inputBytes, { mode: 0o600, flag: 'wx' });
    const sourceManifest = parseManifest(Buffer.from(io.read('tar', ['-xOzf', copy, MANIFEST])));
    admit(inputBytes, sourceManifest.version, sourceManifest, 'the candidate archive');
    io.read('tar', ['-xzf', copy, '-C', join(work, 'tree')]);
    const packageDir = join(work, 'tree', 'package');
    writeFileSync(join(packageDir, 'package.json'), relabelledManifest(sourceManifest, version));
    const packed = JSON.parse(
      io.read('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], packageDir),
    );
    const filename = Array.isArray(packed) ? packed[0]?.filename : undefined;
    if (typeof filename !== 'string' || basename(filename) !== filename)
      throw new Error('npm pack did not name the archive it wrote');
    const output = join(folder, relabelledName(version));
    renameSync(join(work, filename), output);
    checkRelabelled(inputBytes, readFileSync(output), version, sourceManifest);
    if (sha256(readFileSync(input)) !== inputHash) throw new Error('the candidate archive changed while relabelling');
    return output;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
