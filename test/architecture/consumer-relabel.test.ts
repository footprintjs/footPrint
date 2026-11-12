/**
 * The relabelled candidate (scripts/consumer-relabel.mjs): the candidate's archive with only
 * `package.json · version` changed, checked member by member with the release archive inspector.
 * These tests run real `tar` and real `npm pack` on archives built by the inspector's own fixture.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { read } from '../../scripts/audit-process.mjs';
import {
  checkRelabelled,
  relabelCandidate,
  relabelledManifest,
  relabelledName,
} from '../../scripts/consumer-relabel.mjs';
import { entry, pack, source, tar } from '../../scripts/publish-release/archive/fixture.cjs';
import { inspectArchive } from '../../scripts/publish-release/archive/inspector.cjs';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const manifestOf = (archive: string) =>
  JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }));
const candidateManifest = { ...source, version: '12.0.0' };
const members = [
  entry('package/README.md', '# footprintjs\n'),
  entry('package/dist/esm/index.js', 'export const answer = 42;\n'),
];

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-relabel-')));
  roots.push(root);
  // npm pack needs no registry: a cache miss must not reach one.
  vi.stubEnv('npm_config_cache', join(root, 'npm-cache'));
  vi.stubEnv('npm_config_offline', 'true');
  vi.stubEnv('npm_config_update_notifier', 'false');
  const candidate = join(root, 'candidate', 'footprintjs-candidate.tgz');
  mkdirSync(dirname(candidate));
  writeFileSync(candidate, pack(candidateManifest, members));
  return { root, candidate };
}

describe('relabelling the candidate', () => {
  it('changes only the version, never writes the input, and names the copy for what it is', () => {
    const { root, candidate } = workspace();
    const before = sha256(readFileSync(candidate));
    const output = relabelCandidate(candidate, '11.2.0', join(root, 'relabelled'));

    expect(basename(output)).toBe('footprintjs-candidate-as-11.2.0.tgz');
    expect(relabelledName('11.2.0')).toBe(basename(output));
    expect(dirname(output)).toBe(join(root, 'relabelled'));
    expect(sha256(readFileSync(candidate))).toBe(before);

    expect(manifestOf(output)).toEqual({ ...candidateManifest, version: '11.2.0' });
    const original = inspectArchive(readFileSync(candidate), {
      package: 'footprintjs',
      version: '12.0.0',
      sourceManifest: candidateManifest,
    });
    const relabelled = inspectArchive(readFileSync(output), {
      package: 'footprintjs',
      version: '11.2.0',
      sourceManifest: candidateManifest,
    });
    const byPath = (files: { path: string; sha256: string }[]) =>
      Object.fromEntries(files.map((file) => [file.path, file.sha256]));
    const want = byPath(original.files);
    const got = byPath(relabelled.files);
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const path of Object.keys(want).filter((p) => p !== 'package/package.json'))
      expect(got[path]).toBe(want[path]);
    // The work folder is gone: only the checked archive is left.
    expect(readFileSync(output).length).toBeGreaterThan(0);
    expect(() => readFileSync(join(root, 'relabelled', 'unpacked-11.2.0', 'package', 'package.json'))).toThrow();
  }, 30_000);

  it('refuses to write beside the candidate, and refuses a label that is not a version', () => {
    const { candidate } = workspace();
    expect(() => relabelCandidate(candidate, '11.2.0', dirname(candidate))).toThrow('beside the candidate');
    expect(() => relabelCandidate(candidate, '11.2.0; rm -rf /', join(dirname(candidate), '..', 'x'))).toThrow(
      'not a version label',
    );
  });

  it('refuses an input the archive inspector does not admit, before extracting anything', () => {
    const { root } = workspace();
    const odd = join(root, 'odd.tgz');
    writeFileSync(odd, pack(candidateManifest, [entry('package/.npmrc', 'registry=https://example.invalid/\n')]));
    const calls: string[][] = [];
    const io = {
      read: (command: string, args: string[], cwd?: string) => {
        calls.push([command, ...args]);
        return read(command, args, cwd);
      },
    };
    expect(() => relabelCandidate(odd, '11.2.0', join(root, 'relabelled'), io)).toThrow(
      'refused by the archive inspector',
    );
    // Only the manifest was printed to a pipe; nothing was extracted to disk and nothing was packed.
    expect(calls.map((call) => call.slice(0, 2))).toEqual([['tar', '-xOzf']]);
  });

  it('extracts the private copy of the inspected bytes, never the input path read again', () => {
    const { root, candidate } = workspace();
    const calls: string[][] = [];
    const io = {
      read: (command: string, args: string[], cwd?: string) => {
        calls.push([command, ...args]);
        return read(command, args, cwd);
      },
    };
    relabelCandidate(candidate, '11.2.0', join(root, 'relabelled'), io);
    const tarCalls = calls.filter(([command]) => command === 'tar');
    expect(tarCalls).toHaveLength(2);
    for (const call of tarCalls) {
      expect(call[2]).not.toBe(candidate);
      expect(call[2]).toBe(join(root, 'relabelled', 'unpacked-11.2.0', 'candidate.tgz'));
    }
  }, 30_000);

  it('refuses when the input archive changed while it was being relabelled', () => {
    const { root, candidate } = workspace();
    const io = {
      read: (command: string, args: string[], cwd?: string) => {
        // Someone writes the input while npm packs the copy.
        if (command === 'npm') writeFileSync(candidate, Buffer.concat([readFileSync(candidate), Buffer.from([0])]));
        return read(command, args, cwd);
      },
    };
    expect(() => relabelCandidate(candidate, '11.2.0', join(root, 'relabelled'), io)).toThrow(
      'changed while relabelling',
    );
  }, 30_000);
});

describe('the check of a relabelled archive', () => {
  const input = pack(candidateManifest, members);
  const check = (relabelled: Buffer) => () => checkRelabelled(input, relabelled, '11.2.0', candidateManifest);
  // What the writer puts in an archive: the exact manifest text, keys in the input's order.
  const relabelledWith = (manifest: Record<string, unknown>, extra = members) =>
    pack(relabelledManifest(manifest, manifest.version as string), extra);

  it('admits the archive that changed only the version', () => {
    expect(check(relabelledWith({ ...candidateManifest, version: '11.2.0' }))).not.toThrow();
  });

  it('catches another member whose bytes changed', () => {
    const changed = [members[0], entry('package/dist/esm/index.js', 'export const answer = 43;\n')];
    expect(check(relabelledWith({ ...candidateManifest, version: '11.2.0' }, changed))).toThrow(
      'changed package/dist/esm/index.js',
    );
  });

  it('catches a member added or left out', () => {
    expect(check(relabelledWith({ ...candidateManifest, version: '11.2.0' }, [members[1]]))).toThrow('same members');
    const added = [...members, entry('package/dist/extra.js', '1;\n')];
    expect(check(relabelledWith({ ...candidateManifest, version: '11.2.0' }, added))).toThrow('same members');
  });

  it('catches a manifest whose keys were reordered: in `exports` the order decides which file resolves', () => {
    const exportsRoot = (candidateManifest.exports as Record<string, Record<string, unknown>>)['.'];
    const reversed = Object.fromEntries(Object.entries(exportsRoot).reverse());
    expect(Object.keys(reversed)).not.toEqual(Object.keys(exportsRoot));
    const reordered = {
      ...candidateManifest,
      version: '11.2.0',
      exports: { ...(candidateManifest.exports as object), '.': reversed },
    };
    expect(check(relabelledWith(reordered))).toThrow('not the input manifest with only its version replaced');
    // The same text through a writer that drops the trailing newline is caught as well.
    expect(check(pack(relabelledManifest(candidateManifest, '11.2.0').trimEnd(), members))).toThrow(
      'not the input manifest',
    );
  });

  it('catches a manifest that changed anything but the version, or took another version', () => {
    expect(check(relabelledWith({ ...candidateManifest, version: '11.2.0', description: 'other' }))).toThrow(
      'refused by the archive inspector: manifest-source:description',
    );
    expect(check(relabelledWith({ ...candidateManifest, version: '11.1.0' }))).toThrow('refused');
    expect(check(gzipSync(tar([entry('package/package.json', '{}')])))).toThrow('refused');
  });
});
