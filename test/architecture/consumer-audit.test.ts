/** Exercise orchestration separately from the real-npm materialization regressions. */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { aptFailure, aptInstall, audit, clone, latest, main, parseArgs } from '../../scripts/audit-consumers.mjs';
import { auditInstallManifest, planAuditInstall } from '../../scripts/consumer-install.mjs';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'consumer-audit-test-'));
  roots.push(root);
  return root;
};
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const entry = {
  package: 'app',
  repo: 'test/app',
  branch: 'main',
  dir: 'app',
  checks: ['npm test'],
  installStrategy: 'packaged',
};
const context = { candidate: '/candidate.tgz', candidateVersion: '10.0.0', published: '9.48.3', record: new Set() };
const original = {
  name: 'app',
  private: true,
  dependencies: { footprintjs: 'file:../footPrint' },
  peerDependencies: { footprintjs: '^9 || ^10' },
};
const imports = { lines: 0, record: [], other: [], unresolved: false };
const steps = (install = true, check = true) => [
  { key: 'install footprintjs', ok: install, seconds: 1 },
  { key: 'npm test', ok: check, seconds: 1, ...(!install ? { skipped: true } : {}) },
];
function services() {
  return {
    clone: vi.fn((_entry, dir) => {
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify(original));
      return null;
    }),
    run: vi.fn(() => ({ ok: true, seconds: 1 })),
    read: vi.fn(() => 'abcd123'),
    latest: vi.fn(() => '10.0.0'),
    advancedImports: vi.fn(() => imports),
    leg: vi.fn(() => steps()),
  };
}

