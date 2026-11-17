/** Closed native protocol identity checks. No publishing or package execution. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { openSync, fstatSync, readFileSync, closeSync, constants, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, relative, sep, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function bytes(file, maximum) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.nlink === 1 && stat.size >= 0 && stat.size <= maximum,
      'bounded regular input required',
    );
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function command(command, args, cwd, observe) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  observe?.({ argv: [command, ...args], status: result.status, signal: result.signal, error: result.error?.message });
  assert.ok(
    !result.error && result.status === 0 && result.signal === null,
    `${command} failed: ${result.error?.message ?? result.signal ?? result.status}\n${result.stdout ?? ''}\n${
      result.stderr ?? ''
    }`,
  );
  return result.stdout;
}
export function source(root, expected) {
  const head = command('git', ['rev-parse', 'HEAD'], root).trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  if (expected) assert.equal(head, expected);
  const tree = command('git', ['rev-parse', 'HEAD^{tree}'], root).trim();
  assert.match(tree, /^[a-f0-9]{40}$/);
  command('git', ['diff', '--exit-code', 'HEAD', '--'], root);
  const manifestBytes = Buffer.from(command('git', ['show', 'HEAD:package.json'], root));
  assert.ok(manifestBytes.length <= 1024 * 1024);
  assert.deepEqual(JSON.parse(bytes(join(root, 'package.json'), 1024 * 1024)), JSON.parse(manifestBytes));
  return { head, tree, manifest: JSON.parse(manifestBytes), manifestSha256: digest(manifestBytes) };
}
export function installedPackage(root, inspection) {
  assert.ok(!lstatSync(root).isSymbolicLink(), 'package directory cannot be a link');
  const seen = new Map();
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name),
        stat = lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), 'installed package member cannot be a link');
      if (stat.isDirectory()) walk(file);
      else {
        assert.ok(stat.isFile(), 'installed package member must be regular');
        const path = 'package/' + relative(root, file).split(sep).join('/');
        assert.ok(seen.size < 10000);
        seen.set(path, { size: stat.size, sha256: digest(bytes(file, 64 * 1024 * 1024)) });
      }
    }
  }
  walk(root);
  assert.equal(seen.size, inspection.files.length, 'installed package inventory must match the admitted archive');
  for (const member of inspection.files)
    assert.deepEqual(seen.get(member.path), { size: member.size, sha256: member.sha256 });
  return { path: realpathSync(root), files: seen.size };
}
export function strictLock(root, packages) {
  const lock = JSON.parse(bytes(join(root, 'package-lock.json'), 1024 * 1024));
  assert.equal(lock.lockfileVersion, 3);
  for (const { name, archive, inspection } of packages) {
    const entry = lock.packages['node_modules/' + name];
    assert.ok(entry && !entry.link);
    assert.equal(entry.version, inspection.version);
    assert.equal(entry.integrity, inspection.integrity);
    assert.ok(entry.resolved.startsWith('file:'));
    assert.equal(realpathSync(resolve(root, entry.resolved.slice(5))), realpathSync(archive));
  }
  return { sha256: digest(bytes(join(root, 'package-lock.json'), 1024 * 1024)) };
}
/** Full physical dependency inventory, including extraneous nested copies npm might omit. */
export function onePhysicalReader(root, expected) {
  const readers = new Set(),
    visited = new Set();
  let entries = 0;
  function visit(directory, depth = 0) {
    assert.ok(depth <= 64 && ++entries <= 40000, 'physical inventory bound');
    assert.ok(!lstatSync(directory).isSymbolicLink(), 'physical dependency inventory refuses links');
    const canonical = realpathSync(directory);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const names = readdirSync(directory);
    if (names.includes('package.json')) {
      const manifest = JSON.parse(bytes(join(directory, 'package.json'), 1024 * 1024));
      if (manifest.name === 'foottrace') readers.add(canonical);
    }
    for (const name of names) {
      assert.ok(++entries <= 40000, 'physical inventory bound');
      const file = join(directory, name),
        stat = lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), 'physical dependency inventory refuses links');
      // Node resolves bare specifiers from physical node_modules entries, not manifest.name.
      // Include CJS file fallbacks as well as packages, at every possible importer depth.
      if (basename(directory) === 'node_modules' && /^foottrace(?:\.(?:js|json|node))?$/.test(name))
        readers.add(realpathSync(file));
      if (stat.isDirectory()) visit(file, depth + 1);
      else assert.ok(stat.isFile(), 'physical dependency inventory requires regular files');
    }
  }
  visit(join(root, 'node_modules'));
  assert.deepEqual([...readers], [realpathSync(expected)]);
  return [...readers];
}
/** Resolution starts from the actual admitted engine entry, including any dist-level shadow package. */
export function engineReaderResolution(root, expected) {
  const consumer = createRequire(join(root, 'verify-native.mjs'));
  const engineEntry = consumer.resolve('footprintjs');
  const engine = createRequire(engineEntry);
  const readerEntry = realpathSync(engine.resolve('foottrace'));
  const rootReaderEntry = realpathSync(consumer.resolve('foottrace'));
  assert.equal(readerEntry, rootReaderEntry, 'engine must resolve the admitted root reader');
  assert.ok(readerEntry.startsWith(realpathSync(expected) + sep), 'reader entry must belong to admitted package');
  return { engineEntry: realpathSync(engineEntry), readerEntry };
}

/** Receipt failures never replace the primary command/protocol failure, including falsy thrown values. */
export function recordOutcome(operation, persist, secondary) {
  let result, primary;
  try {
    result = operation();
  } catch (error) {
    primary = { error };
  }
  try {
    persist(result, primary);
  } catch (error) {
    if (primary) {
      try {
        secondary(error);
      } catch {}
    } else primary = { error };
  }
  if (primary) throw primary.error;
  return result;
}
