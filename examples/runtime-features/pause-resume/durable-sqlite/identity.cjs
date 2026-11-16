'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { isSafeCode } = require('./codes.cjs');

const ROOT = path.resolve(__dirname, '../../../..');
const fromRoot = createRequire(path.join(ROOT, 'package.json'));
const MAX_WIRE = 64 * 1024;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const refusal = (code) => {
  const safeCode = isSafeCode(code) ? code : 'EXAMPLE_OPERATION_FAILED';
  return Object.assign(new Error(safeCode), { safeCode });
};

function files(root, suffix) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const name = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw refusal('UNEXPECTED_ARTIFACT_SYMLINK');
    if (entry.isDirectory()) found.push(...files(name, suffix));
    else if (entry.isFile() && name.endsWith(suffix)) found.push(name);
  }
  return found.sort();
}

function fileSetDigest(root, names) {
  return sha(names.map((file) => `${path.relative(root, file)}:${sha(fs.readFileSync(file))}`).join('\n'));
}

function trustedIdentity(mode, variant) {
  if (!['source', 'built'].includes(mode) || !['terminal', 'repause'].includes(variant)) {
    throw refusal('UNSUPPORTED_EXAMPLE_MODE');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  let dependencyFile;
  try { dependencyFile = fromRoot.resolve('foottrace/package.json'); }
  catch { throw refusal('LOCKED_RUNTIME_MISSING'); }
  const dependency = JSON.parse(fs.readFileSync(dependencyFile, 'utf8'));
  if (dependency.version !== lock.packages['node_modules/foottrace'].version) {
    throw refusal('LOCKED_RUNTIME_MISMATCH');
  }
  const sdkRoot = path.join(ROOT, mode === 'source' ? 'src' : 'dist');
  if (!fs.existsSync(sdkRoot)) throw refusal('SDK_ARTIFACT_MISSING');
  const sdkFiles = files(sdkRoot, mode === 'source' ? '.ts' : '.js');
  if (!sdkFiles.length) throw refusal('SDK_ARTIFACT_MISSING');
  const dependencyRoot = path.dirname(dependencyFile);
  const dependencyFiles = files(path.join(dependencyRoot, 'dist'), '.js');
  const sdkDigest = sha(JSON.stringify({ mode, sdk: fileSetDigest(sdkRoot, sdkFiles),
    pkg: sha(fs.readFileSync(path.join(ROOT, 'package.json'))),
    lock: sha(fs.readFileSync(path.join(ROOT, 'package-lock.json'))),
    dependency: fileSetDigest(dependencyRoot, [dependencyFile, ...dependencyFiles]) }));
  return Object.freeze({ mode, sdkVersion: pkg.version, sdkDigest,
    programDigest: sha(`${variant}\n${fileSetDigest(__dirname,
      files(__dirname, '.cjs').filter((file) => !file.endsWith('.node-check.cjs')))}`) });
}

function loadSdk(mode) {
  if (mode === 'source') return fromRoot(path.join(ROOT, 'src/index.ts'));
  if (mode === 'built') {
    const resolved = fromRoot.resolve('footprintjs');
    if (fs.realpathSync(resolved) !== fs.realpathSync(path.join(ROOT, 'dist/index.js'))) {
      throw refusal('BUILT_ENTRY_MISMATCH');
    }
    return fromRoot('footprintjs');
  }
  throw refusal('UNSUPPORTED_EXAMPLE_MODE');
}

function privatePaths(dbPath, missing = false) {
  if (typeof dbPath !== 'string' || !path.isAbsolute(dbPath) || path.basename(dbPath) !== 'host.sqlite') {
    throw refusal('INVALID_PRIVATE_PATH');
  }
  const directory = path.dirname(dbPath);
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || fs.realpathSync(directory) !== directory || !path.basename(directory).startsWith('footprint-native-host-')
      || (process.getuid && info.uid !== process.getuid())) throw refusal('INVALID_PRIVATE_PATH');
  for (const name of ['host.sqlite', 'host.sqlite-wal', 'host.sqlite-shm', 'effects.jsonl', 'ready', 'release']) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) continue;
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || (current.mode & 0o077) !== 0) {
      throw refusal('INVALID_PRIVATE_PATH');
    }
  }
  if (!missing && !fs.existsSync(dbPath)) throw refusal('PRIVATE_DATABASE_MISSING');
  return { directory, dbPath, effects: path.join(directory, 'effects.jsonl'),
    ready: path.join(directory, 'ready'), release: path.join(directory, 'release') };
}

function boundedJson(wire) {
  if (typeof wire !== 'string' || Buffer.byteLength(wire) > MAX_WIRE) throw refusal('CHECKPOINT_BOUNDS');
  let value;
  try { value = JSON.parse(wire); } catch { throw refusal('CHECKPOINT_JSON'); }
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++visited > 10_000 || item.depth > 64) throw refusal('CHECKPOINT_BOUNDS');
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return value;
}

function nativeCheckpoint(wire, binding) {
  if (sha(wire) !== binding.checkpointDigest) throw refusal('CHECKPOINT_DIGEST');
  const checkpoint = boundedJson(wire);
  const paused = checkpoint && checkpoint.pausedExecution;
  if (!checkpoint || checkpoint.checkpointVersion !== 2 || checkpoint.pausedStageId !== 'wait'
      || Object.hasOwn(checkpoint, 'pausedBy') || !Array.isArray(checkpoint.subflowPath) || checkpoint.subflowPath.length
      || (checkpoint.pendingPauses && checkpoint.pendingPauses.length)
      || !paused || typeof paused !== 'object' || Array.isArray(paused)
      || Object.keys(paused).length !== 2 || !Object.hasOwn(paused, 'runId') || !Object.hasOwn(paused, 'runtimeStageId')
      || paused.runId !== binding.pausedRunId || typeof paused.runId !== 'string'
      || !/^[A-Za-z0-9_.:-]{1,128}$/.test(paused.runId)
      || typeof paused.runtimeStageId !== 'string' || !/^wait#[0-9]+$/.test(paused.runtimeStageId)
      || binding.pausedStageId !== 'wait') throw refusal('CHECKPOINT_BINDING');
  return checkpoint;
}

module.exports = { ROOT, fromRoot, MAX_WIRE, sha, refusal, trustedIdentity, loadSdk, privatePaths, boundedJson, nativeCheckpoint };
