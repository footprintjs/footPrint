// Read-only ordinary-tree observations, separate from the pure disclosure law.
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_HIDDEN_LOCK_LOCATIONS as LIMIT, hiddenLockReport } from './hidden-lock.mjs';

export function observeHiddenLock({ source, rootLockBytes, baselineSha256 }) {
  const hiddenPath = join(source, 'node_modules/.package-lock.json');
  const hiddenStat = lstatSync(hiddenPath);
  assert.ok(hiddenStat.isFile() && hiddenStat.nlink === 1, 'regular installed hidden lock required');
  const dirs = [];
  let scanComplete = true;
  function directory(path, location) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return false;
    if (stat.isSymbolicLink()) {
      scanComplete = false;
      return false;
    }
    if (!stat.isDirectory()) return false;
    if (dirs.length === LIMIT) {
      scanComplete = false;
      return false;
    }
    dirs.push({ path: location, mtimeMs: stat.mtimeMs });
    return true;
  }
  function children(path) {
    const names = readdirSync(path).sort();
    if (names.length > LIMIT) scanComplete = false;
    return names.slice(0, LIMIT).filter((name) => {
      if (name === '.store') scanComplete = false;
      return !name.startsWith('.');
    });
  }
  function packageDirectory(path, location) {
    if (directory(path, location)) modules(join(path, 'node_modules'), `${location}/node_modules`);
  }
  function modules(path, location) {
    if (!directory(path, location)) return;
    for (const name of children(path)) {
      if (dirs.length === LIMIT) {
        scanComplete = false;
        break;
      }
      const child = join(path, name),
        at = `${location}/${name}`;
      if (name.startsWith('@')) {
        if (directory(child, at))
          for (const member of children(child)) packageDirectory(join(child, member), `${at}/${member}`);
      } else packageDirectory(child, at);
    }
  }
  modules(join(source, 'node_modules'), 'node_modules');
  return hiddenLockReport({
    rootLockBytes,
    hiddenLockBytes: readFileSync(hiddenPath),
    hiddenMtimeMs: hiddenStat.mtimeMs,
    dirs,
    scanComplete,
    baselineSha256,
  });
}