describe('consumer audit orchestration', () => {
  describe.each([
    {
      name: 'agentfootprint-lens',
      engineSection: 'devDependencies',
      authored: {
        name: 'agentfootprint-lens',
        version: '0.76.0',
        peerDependencies: {
          agentfootprint: '^9.116.0 || ^10.0.0',
          footprintjs: '^9.26.0 || ^10.0.0',
          foottrace: '^1.0.0',
          react: '^18.0.0 || ^19.0.0',
        },
        devDependencies: { agentfootprint: '9.142.0', footprintjs: '^9.28.0', foottrace: '1.0.0' },
      },
    },
    {
      name: 'vizfootprint',
      engineSection: 'dependencies',
      authored: {
        name: 'vizfootprint',
        version: '0.1.0',
        private: true,
        peerDependencies: { agentfootprint: '>=9.0.0' },
        peerDependenciesMeta: { agentfootprint: { optional: true } },
        dependencies: { footprintjs: '^9.11.0 || ^10.0.0', foottrace: '^1.0.0' },
        devDependencies: { agentfootprint: '^9.82.0' },
      },
    },
  ])('$name configured compatibility pair', ({ name, engineSection, authored: manifest }) => {
    it.each([true, false])('uses the common override and original peer preflight (accepts 10: %s)', (accepts10) => {
      const { family } = JSON.parse(readFileSync(resolve('scripts/family.json'), 'utf8'));
      const consumer = family.find((value) => value.package === name);
      expect(consumer.registry).toEqual(['agentfootprint']);
      const authored = structuredClone(manifest);
      if (!accepts10) authored.peerDependencies.agentfootprint = '^9.116.0';
      const io = services();
      io.clone.mockImplementation((_entry, dir) => {
        mkdirSync(dir);
        writeFileSync(join(dir, 'package.json'), JSON.stringify(authored));
        return null;
      });
      io.leg.mockImplementation((spec, dirs, pins, _checks, notes, _installed, originals) => {
        expect(pins).toEqual(['agentfootprint@10.0.0']);
        expect(originals.get(dirs[0])).toEqual(authored);
        const plans = planAuditInstall(dirs, spec, pins, notes, originals);
        if (accepts10) {
          expect(plans).toHaveLength(1);
          expect([...plans[0].replacements]).toEqual([
            ['footprintjs', '10.0.0'],
            ['agentfootprint', '10.0.0'],
          ]);
          const planned = auditInstallManifest(authored, plans[0].replacements);
          expect(planned).toEqual({
            ...authored,
            devDependencies: { ...authored.devDependencies, agentfootprint: '10.0.0' },
            [engineSection]: {
              ...authored[engineSection],
              ...(engineSection === 'devDependencies' ? { agentfootprint: '10.0.0' } : {}),
              footprintjs: '10.0.0',
            },
          });
        } else {
          expect(plans).toBeNull();
          expect([...notes].join('\n')).toContain('agentfootprint@10.0.0: incompatible with original peer requirement');
        }
        expect(JSON.parse(readFileSync(join(dirs[0], 'package.json'), 'utf8'))).toEqual(authored);
        return steps(accepts10, accepts10);
      });
      const actual = audit(consumer, temp(), { ...context, candidate: 'footprintjs@10.0.0' }, {}, io);
      expect(io.latest).toHaveBeenCalledWith('agentfootprint');
      expect(actual.verdict).toBe(accepts10 ? 'pass' : 'no verdict');
    });
  });

  it('captures authored manifests before preparation and skips every initial install for a packaged app', () => {
    const io = services();
    const actual = audit(
      {
        ...entry,
        registry: ['agentfootprint'],
        siblings: [{ repo: 'test/agent', branch: 'main', dir: 'agent', sourceOnly: true }],
      },
      temp(),
      context,
      {},
      io,
    );
    expect(actual.verdict).toBe('pass');
    expect(io.run).not.toHaveBeenCalled();
    expect(io.leg).toHaveBeenCalledTimes(1);
    const args = io.leg.mock.calls[0];
    expect(args[2]).toEqual(['agentfootprint@10.0.0']);
    expect(args[6].get(args[1][0])).toEqual(original);
    expect(args[7]).toMatchObject({ strategy: 'packaged', sourceOnly: [expect.stringMatching(/\/agent$/)] });
    expect(args[5]).toEqual(args[1]);
    expect(actual.notes.join('\n')).toContain('source-only checkout');
    expect(actual.notes.join('\n')).toContain('from npm: agentfootprint@10.0.0');
  });

  // Legs in the order the audit runs them: the candidate, the published footprintjs (unless
  // `fallback: false`), and the candidate again when a step would block (its failure must repeat).
  it.each([
    [[steps(true, false), steps(), steps(true, false)], true, 'BLOCKING'],
    [[steps(true, false), steps(true, false)], true, 'own failure'],
    [[steps(false, false), steps(false, false)], true, 'no verdict'],
    [[steps(true, false), steps(true, false)], false, 'BLOCKING'],
    [[steps(false, false)], false, 'no verdict'],
  ])('judges the installation/test legs without manufacturing a pass', (legs, fallback, verdict) => {
    const io = services();
    for (const leg of legs) io.leg.mockReturnValueOnce(leg);
    const actual = audit({ ...entry, fallback }, temp(), context, {}, io);
    expect(actual.verdict).toBe(verdict);
    expect(actual.published).toEqual(fallback ? legs[1] : null);
    expect(io.leg).toHaveBeenCalledTimes(legs.length);
    if (fallback) {
      expect(io.leg.mock.calls[1][0]).toBe('footprintjs@9.48.3');
      expect(io.leg.mock.calls[1][6]).toBe(io.leg.mock.calls[0][6]);
    }
  });

  it('keeps genuine runtime sibling installation, root ordering and pre-install manifests', () => {
    const io = services();
    io.run.mockImplementation((_command, cwd) => {
      mkdirSync(join(cwd, 'node_modules/footprintjs'), { recursive: true });
      return { ok: true, seconds: 1 };
    });
    const actual = audit(
      {
        ...entry,
        installStrategy: 'linked',
        setup: 'download-browser',
        siblings: [{ dir: 'runtime', setup: 'npm ci' }],
      },
      temp(),
      context,
      {},
      io,
    );
    expect(actual.verdict).toBe('pass');
    expect(io.run.mock.calls.map(([command]) => command)).toEqual(['npm ci', 'npm install --no-audit --no-fund']);
    const args = io.leg.mock.calls[0];
    expect(args[1].map((dir) => dir.split('/').pop())).toEqual(['app', 'runtime']);
    expect(args[5]).toEqual(args[1]);
    expect(args[3]).toEqual(['download-browser', 'npm test']);
    expect(args[6].size).toBe(2);
  });

  it.each([
    [{ installStrategy: 'unknown' }, 'unknown audit install strategy'],
    [{ install: 'true' }, 'cannot override'],
    [{ siblings: [{ dir: 'source', sourceOnly: true, setup: 'npm ci' }] }, 'no sibling setup'],
    [{ siblings: [{ dir: 'runtime', setup: 'npm ci' }] }, 'cannot include runtime-linked'],
    [{ installStrategy: 'linked', siblings: [{ dir: 'source', sourceOnly: true }] }, 'source-only siblings require'],
  ])('refuses contradictory installation declarations: %j', (config, message) => {
    const io = services();
    const actual = audit({ ...entry, ...config }, temp(), context, {}, io);
    expect(actual.verdict).toBe('no verdict');
    expect(actual.notes.join(' ')).toContain(message);
    expect(io.leg).not.toHaveBeenCalled();
  });

  it('reports unavailable tools, failed clones and failed old-strategy installs rather than skipping them', () => {
    for (const problem of ['tool', 'apt', 'clone', 'sibling-clone', 'sibling-install', 'install']) {
      const io = services();
      const config = {
        ...entry,
        installStrategy: 'linked',
        ...(problem.includes('sibling') ? { siblings: [{ dir: 'runtime', setup: 'npm ci' }] } : {}),
      };
      if (problem === 'tool') io.read.mockReturnValue('');
      if (problem === 'apt' || problem.includes('install')) io.run.mockReturnValue({ ok: false, seconds: 1 });
      if (problem === 'clone') io.clone.mockReturnValue('could not clone app');
      if (problem === 'sibling-clone')
        io.clone.mockImplementationOnce(services().clone).mockReturnValue('could not clone sibling');
      const actual = audit(
        { ...config, ...(['tool', 'apt'].includes(problem) ? { apt: ['ffmpeg'] } : {}) },
        temp(),
        context,
        { apt: problem === 'apt' },
        io,
      );
      expect(actual.verdict, problem).toBe('no verdict');
      expect(actual.notes.length, problem).toBeGreaterThan(0);
      expect(io.leg, problem).not.toHaveBeenCalled();
    }
  });
});

