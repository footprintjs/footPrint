import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { entry, tar } from '../../publish-release/archive/fixture.cjs';
import { inspectPacked, verifyInstalled } from '../bytes/index.mjs';
import { specimenFiles, requireProofReceipt } from '../origin/proof.mjs';
import { directNode } from './process.mjs';
import { provePublicVersions } from './index.mjs';

// These tiny fake public packages exercise transport/guards, never real AF15 behavior.
function fixture(fault) {
  const home = mkdtempSync(join(tmpdir(), 'public-proof-fixture-')),
    folder = join(home, 'bundle');
  mkdirSync(folder);
  const selected = new Map();
  const make = (manifest, files) => {
    const path = join(folder, manifest.name + '.tgz');
    writeFileSync(
      path,
      gzipSync(
        tar([
          entry('package/package.json', JSON.stringify(manifest)),
          ...Object.entries(files).map(([path, code]) => entry('package/' + path, code)),
        ]),
      ),
    );
    selected.set(manifest.name, { ...inspectPacked(path, manifest), path });
  };
  const code = {
    root: `exports.Agent={create:({provider})=>({system:()=>({build:()=>({run:async()=>provider.reply,shutdown:async()=>{require('node:fs').appendFileSync(process.cwd()+'/shutdown.marker','1');}})})})};`,
    providers: 'exports.MockProvider=class {constructor(options){this.reply=options.replies[0];}};',
    observe: `exports.recordRun=()=>({stop(){require('node:fs').appendFileSync(process.cwd()+'/stop.marker','1');}});exports.buildRecordingEnvelope=()=>({format:'agentfootprint.recording.v1',producer:{agentfootprintVersion:${
      fault === 'stale-version' ? "'14.7.2'" : "require('../package.json').version"
    },footprintjsVersion:require('footprintjs/package.json').version},recording:{events:[{}],snapshot:${
      fault === 'null-snapshot' ? 'null' : '{}'
    },structure:${fault === 'null-structure' ? 'null' : '{}'}},run:{droppedEvents:0,runId:'fixture'}});`,
  };
  if (fault === 'output-overflow') code.root = "process.stdout.write('x'.repeat(1024*1024+1));" + code.root;
  const exportsMap = {};
  const files = {};
  for (const [key, body] of Object.entries(code)) {
    const exportName = key === 'root' ? '.' : './' + key;
    exportsMap[exportName] = { import: './dist/' + key + '.mjs', require: './dist/' + key + '.cjs' };
    files['dist/' + key + '.cjs'] = body;
    files['dist/' + key + '.mjs'] =
      `import c from './${key}.cjs';\n` +
      (key === 'root'
        ? 'export const Agent=c.Agent;'
        : key === 'providers'
        ? 'export const MockProvider=c.MockProvider;'
        : 'export const recordRun=c.recordRun,buildRecordingEnvelope=c.buildRecordingEnvelope;');
  }
  make(
    {
      name: 'agentfootprint',
      version: '15.0.0-rc.0',
      exports: exportsMap,
      dependencies: { footprintjs: '^13.0.0-rc.0', foottrace: '^2.0.0-rc.0' },
    },
    files,
  );
  make(
    { name: 'footprintjs', version: '13.0.0-rc.0', main: 'dist/index.js', dependencies: { foottrace: '^2.0.0-rc.0' } },
    { 'dist/index.js': 'module.exports="fixture";' },
  );
  make(
    { name: 'foottrace', version: '2.0.0-rc.0', main: 'dist/index.js' },
    { 'dist/index.js': 'module.exports="trace-fixture";' },
  );
  let root,
    runCalls = 0;
  const installPaired = (destination, manifest) => {
    root = destination;
    const packages = {};
    for (const [name, row] of selected) {
      const path = join(root, 'node_modules', name);
      mkdirSync(path, { recursive: true });
      execFileSync('tar', ['-xzf', row.path, '-C', path, '--strip-components=1'], { timeout: 5000 });
      packages['node_modules/' + name] = {
        version: row.version,
        integrity: row.integrity,
        resolved: 'file:' + row.path,
      };
    }
    writeFileSync(join(root, 'node_modules/.package-lock.json'), JSON.stringify({ packages }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
    if (fault === 'self-name')
      writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest, name: 'agentfootprint' }));
    verifyInstalled(root, selected, '2.0.0-rc.0');
    return selected;
  };
  const node = (path, args, cwd) => {
    if (basename(path).startsWith('run.')) runCalls++;
    const result = directNode(path, args, cwd);
    if (fault === 'timeout') {
      result.status = null;
      result.signal = 'SIGKILL';
      result.errorCode = 'ETIMEDOUT';
    }
    if (basename(path).startsWith('run.') && fault !== 'output-overflow') {
      expect(existsSync(join(root, 'stop.marker'))).toBe(true);
      expect(existsSync(join(root, 'shutdown.marker'))).toBe(true);
    }
    if (fault === 'outside-entry' && basename(path) === 'preflight.cjs') {
      const report = JSON.parse(result.stdout);
      report.entries.root = join(home, 'source.cjs');
      writeFileSync(report.entries.root, files['dist/root.cjs']);
      result.stdout = JSON.stringify(report);
    }
    if (fault === 'tamper-member' && basename(path) === 'preflight.cjs')
      writeFileSync(join(root, 'node_modules/agentfootprint/dist/providers.cjs'), 'tampered');
    if (fault === 'tamper-trace' && basename(path) === 'preflight.cjs')
      writeFileSync(join(root, 'node_modules/foottrace/dist/index.js'), 'module.exports="wrong-image";');
    if (fault === 'tamper-lock' && basename(path) === 'preflight.cjs')
      writeFileSync(join(root, 'package-lock.json'), 'changed');
    if (fault === 'tamper-specimen' && basename(path) === 'preflight.cjs')
      writeFileSync(join(root, 'specimens/run.mjs'), 'changed');
    if (fault === 'extra-json' && basename(path) === 'preflight.cjs') result.stdout += '{}';
    if (fault === 'duplicate-json-key' && basename(path) === 'preflight.cjs')
      result.stdout = result.stdout.replace('"format":"cjs"', '"format":"esm","format":"cjs"');
    if (fault === 'unknown-output' && basename(path) === 'run.cjs') {
      const report = JSON.parse(result.stdout);
      report.extra = 'unowned';
      result.stdout = JSON.stringify(report);
    }
    return result;
  };
  return { home, folder, selected, installPaired, node, getRoot: () => root, getRuns: () => runCalls };
}

