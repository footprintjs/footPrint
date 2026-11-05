// Reuse the existing archive/profile and installed-graph laws, not another parser.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { CANDIDATE, requireMetadata } from './plan.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function inspectCandidate({ tar, metadata }) {
  requireMetadata(metadata);
  const stat = lstatSync(tar);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'candidate must be one regular file');
  // The producer's pack.mjs applies the exact candidate's canonical archive reader.
  // Every leg binds that uploaded report back to the actual unchanged tar bytes.
  const bytes = readFileSync(tar);
  assert.equal(bytes.length, metadata.bytes);
  assert.equal(sha256(bytes), metadata.sha256, 'candidate archive digest changed');
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, metadata.integrity);
  return metadata;
}

/** Byte equality is an additional candidate assertion, not a replacement singleton law. */
export function assertInstalledImage(directory, report) {
  assert.equal(lstatSync(directory).isSymbolicLink(), false, 'candidate installation must not be linked');
  const actual = {};
  function visit(current) {
    for (const name of readdirSync(current).sort()) {
      if (name === 'node_modules') continue;
      const path = join(current, name),
        stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false, 'candidate contains a linked file');
      if (stat.isDirectory()) visit(path);
      else {
        assert.ok(stat.isFile(), 'candidate contains a non-file entry');
        actual[relative(directory, path).replaceAll('\\', '/')] = sha256(readFileSync(path));
      }
    }
  }
  visit(directory);
  const expected = Object.fromEntries(
    report.files.map(({ path, sha256: digest }) => {
      assert.ok(path.startsWith('package/'), 'canonical archive report required');
      return [path.slice('package/'.length), digest];
    }),
  );
  assert.deepEqual(actual, expected, 'installed Foottrace bytes differ from the canonical candidate');
  const identity = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  assert.equal(identity.name, CANDIDATE.name);
  assert.equal(identity.version, CANDIDATE.version);
  return { path: realpathSync(directory), files: Object.keys(actual).length };
}

export async function verifyInstalled({ source, tree, report }) {
  const { checkFoottraceTree } = await import('../foottrace-install.mjs');
  const inspected = checkFoottraceTree(tree, { required: true });
  assert.equal(inspected.ok, true, inspected.message);
  assert.equal(inspected.version, CANDIDATE.version, 'wrong installed Foottrace version');
  const installed = join(source, 'node_modules/foottrace');
  assert.equal(realpathSync(installed), inspected.path, 'npm graph must select the root candidate owner');
  return { ...inspected, image: assertInstalledImage(installed, report) };
}