// The command is RUN here, in bash, with stand-ins for `sudo`, `timeout` and `apt-get` on PATH: what the
// test sees is what the shell did, not what the string says.
describe('installing a system tool a consumer needs (CI, --apt)', () => {
  /**
   * A folder of stand-in programs. Each call is written to `calls.log`. `apt-get update` ends with
   * `status.update` and `apt-get install` with `status.install`.
   */
  function standIns(status: { update: number; install: number }, present: string[] = []) {
    const bin = temp();
    const log = join(bin, 'calls.log');
    const put = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    put('sudo', `echo "sudo $*" >> "${log}"\nexec "$@"`);
    // The real `timeout` takes options, a duration, then the command. This one notes all three and runs it.
    put(
      'timeout',
      'options=""\nwhile [[ "$1" == --* ]]; do options="$options $1"; shift; done\n' +
        `echo "timeout$options $1 around $2" >> "${log}"\nshift\nexec "$@"`,
    );
    put(
      'apt-get',
      `echo "apt-get $*" >> "${log}"\nfor word in "$@"; do\n` +
        `  [[ "$word" == update ]] && exit ${status.update}\n  [[ "$word" == install ]] && exit ${status.install}\ndone\nexit 99`,
    );
    for (const tool of present) put(tool, 'exit 0');
    const done = (tool: string) => {
      const ran = spawnSync('bash', ['-c', aptInstall(tool)], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        encoding: 'utf8',
        timeout: 15_000,
      });
      return { status: ran.status, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
    };
    return { runIt: done };
  }
  const NOT_INSTALLED = 'no-such-tool-footprint-audit';
  const aptCalls = (calls: string[]) => calls.filter((line) => line.startsWith('apt-get '));
  // These tests start real processes. Like the other process tests of this folder they carry their own
  // time limit: on a busy machine the first start of a new program can take seconds.
  const PROCESS_TEST_MS = 20_000;

  it(
    'a tool that is already on PATH is not installed again: apt-get is never called',
    () => {
      const { runIt } = standIns({ update: 0, install: 0 }, ['faketool']);
      expect(runIt('faketool')).toEqual({ status: 0, calls: [] });
    },
    PROCESS_TEST_MS,
  );

  it(
    'a missing tool: the index is refreshed, then the tool is installed, each call inside a time limit',
    () => {
      const { status, calls } = standIns({ update: 0, install: 0 }).runIt(NOT_INSTALLED);
      expect(status).toBe(0);
      // Two limits, each with a hard kill behind it for a call that ignores the first signal.
      expect(calls.filter((line) => line.startsWith('timeout '))).toEqual([
        'timeout --kill-after=15s 4m around apt-get',
        'timeout --kill-after=15s 6m around apt-get',
      ]);
      const apt = aptCalls(calls);
      expect(apt).toHaveLength(2);
      expect(apt[0]).toMatch(/ update -qq$/);
      expect(apt[1]).toMatch(new RegExp(` install -y -qq ${NOT_INSTALLED}$`));
      // Every download gives up by itself too, and a held package lock is waited for, not for ever.
      for (const call of apt) {
        expect(call).toContain('-o Acquire::Retries=2 ');
        expect(call).toContain('-o Acquire::http::Timeout=20 ');
        expect(call).toContain('-o Acquire::https::Timeout=20 ');
        expect(call).toContain('-o DPkg::Lock::Timeout=60 ');
      }
      // No apt-get call outside a limit: every `sudo` runs a `timeout`.
      const elevated = calls.filter((line) => line.startsWith('sudo '));
      expect(elevated).toHaveLength(2);
      expect(elevated.every((line) => line.startsWith('sudo timeout '))).toBe(true);
    },
    PROCESS_TEST_MS,
  );

  it(
    'a refresh that failed decides nothing: the install is still tried, and its success is the answer',
    () => {
      const { status, calls } = standIns({ update: 100, install: 0 }).runIt(NOT_INSTALLED);
      expect(status).toBe(0);
      expect(aptCalls(calls)).toHaveLength(2);
    },
    PROCESS_TEST_MS,
  );

  it(
    'an install that failed is the command failing, with the status apt-get or the limit gave',
    () => {
      expect(standIns({ update: 0, install: 100 }).runIt(NOT_INSTALLED).status).toBe(100);
      expect(standIns({ update: 100, install: 100 }).runIt(NOT_INSTALLED).status).toBe(100);
      // What `timeout` hands back for a call that ran past its limit (124), or that it had to kill (137).
      expect(standIns({ update: 0, install: 124 }).runIt(NOT_INSTALLED).status).toBe(124);
      expect(standIns({ update: 0, install: 137 }).runIt(NOT_INSTALLED).status).toBe(137);
    },
    PROCESS_TEST_MS,
  );

  it('the audit says which tool could not be installed and why, and checks nothing', () => {
    const notes = (status: number | null | undefined) => {
      const io = services();
      io.run.mockReturnValue({ ok: false, seconds: 600, status } as never);
      const actual = audit({ ...entry, apt: ['ffmpeg'] }, temp(), context, { apt: true }, io);
      expect(io.run).toHaveBeenCalledTimes(1);
      expect(io.run.mock.calls[0][0]).toBe(aptInstall('ffmpeg'));
      expect(actual.verdict).toBe('no verdict');
      expect(io.clone).not.toHaveBeenCalled();
      expect(io.leg).not.toHaveBeenCalled();
      return actual.notes;
    };
    const late =
      'could not install ffmpeg: it did not finish within its time limit (a mirror or a name server may be down); see the log. Not checked';
    expect(notes(124)).toEqual([late]);
    expect(notes(137)).toEqual([late]);
    // A quick failure is apt-get's own, and is not called a time limit.
    expect(notes(100)).toEqual(['could not install ffmpeg: apt-get failed with status 100; see the log. Not checked']);
    expect(notes(null)).toEqual(['could not install ffmpeg: apt-get failed; see the log. Not checked']);
    expect(notes(undefined)).toEqual(['could not install ffmpeg: apt-get failed; see the log. Not checked']);
    expect(aptFailure('ffmpeg', 124)).toBe(late);
  });
});