it('runs all four REAL fresh Node processes in a neutral tiny installed graph and joins their receipts', async () => {
  const f = fixture();
  try {
    const result = await provePublicVersions(
      { selected: f.selected, family: [], folder: f.folder },
      { installPaired: f.installPaired, directNode: f.node },
    );
    expect(
      result.reports.map((r) => [r.format, r.producer.agentfootprintVersion, r.producer.footprintjsVersion]),
    ).toEqual([
      ['cjs', '15.0.0-rc.0', '13.0.0-rc.0'],
      ['esm', '15.0.0-rc.0', '13.0.0-rc.0'],
    ]);
    expect(result.processes.map((r) => r.script)).toEqual([...specimenFiles().keys()]);
    expect(result.processes.every((r) => r.status === 0)).toBe(true);
    expect(f.getRuns()).toBe(2);
    expect(existsSync(f.getRoot())).toBe(false);
    expect(JSON.parse(readFileSync(join(f.folder, 'af-public-version-processes.json')))).toHaveLength(4);
    for (const change of [
      { processes: [] },
      { processes: result.processes.map((r, i) => (i === 1 ? { ...r, stdout: '{}' } : r)) },
      { afIntegrity: 'wrong' },
      { reports: result.reports.toReversed() },
      { processes: result.processes.map((r, i) => (i ? r : { ...r, scriptSHA256: 'wrong' })) },
    ])
      expect(() => requireProofReceipt({ ...result, ...change }, f.selected)).toThrow();
  } finally {
    rmSync(f.home, { recursive: true, force: true });
  }
}, 15000);
const failures = {
  'self-name': 'neutral package scope',
  'outside-entry': 'outside the admitted archive',
  'tamper-member': 'file bytes differ',
  'tamper-lock': 'setup changed',
  'tamper-specimen': 'specimen changed',
  'extra-json': 'not one JSON object',
  'duplicate-json-key': 'not one JSON object',
  'unknown-output': 'result differs',
  'stale-version': 'process failed',
  'null-structure': 'process failed',
  'null-snapshot': 'process failed',
  timeout: 'process failed',
  'output-overflow': 'process failed',
};
for (const fault of [
  'self-name',
  'outside-entry',
  'tamper-member',
  'tamper-trace',
  'tamper-lock',
  'tamper-specimen',
  'extra-json',
  'duplicate-json-key',
  'unknown-output',
  'stale-version',
  'null-structure',
  'null-snapshot',
  'timeout',
  'output-overflow',
])
  it(
    'refuses ' + fault + ' and removes only its disposable install root',
    async () => {
      const f = fixture(fault);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        let caught;
        try {
          await provePublicVersions(
            { selected: f.selected, family: [], folder: f.folder },
            { installPaired: f.installPaired, directNode: f.node },
          );
        } catch (rejection) {
          caught = rejection;
        }
        expect(existsSync(f.getRoot())).toBe(false);
        expect(existsSync(f.home)).toBe(true);
        if (
          [
            'self-name',
            'outside-entry',
            'tamper-member',
            'tamper-trace',
            'tamper-lock',
            'tamper-specimen',
            'extra-json',
            'duplicate-json-key',
            'timeout',
          ].includes(fault)
        )
          expect(f.getRuns()).toBe(0);
        expect(caught).toBeInstanceOf(Error);
        expect(caught.message).toContain(fault === 'tamper-trace' ? 'file bytes differ' : failures[fault]);
        expect(existsSync(join(f.folder, 'af-public-version-processes.json'))).toBe(true);
      } finally {
        error.mockRestore();
        rmSync(f.home, { recursive: true, force: true });
      }
    },
    15000,
  );
it('the fixed direct Node port bounds processes and strips options/credential-bearing environment', () => {
  vi.stubEnv('NODE_PATH', 'fixture-bad-path');
  vi.stubEnv('NODE_OPTIONS', '--fixture-option');
  vi.stubEnv('GH_TOKEN', 'fixture-credential');
  try {
    let observed;
    const result = directNode('/fixture/script.mjs', ['argument'], process.cwd(), (command, args, options) => {
      observed = { command, args, options };
      return { status: null, signal: 'SIGKILL', error: { code: 'ETIMEDOUT' }, stdout: '', stderr: 'timeout fixture' };
    });
    expect(observed.command).toBe(process.execPath);
    expect(observed.args).toEqual(['/fixture/script.mjs', 'argument']);
    expect(observed.options.timeout).toBe(30000);
    expect(observed.options.maxBuffer).toBe(1024 * 1024);
    expect(observed.options.killSignal).toBe('SIGKILL');
    for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'GH_TOKEN', 'ORCHESTRATOR_TOKEN'])
      expect(observed.options.env).not.toHaveProperty(name);
    expect(result.errorCode).toBe('ETIMEDOUT');
    expect(result.status).toBe(null);
  } finally {
    vi.unstubAllEnvs();
  }
});
