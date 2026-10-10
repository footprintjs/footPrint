/** Audit overrides must produce a valid npm graph without rewriting unrelated requirements. */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { auditInstallManifest, auditManifestProblem, auditPeerProblem, swap } from '../../scripts/audit-consumers.mjs';

const made: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  made.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const readJSON = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const npm = (root: string, args: string[]) =>
  execFileSync('npm', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
const installedGraph = (root: string) =>
  spawnSync('npm', ['ls', '--all', '--json', '--long'], { cwd: root, encoding: 'utf8', timeout: 30_000 });

function packageAt(root: string, directory: string, name: string, version: string, marker = directory) {
  const path = join(root, directory);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
  writeFileSync(join(path, 'index.js'), `module.exports = ${JSON.stringify(marker)};\n`);
  return path;
}

function pack(root: string, source: string, destination: string) {
  const path = join(root, 'archives', destination);
  mkdirSync(path, { recursive: true });
  const [packed] = JSON.parse(npm(source, ['pack', '--ignore-scripts', '--json', '--pack-destination', path]));
  return join(path, packed.filename);
}

async function localRegistry(archive: string) {
  // Separate process: swap invokes npm synchronously while this loopback-only registry serves it.
  const server = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const archive = readFileSync(process.argv[1]);
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
const server = createServer((request, response) => {
  if (request.url === '/footprintjs.tgz') return response.end(archive);
  if (request.url !== '/footprintjs') { response.writeHead(404); return response.end(); }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ name: 'footprintjs', 'dist-tags': { latest: '9.48.3' }, versions: {
    '9.48.3': { name: 'footprintjs', version: '9.48.3', dist: {
      tarball: 'http://127.0.0.1:' + server.address().port + '/footprintjs.tgz', integrity,
    } },
  } }));
});
server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));`,
      archive,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const url = await new Promise<string>((resolve, reject) => {
    let errorOutput = '';
    server.stderr.on('data', (data) => (errorOutput += data.toString()));
    const timeout = setTimeout(() => {
      server.kill();
      reject(new Error('local fixture registry did not start'));
    }, 10_000);
    server.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`local fixture registry exited (${code}): ${errorOutput}`));
    });
    server.stdout.once('data', (data) => {
      clearTimeout(timeout);
      resolve(data.toString().trim());
    });
  });
  return { url, stop: () => server.kill() };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-install-')));
  made.push(root);
  // Every dependency is a generated local package. A cache miss cannot contact a registry.
  vi.stubEnv('npm_config_cache', join(root, 'npm-cache'));
  vi.stubEnv('npm_config_offline', 'true');
  vi.stubEnv('npm_config_ignore_scripts', 'true');
  vi.stubEnv('npm_config_package_lock', 'true');
  const originalEngine = packageAt(root, 'engine-original', 'footprintjs', '9.48.3');
  const originalUi = packageAt(root, 'ui-original', 'footprint-explainable-ui', '0.37.0');
  const trace = packageAt(root, 'record', 'foottrace', '1.0.0');
  const unrelated = packageAt(root, 'unrelated', 'unrelated', '1.0.0');
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  const original = {
    name: 'audit-consumer',
    version: '1.0.0',
    private: true,
    description: 'Unchanged consumer metadata',
    scripts: { test: 'node index.js' },
    dependencies: {
      footprintjs: `file:${originalEngine}`,
      'footprint-explainable-ui': `file:${originalUi}`,
      foottrace: `file:${trace}`,
      unrelated: `file:${unrelated}`,
    },
  };
  writeFileSync(join(consumer, 'package.json'), JSON.stringify(original, null, 2));
  npm(consumer, ['install', '--no-audit', '--no-fund']);
  const candidate = pack(root, packageAt(root, 'engine-candidate', 'footprintjs', '9.48.3'), 'candidate');
  const baseline = pack(root, packageAt(root, 'engine-baseline', 'footprintjs', '9.48.3'), 'baseline');
  const ui = pack(root, packageAt(root, 'ui-published', 'footprint-explainable-ui', '0.38.0'), 'ui@review');
  return { root, consumer, original, candidate, baseline, pins: [`footprint-explainable-ui@file:${ui}`] };
}

describe('real npm audit overrides', () => {
  it('repairs no-save declaration mismatches and retains originals across two exact artifact swaps', () => {
    const { consumer, original, candidate, baseline, pins } = fixture();
    expect(installedGraph(consumer).status).toBe(0);
    const recordPath = realpathSync(join(consumer, 'node_modules/foottrace'));
    const recordManifest = readJSON(join(recordPath, 'package.json'));

    // Negative control: the former harness installs successfully but leaves npm's graph invalid.
    npm(consumer, ['install', '--no-save', '--no-audit', '--no-fund', ...pins, candidate]);
    expect(readJSON(join(consumer, 'package.json'))).toEqual(original);
    const invalid = installedGraph(consumer);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain('invalid: footprintjs@9.48.3');
    expect(invalid.stderr).toContain('invalid: footprint-explainable-ui@0.38.0');

    const notes = new Set<string>();
    const originals = new Map();
    for (const [archive, marker] of [
      [candidate, 'engine-candidate'],
      [baseline, 'engine-baseline'],
    ]) {
      expect(swap([consumer], archive, pins, notes, [consumer], originals).ok, [...notes].join('\n')).toBe(true);
      const graph = installedGraph(consumer);
      expect(graph.status, graph.stderr).toBe(0);
      expect(readFileSync(join(consumer, 'node_modules/footprintjs/index.js'), 'utf8')).toContain(marker);
      const current = readJSON(join(consumer, 'package.json'));
      expect(auditManifestProblem(original, current, ['footprintjs', 'footprint-explainable-ui'])).toBeNull();
      expect(current.dependencies.foottrace).toBe(original.dependencies.foottrace);
      expect(current.dependencies.unrelated).toBe(original.dependencies.unrelated);
      expect(current.scripts).toEqual(original.scripts);
      expect(current.description).toBe(original.description);
      expect(realpathSync(join(consumer, 'node_modules/foottrace'))).toBe(recordPath);
      expect(readJSON(join(recordPath, 'package.json'))).toEqual(recordManifest);
      expect(originals.get(consumer)).toEqual(original);
    }
    expect([...notes].join('\n')).toContain(
      `dependencies.footprintjs=${JSON.stringify(original.dependencies.footprintjs)}`,
    );
    expect([...notes].join('\n')).toContain(
      `dependencies.footprint-explainable-ui=${JSON.stringify(original.dependencies['footprint-explainable-ui'])}`,
    );
    expect([...notes].filter((note) => note.includes('original dependencies.footprintjs='))).toHaveLength(1);
  }, 45_000);

  it('still rejects an unrelated missing file dependency without removing or replacing its declaration', () => {
    const { root, consumer, original, candidate, pins } = fixture();
    const missing = `file:${join(root, 'missing-real-sibling')}`;
    const manifest = { ...original, dependencies: { ...original.dependencies, 'missing-sibling': missing } };
    writeFileSync(join(consumer, 'package.json'), JSON.stringify(manifest, null, 2));
    const notes = new Set<string>();
    expect(swap([consumer], candidate, pins, notes).ok).toBe(false);
    expect(readJSON(join(consumer, 'package.json')).dependencies['missing-sibling']).toBe(missing);
    expect(installedGraph(consumer).status).not.toBe(0);
  }, 45_000);

  it('fails a linked sibling peer incompatibility without changing that peer contract', () => {
    const { root, consumer, original, candidate, pins } = fixture();
    const sibling = packageAt(root, 'incompatible', 'audit-incompatible', '1.0.0');
    const siblingOriginal = {
      ...readJSON(join(sibling, 'package.json')),
      devDependencies: { footprintjs: '9.48.3' },
      peerDependencies: { footprintjs: '^8.0.0' },
    };
    writeFileSync(join(sibling, 'package.json'), JSON.stringify(siblingOriginal));
    npm(sibling, ['install', '--no-save', '--no-audit', '--no-fund', candidate]);
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({
        ...original,
        dependencies: { ...original.dependencies, footprintjs: '9.48.3', 'audit-incompatible': `file:${sibling}` },
      }),
    );
    npm(consumer, ['install', '--no-save', '--no-audit', '--no-fund', candidate]);
    // npm itself misses this conflict: the concrete dev edge shadows the incompatible peer.
    expect(installedGraph(consumer).status).toBe(0);
    const notes = new Set<string>();
    expect(swap([consumer, sibling], candidate, pins, notes).ok).toBe(false);
    expect([...notes].join('\n')).toContain('incompatible with original peer requirement "^8.0.0"');
    expect(readJSON(join(sibling, 'package.json'))).toEqual(siblingOriginal);
  }, 45_000);

  it('preflights the last consumer and registry-pin peers before mutating any target', () => {
    const { root, consumer, original, candidate, pins } = fixture();
    const sibling = packageAt(root, 'uninstalled-sibling', 'audit-sibling', '1.0.0');
    const siblingBefore = readJSON(join(sibling, 'package.json'));
    const consumerBefore = { ...original, peerDependencies: { 'footprint-explainable-ui': '^0.37.0' } };
    writeFileSync(join(consumer, 'package.json'), JSON.stringify(consumerBefore));
    const notes = new Set<string>();
    expect(swap([consumer, sibling], candidate, pins, notes).ok).toBe(false);
    expect([...notes].join('\n')).toContain('footprint-explainable-ui@0.38.0: incompatible');
    expect(readJSON(join(sibling, 'package.json'))).toEqual(siblingBefore);
    expect(readJSON(join(consumer, 'package.json'))).toEqual(consumerBefore);
    expect(existsSync(join(sibling, 'node_modules'))).toBe(false);
  }, 45_000);

  it('preserves linked sibling peers and exact sources across candidate and same-version registry fallback', async () => {
    const { root, consumer, original, candidate, baseline, pins } = fixture();
    const sibling = packageAt(root, 'sibling', 'audit-sibling', '1.0.0');
    const siblingOriginal = {
      ...readJSON(join(sibling, 'package.json')),
      devDependencies: { footprintjs: original.dependencies.footprintjs },
      peerDependencies: { footprintjs: '^9.0.0' },
    };
    writeFileSync(join(sibling, 'package.json'), JSON.stringify(siblingOriginal));
    npm(sibling, ['install', '--no-audit', '--no-fund']);
    const peerOnly = packageAt(root, 'peer-only', 'audit-peer-only', '1.0.0');
    const peerOriginal = {
      ...readJSON(join(peerOnly, 'package.json')),
      peerDependencies: { footprintjs: '^9.0.0' },
      peerDependenciesMeta: { footprintjs: { optional: true } },
    };
    writeFileSync(join(peerOnly, 'package.json'), JSON.stringify(peerOriginal));
    npm(peerOnly, ['install', '--no-audit', '--no-fund']);
    const consumerOriginal = {
      ...original,
      dependencies: {
        ...original.dependencies,
        'audit-sibling': `file:${sibling}`,
        'audit-peer-only': `file:${peerOnly}`,
      },
    };
    writeFileSync(join(consumer, 'package.json'), JSON.stringify(consumerOriginal));
    npm(consumer, ['install', '--no-audit', '--no-fund']);
    const scoped = pack(root, packageAt(root, 'scoped', '@audit/scoped-pin', '1.2.3'), 'scoped@review');
    pins.push(`@audit/scoped-pin@file:${scoped}`);

    // Named --save also rewrites peers to file:, a second regression in linked workspaces.
    npm(sibling, ['install', '--save', '--save-exact', '--no-audit', '--no-fund', candidate]);
    expect(readJSON(join(sibling, 'package.json')).peerDependencies.footprintjs).toMatch(/^file:/);
    expect(installedGraph(consumer).status).not.toBe(0);
    // Reset only this negative control's manifest; production must preserve the original peers itself.
    writeFileSync(join(sibling, 'package.json'), JSON.stringify(siblingOriginal));

    const dirs = [consumer, sibling, peerOnly];
    const notes = new Set<string>();
    const originals = new Map();
    const recordPath = realpathSync(join(consumer, 'node_modules/foottrace'));
    const registry = await localRegistry(baseline);
    vi.stubEnv('npm_config_offline', 'false');
    vi.stubEnv('npm_config_registry', registry.url);
    try {
      for (const [spec, marker, resolved] of [
        [candidate, 'engine-candidate', `file:${candidate}`],
        ['footprintjs@9.48.3', 'engine-baseline', `${registry.url}/footprintjs.tgz`],
      ]) {
        expect(swap(dirs, spec, pins, notes, dirs, originals).ok, [...notes].join('\n')).toBe(true);
        // Inspect after ALL installs: a consumer installation must not silently replace a sibling's source.
        for (const dir of dirs) {
          const graph = installedGraph(dir);
          expect(graph.status, graph.stderr).toBe(0);
          expect(readFileSync(join(dir, 'node_modules/footprintjs/index.js'), 'utf8')).toContain(marker);
          const installed = readJSON(join(dir, 'node_modules/.package-lock.json')).packages['node_modules/footprintjs'];
          if (resolved.startsWith('file:')) {
            expect(installed.resolved).toMatch(/^file:/);
            expect(realpathSync(join(dir, installed.resolved.slice(5)))).toBe(candidate);
          } else expect(installed.resolved).toBe(resolved);
        }
        const siblingAfter = readJSON(join(sibling, 'package.json'));
        const peerAfter = readJSON(join(peerOnly, 'package.json'));
        expect(siblingAfter.peerDependencies).toEqual(siblingOriginal.peerDependencies);
        expect(peerAfter.peerDependencies).toEqual(peerOriginal.peerDependencies);
        expect(peerAfter.peerDependenciesMeta).toEqual(peerOriginal.peerDependenciesMeta);
        expect(siblingAfter.devDependencies.footprintjs).toBe('9.48.3');
        expect(peerAfter.devDependencies.footprintjs).toBe('9.48.3');
        expect(siblingAfter.devDependencies['@audit/scoped-pin']).toBeUndefined();
        expect(peerAfter.devDependencies['@audit/scoped-pin']).toBeUndefined();
        expect(readJSON(join(consumer, 'package.json')).devDependencies['@audit/scoped-pin']).toBe('1.2.3');
        expect(originals.get(sibling)).toEqual(siblingOriginal);
        expect(originals.get(peerOnly)).toEqual(peerOriginal);
        expect(originals.get(consumer)).toEqual(consumerOriginal);
        expect(realpathSync(join(consumer, 'node_modules/foottrace'))).toBe(recordPath);
      }
    } finally {
      registry.stop();
    }
    expect([...notes].join('\n')).toContain('peerDependencies.footprintjs="^9.0.0"');
    expect([...notes].join('\n')).toContain('audit-only override of @audit/scoped-pin; original not directly declared');
  }, 45_000);
});

describe('audit override boundaries', () => {
  it.each([
    ['9.48.3', '^9.0.0 || ^10.0.0', true],
    ['10.0.0', '^9.0.0 || ^10.0.0', true],
    ['10.0.0-beta.1', '^9.0.0 || ^10.0.0', false],
    ['10.0.0-beta.1', '>=10.0.0-beta.0 <10.0.0', true],
    ['9.48.3', '^8.0.0', false],
    ['9.48.3', 'file:../candidate.tgz', false],
    ['9.48.3', 7, false],
    ['not-a-version', '*', false],
  ])('checks exact version %s against original peer %s', (version, range, compatible) => {
    const original = { peerDependencies: { footprintjs: range } };
    const result = auditPeerProblem(original, new Map([['footprintjs', version]]));
    expect(result === null).toBe(compatible);
    expect(original.peerDependencies.footprintjs).toBe(range);
  });

  it('allows only intended package entries, preserving unrelated requirements and metadata', () => {
    const before = {
      name: 'consumer',
      dependencies: { footprintjs: 'file:../footPrint', foottrace: '^1.0.0', unrelated: '^2.0.0' },
      peerDependencies: { footprintjs: '^9.0.0' },
      scripts: { test: 'vitest run' },
    };
    const after = structuredClone(before);
    after.dependencies.footprintjs = 'file:/candidate.tgz';
    expect(auditManifestProblem(before, after, new Set(['footprintjs']))).toBeNull();
    for (const change of [
      { ...after, peerDependencies: { footprintjs: '9.48.3' } },
      { ...after, dependencies: { ...after.dependencies, foottrace: '^2.0.0' } },
      { ...after, dependencies: { ...after.dependencies, unrelated: '^3.0.0' } },
      { ...after, scripts: { test: 'true' } },
      { ...after, description: 'unrequested metadata' },
    ])
      expect(auditManifestProblem(before, change, ['footprintjs'])).toMatch(/unrelated/);
  });

  it('plans concrete exact versions without changing peers, including peer-only and undeclared overrides', () => {
    const original = {
      dependencies: { footprintjs: 'file:../footPrint', unrelated: '^2.0.0' },
      devDependencies: { footprintjs: '^9.0.0' },
      optionalDependencies: { footprintjs: '^9.0.0' },
      peerDependencies: { footprintjs: '^9.0.0', 'peer-only': '^1.0.0' },
      peerDependenciesMeta: { 'peer-only': { optional: true } },
    };
    const untouched = structuredClone(original);
    const planned = auditInstallManifest(
      original,
      new Map([
        ['footprintjs', '9.48.3'],
        ['peer-only', '1.2.3'],
        ['@audit/undeclared', '2.3.4'],
      ]),
    );
    expect(planned).toEqual({
      ...original,
      dependencies: { footprintjs: '9.48.3', unrelated: '^2.0.0' },
      devDependencies: { footprintjs: '9.48.3', 'peer-only': '1.2.3', '@audit/undeclared': '2.3.4' },
      optionalDependencies: { footprintjs: '9.48.3' },
    });
    expect(original).toEqual(untouched);
    expect(auditManifestProblem(original, planned, ['footprintjs', 'peer-only', '@audit/undeclared'])).toBeNull();
  });

  it('supplies the genuine Agent Samples sibling after the Agent Footprint dependency it links', () => {
    const { family } = readJSON(join(__dirname, '../../scripts/family.json'));
    const { siblings } = family.find((entry: { package: string }) => entry.package === 'agent-playground');
    const samples = siblings.findIndex((entry: { dir: string }) => entry.dir === 'agent-samples');
    expect(samples).toBeGreaterThan(siblings.findIndex((entry: { dir: string }) => entry.dir === 'agentfootprint'));
    expect(siblings[samples]).toEqual({
      repo: 'footprintjs/agent-samples',
      branch: 'main',
      dir: 'agent-samples',
      setup: 'npm ci --ignore-scripts --no-audit --no-fund',
    });
  });
});