describe('audit CLI and reporting boundary', () => {
  it('resolves each registry pin once so both audit legs use the same published version', () => {
    const readVersion = vi.fn(() => '9.48.3');
    expect(latest('@audit/stable-pin', readVersion)).toBe('9.48.3');
    readVersion.mockReturnValue('10.0.0');
    expect(latest('@audit/stable-pin', readVersion)).toBe('9.48.3');
    expect(readVersion).toHaveBeenCalledOnce();
    expect(readVersion).toHaveBeenCalledWith('npm', ['view', '@audit/stable-pin@latest', 'version']);
    expect(latest('@audit/different-pin', readVersion)).toBe('10.0.0');
  });

  it.each(['pack', 'metadata', 'registry', 'audit', 'report'])(
    'cleans the default workspace after a thrown %s error',
    (failure) => {
      let workspace: string | undefined;
      const throws = () => {
        throw new Error(`failed ${failure}`);
      };
      const io = {
        run: () => ({ ok: true }),
        read: (command: string, args: string[]) => {
          if (command === 'npm') {
            workspace = args[2];
            roots.push(workspace);
          }
          if ((command === 'npm' && failure === 'pack') || (command === 'tar' && failure === 'metadata')) throws();
          return command === 'npm' ? 'candidate.tgz' : '{"version":"10.0.0"}';
        },
        latest: () => (failure === 'registry' ? throws() : '9.48.3'),
        recordSymbolsAt: () => new Set(),
        audit: (selected) => (failure === 'audit' ? throws() : { entry: selected, verdict: 'pass', seconds: 0 }),
        report: () => {
          if (failure === 'report') throws();
        },
      };
      expect(() => main(['--only', 'hcifootprint'], io)).toThrow(`failed ${failure}`);
      expect(workspace).toBeDefined();
      expect(workspace && existsSync(workspace)).toBe(false);
    },
  );

  it('parses bounded CLI choices and rejects missing values and unknown flags', () => {
    expect(
      parseArgs(['--local', '--apt', '--keep', '--only', 'app,lens', '--candidate', 'packed.tgz', '--org', 'siblings']),
    ).toMatchObject({
      local: true,
      apt: true,
      keep: true,
      only: ['app', 'lens'],
      candidate: resolve('packed.tgz'),
      org: resolve('siblings'),
    });
    expect(() => parseArgs(['--other'])).toThrow('unknown argument');
    for (const flag of ['--only', '--candidate', '--org']) {
      expect(() => parseArgs([flag])).toThrow('missing value');
      expect(() => parseArgs([flag, '--keep'])).toThrow('missing value');
    }
  });

  it('clones remote and local inputs with explicit failure and stale-origin evidence', () => {
    const root = temp();
    const opts = { local: false, org: root };
    const io = { run: vi.fn(() => ({ ok: true })), read: vi.fn(() => 'abc') };
    expect(clone(entry, join(root, 'destination'), opts, io)).toBeNull();
    io.run.mockReturnValueOnce({ ok: false });
    expect(clone(entry, join(root, 'destination'), opts, io)).toContain('could not clone');
    opts.local = true;
    expect(clone(entry, join(root, 'destination'), opts, io)).toContain('no checkout');
    mkdirSync(join(root, 'app/.git'), { recursive: true });
    io.run.mockReturnValueOnce({ ok: false });
    expect(clone(entry, join(root, 'destination'), opts, io)).toContain('could not clone');
    expect(clone(entry, join(root, 'destination'), opts, io)).toBeNull();
    io.read.mockImplementationOnce(() => {
      throw new Error('origin unavailable');
    });
    expect(clone(entry, join(root, 'destination'), opts, io)).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('? commit(s) behind'));
  });

  it.each([
    {
      mode: 'local',
      githubActions: undefined,
      annotations: [
        '  ERROR: red only on the candidate: npm test',
        '  ERROR: red on the candidate (fallback: false — no published leg): npm test',
        '  WARNING: red on the published footprintjs 9.48.3 too, so not blocking: npm test',
        '  ERROR: could not be audited: original peer unchanged',
        '  ERROR: could not be audited: clone failed',
      ],
    },
    {
      mode: 'GitHub Actions',
      githubActions: 'true',
      annotations: [
        '::error title=app: BLOCKING::red only on the candidate: npm test',
        '::error title=app: BLOCKING::red on the candidate (fallback: false — no published leg): npm test',
        '::warning title=app: own failure::red on the published footprintjs 9.48.3 too, so not blocking: npm test',
        '::error title=app: no verdict::could not be audited: original peer unchanged',
        '::error title=app: no verdict::could not be audited: clone failed',
      ],
    },
  ])('formats every verdict in $mode logs and the job summary', async ({ githubActions, annotations }) => {
    // The CLI captures its mode at import time; each case must own that environment and module instance.
    vi.stubEnv('GITHUB_ACTIONS', githubActions);
    vi.resetModules();
    const { report } = await import('../../scripts/audit-consumers.mjs');
    const summary = join(temp(), 'summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summary);
    for (const [verdict, candidate, published] of [
      ['pass', steps(), null],
      ['BLOCKING', steps(true, false), steps()],
      ['BLOCKING', steps(true, false), null],
      ['own failure', steps(true, false), steps(true, false)],
      ['no verdict', steps(false, false), steps(false, false)],
    ])
      report(
        {
          entry,
          verdict,
          candidate,
          published,
          sha: 'abc',
          seconds: 2,
          notes: ['original peer unchanged'],
          advanced: { lines: 2, record: ['replay'], other: ['StageContext'], unresolved: true },
        },
        context,
      );
    report(
      { entry, verdict: 'no verdict', candidate: [], published: null, sha: '?', seconds: 0, notes: ['clone failed'] },
      context,
    );
    report(
      {
        entry,
        verdict: 'pass',
        candidate: steps(),
        published: null,
        sha: 'abc',
        seconds: 0,
        notes: [],
        advanced: imports,
      },
      context,
    );
    const text = readFileSync(summary, 'utf8');
    expect(text).toContain('not run');
    expect(text).toContain('namespace/dynamic/mock access needs review');
    expect(text).toContain('original peer unchanged');
    expect(text).toContain('record symbols 1 (replay); others 1 (StageContext)');
    const emittedAnnotations = vi
      .mocked(console.log)
      .mock.calls.map(([line]) => line)
      .filter((line) => /^(?: {2}(?:WARNING|ERROR):|::(?:warning|error) )/.test(line));
    expect(emittedAnnotations).toEqual(annotations);
  });

  it('runs the real top-level selection, candidate packing, cleanup and exit verdict logic', () => {
    const io = {
      run: vi.fn(() => ({ ok: true })),
      read: vi.fn((command) => (command === 'tar' ? '{"version":"10.0.0"}' : 'candidate.tgz')),
      latest: vi.fn(() => '9.48.3'),
      recordSymbolsAt: vi.fn(() => new Set()),
      audit: vi.fn((selected) => ({
        entry: selected,
        verdict: 'pass',
        seconds: 0,
        candidate: [],
        published: null,
        notes: [],
      })),
      report: vi.fn(),
    };
    const successful = main(['--only', 'hcifootprint'], io);
    expect(successful.exitCode).toBe(0);
    expect(existsSync(successful.workspace)).toBe(false);
    expect(io.run).toHaveBeenCalled();
    expect(io.report).toHaveBeenCalledOnce();
    io.audit.mockImplementation((selected) => ({
      entry: selected,
      verdict: 'no verdict',
      seconds: 0,
      candidate: [],
      published: null,
      notes: [],
    }));
    const blocked = main(['--only', 'agentfootprint-lens', '--candidate', '/candidate.tgz', '--keep', '--local'], io);
    roots.push(blocked.workspace);
    expect(blocked.exitCode).toBe(1);
    expect(existsSync(blocked.workspace)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('A local checkout can be stale'));
    expect(() => main(['--only', 'unknown'], io)).toThrow('does not audit');
    io.run.mockReturnValue({ ok: false });
    expect(() => main(['--only', 'hcifootprint'], io)).toThrow('candidate does not build');
  });
});
