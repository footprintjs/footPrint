/** E3 must test the pinned archive and refuse missing evidence or a second record implementation. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  installedFoottraceProblem,
  readFoottraceCandidate,
  shareFoottraceCandidate,
  validatePin,
} from '../../scripts/foottrace-candidate.mjs';

const made: string[] = [];
afterEach(() => made.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const pin = { repository: 'footprintjs/foottrace', commit: 'a'.repeat(40), version: '1.0.0' };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'foottrace-candidate-test-'));
  made.push(root);
  const archive = join(root, 'foottrace-candidate.tgz');
  const bytes = Buffer.from('one exact archive');
  const manifest = { ...pin, integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
  writeFileSync(archive, bytes);
  writeFileSync(archive + '.json', JSON.stringify(manifest));
  const candidate = { ...manifest, archive };
  const installed = { version: pin.version, resolved: 'file:' + archive, integrity: manifest.integrity };
  function lock(packages: Record<string, unknown>) {
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules/.package-lock.json'), JSON.stringify({ packages }));
  }
  return { root, archive, candidate, installed, lock };
}

describe('the temporary E3 candidate bootstrap', () => {
  it('requires an immutable commit and the approved repository/version', () => {
    expect(validatePin(pin)).toEqual(pin);
    for (const commit of ['main', 'extract/foottrace', 'PENDING_FOOTTRACE_CANDIDATE_COMMIT', '0'.repeat(40)])
      expect(() => validatePin({ ...pin, commit })).toThrow(/exact pushed foottrace commit/);
    expect(() => validatePin({ ...pin, repository: 'somewhere/else' })).toThrow(/exact pushed foottrace commit/);
    expect(() => validatePin({ ...pin, version: '2.0.0' })).toThrow(/only for foottrace 1.0.0/);
  });

  it('accepts exactly the pinned source identity and archive bytes', () => {
    const { archive, candidate } = fixture();
    expect(readFoottraceCandidate(archive, pin)).toEqual(candidate);
    expect(() => readFoottraceCandidate(archive, { ...pin, commit: 'b'.repeat(40) })).toThrow(/commit does not match/);
    writeFileSync(archive, 'different archive, same name');
    expect(() => readFoottraceCandidate(archive, pin)).toThrow(/integrity does not match/);
  });

  it('accepts one exact root install and rejects registry or same-version stale artifacts', () => {
    const { root, candidate, installed, lock } = fixture();
    expect(installedFoottraceProblem(root, candidate)).toMatch(/did not record/);
    lock({ 'node_modules/foottrace': installed });
    expect(installedFoottraceProblem(root, candidate)).toBeNull();
    for (const change of [
      { resolved: 'https://registry.npmjs.org/foottrace/-/foottrace-1.0.0.tgz' },
      { integrity: 'sha512-old-candidate' },
      { version: '1.0.1' },
    ]) {
      lock({ 'node_modules/foottrace': { ...installed, ...change } });
      expect(installedFoottraceProblem(root, candidate)).toMatch(/not the exact candidate/);
    }
  });

  it('rejects duplicate physical copies even when their versions match', () => {
    const { root, candidate, installed, lock } = fixture();
    lock({ 'node_modules/foottrace': installed, 'node_modules/other/node_modules/foottrace': installed });
    expect(installedFoottraceProblem(root, candidate)).toMatch(/expected one root foottrace/);
    lock({ 'node_modules/other/node_modules/foottrace': installed });
    expect(installedFoottraceProblem(root, candidate)).toMatch(/expected one root foottrace/);
    lock({});
    expect(installedFoottraceProblem(root, candidate)).toMatch(/found none/);
  });

  it('linked sibling consumers resolve one module instance, only inside the isolated audit workspace', () => {
    const { root, candidate } = fixture();
    const dirs = ['consumer', 'sibling'].map((name) => join(root, name));
    for (const dir of dirs) {
      const installed = join(dir, 'node_modules/foottrace');
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'foottrace', version: '1.0.0' }));
      writeFileSync(join(installed, 'index.js'), 'module.exports = {};');
      writeFileSync(
        join(dir, 'node_modules/.package-lock.json'),
        JSON.stringify({
          packages: {
            'node_modules/foottrace': {
              version: candidate.version,
              resolved: 'file:' + candidate.archive,
              integrity: candidate.integrity,
            },
          },
        }),
      );
    }
    const paths = dirs.map((dir) => join(dir, 'node_modules/foottrace'));
    expect(new Set(paths.map((path) => realpathSync(path))).size).toBe(2);
    expect(() => shareFoottraceCandidate(dirs, candidate, dirs[0])).toThrow(/outside the temporary audit workspace/);
    expect(new Set(paths.map((path) => realpathSync(path))).size).toBe(2);
    expect(() => shareFoottraceCandidate(dirs, { ...candidate, integrity: 'sha512-wrong' }, root)).toThrow(
      /not the exact candidate/,
    );
    expect(new Set(paths.map((path) => realpathSync(path))).size).toBe(2);
    shareFoottraceCandidate(dirs, candidate, root);
    expect(new Set(paths.map((path) => realpathSync(path))).size).toBe(1);
    const requires = dirs.map((dir) => createRequire(join(dir, 'entry.cjs')));
    expect(requires[0]('foottrace')).toBe(requires[1]('foottrace'));
    expect(() => shareFoottraceCandidate(dirs, candidate, root)).not.toThrow();
  });
});
