/**
 * A consumer's suite in shards (scripts/consumer-shards.mjs): the plan read from `scripts/family.json`, the
 * one commit every shard audits, the narrowed check, and the audit's `--shard`/`--commit` flags, through the
 * functions and through the real script as a shard job runs it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main as audit, parseArgs } from '../../scripts/audit-consumers.mjs';
import {
  consumerJobs,
  main,
  narrowAudit,
  parseCommit,
  parseShard,
  pinShards,
  remoteHead,
  shardCommand,
  shardsOf,
} from '../../scripts/consumer-shards.mjs';
import { isolatedGitEnv } from '../../scripts/git-env.mjs';

type Entry = Record<string, unknown> & { package: string; checks?: string[] };
const family = (): Entry[] => JSON.parse(readFileSync(resolve('scripts/family.json'), 'utf8')).family;
const entryOf = (name: string): Entry => {
  const entry = family().find((one) => one.package === name);
  if (!entry) throw new Error(`no ${name} in scripts/family.json`);
  return entry;
};
const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

const roots: string[] = [];
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe('the shard plan in scripts/family.json', () => {
  it('splits agentfootprint, and only agentfootprint, four ways on its suite', () => {
    expect(shardsOf(entryOf('agentfootprint'))).toEqual({ check: 'npm test', count: 4 });
    for (const entry of family().filter((one) => one.package !== 'agentfootprint')) expect(shardsOf(entry)).toBeNull();
  });

  it('plans one job per unsharded consumer, one per shard, and one aggregate per sharded consumer', () => {
    const audited = family()
      .filter((entry) => entry.checks)
      .map((entry) => entry.package);
    const jobs = consumerJobs(family());
    expect(jobs.sharded).toEqual(['agentfootprint']);
    expect(jobs.consumers).toEqual(audited.filter((name) => name !== 'agentfootprint'));
    expect(jobs.shards).toEqual([1, 2, 3, 4].map((i) => ({ consumer: 'agentfootprint', shard: `${i}/4` })));
  });

  it.each([
    ['not an object', 4, 'must be {'],
    ['an extra key', { check: 'npm test', count: 4, retry: 1 }, 'must be {'],
    ['a missing count', { check: 'npm test' }, 'must be {'],
    ['one shard', { check: 'npm test', count: 1 }, 'count must be a whole number from 2 to 16'],
    ['too many', { check: 'npm test', count: 17 }, 'count must be a whole number from 2 to 16'],
    ['a fraction', { check: 'npm test', count: 2.5 }, 'count must be a whole number'],
    ['a string count', { check: 'npm test', count: '4' }, 'count must be a whole number'],
    ['a check it does not run', { check: 'npm run other', count: 2 }, 'check must be one of its checks'],
    ['a check with its own arguments', { check: 'npm test -- --run', count: 2 }, 'check must be `npm test`'],
  ])('refuses %s', (_name, shards, message) => {
    const entry = { package: 'app', checks: ['npm run build', 'npm test', 'npm test -- --run'], shards };
    expect(() => shardsOf(entry)).toThrow(message);
  });

  it('refuses a consumer with siblings: only its own checkout is pinned to one commit', () => {
    const entry = { package: 'app', checks: ['npm test'], shards: { check: 'npm test', count: 2 }, siblings: [{}] };
    expect(() => shardsOf(entry)).toThrow('a consumer with siblings cannot be sharded');
    expect(() => consumerJobs([entry])).toThrow('cannot be sharded');
  });

  it('gives a second sharded consumer its own rows, and a count its own number of rows', () => {
    const changed = family().map((entry) =>
      entry.package === 'hcifootprint' ? { ...entry, shards: { check: 'npm test', count: 3 } } : entry,
    );
    const jobs = consumerJobs(changed);
    expect(jobs.sharded).toEqual(['hcifootprint', 'agentfootprint']);
    expect(jobs.consumers).not.toContain('hcifootprint');
    expect(jobs.shards.filter((row) => row.consumer === 'hcifootprint').map((row) => row.shard)).toEqual([
      '1/3',
      '2/3',
      '3/3',
    ]);
    expect(jobs.shards.filter((row) => row.consumer === 'agentfootprint')).toHaveLength(4);
  });
});

describe('one commit for every shard', () => {
  it('reads each sharded consumer once and gives every one of its rows that commit', () => {
    const headOf = vi.fn((entry: Entry) => (entry.package === 'agentfootprint' ? SHA : OTHER));
    const changed = family().map((entry) =>
      entry.package === 'hcifootprint' ? { ...entry, shards: { check: 'npm test', count: 2 } } : entry,
    );
    const pinned = pinShards(consumerJobs(changed), changed, headOf);
    expect(headOf).toHaveBeenCalledTimes(2);
    expect(pinned.shards.map((row) => [row.consumer, row.commit])).toEqual([
      ['hcifootprint', OTHER],
      ['hcifootprint', OTHER],
      ...[1, 2, 3, 4].map(() => ['agentfootprint', SHA]),
    ]);
    expect(() => pinShards(consumerJobs(changed), changed, () => 'main')).toThrow('not a full commit SHA');
  });

  it("reads the branch's commit from one exact ls-remote line, and refuses anything else", () => {
    const entry = { repo: 'footprintjs/app', branch: 'main' };
    const reader = vi.fn(() => `${SHA}\trefs/heads/main`);
    expect(remoteHead(entry, reader)).toBe(SHA);
    expect(reader).toHaveBeenCalledWith('git', [
      'ls-remote',
      '--exit-code',
      'https://github.com/footprintjs/app.git',
      'refs/heads/main',
    ]);
    for (const out of [
      '',
      `${SHA}\trefs/heads/main\n${OTHER}\trefs/heads/main`,
      `${SHA}\trefs/heads/other`,
      `${SHA.slice(0, 12)}\trefs/heads/main`,
      `${SHA.toUpperCase()}\trefs/heads/main`,
    ])
      expect(() => remoteHead(entry, () => out)).toThrow('could not read footprintjs/app refs/heads/main');
  });

  it('writes the pinned plan as one GITHUB_OUTPUT line per key', () => {
    const lines = main({ headOf: () => SHA }).split('\n');
    expect(lines.pop()).toBe('');
    expect(lines.map((line) => line.split('=')[0])).toEqual(['consumers', 'shards', 'sharded']);
    const shards = JSON.parse(lines[1].slice('shards='.length));
    expect(shards).toHaveLength(4);
    expect(new Set(shards.map((row: { commit: string }) => row.commit))).toEqual(new Set([SHA]));
  });
});

describe('the audit narrowed to one shard', () => {
  it('parses i/N and full commit SHAs, and refuses everything else', () => {
    expect(parseShard('1/4')).toEqual({ index: 1, count: 4 });
    expect(parseShard('16/16')).toEqual({ index: 16, count: 16 });
    for (const bad of ['0/4', '5/4', '1/1', '1/17', '01/4', '1/4x', '-1/4', '1', '', '1/4/2'])
      expect(() => parseShard(bad), bad).toThrow('--shard is not i/N');
    expect(parseCommit(SHA)).toBe(SHA);
    for (const bad of ['main', SHA.slice(0, 39), `${SHA}0`, SHA.toUpperCase()])
      expect(() => parseCommit(bad), bad).toThrow('--commit is not a full commit SHA');
  });

  it('replaces only the sharded check, keeps the order, and carries the commit', () => {
    const entry = entryOf('agentfootprint');
    const [narrowed] = narrowAudit([entry], { shard: { index: 2, count: 4 }, commit: SHA });
    expect(narrowed).toEqual({
      ...entry,
      commit: SHA,
      checks: ['npx tsc --noEmit', 'npm run test:types', 'npm run build', 'npm test -- --shard=2/4'],
    });
    expect(shardCommand('npm run test:unit', { index: 3, count: 8 })).toBe('npm run test:unit -- --shard=3/8');
  });

  it('changes nothing without the flags, pins the checkout with --commit alone, and refuses a malformed request', () => {
    const entries = [entryOf('hcifootprint'), entryOf('agentfootprint')];
    expect(narrowAudit(entries, {})).toBe(entries);
    expect(narrowAudit([entries[0]], { commit: SHA })).toEqual([{ ...entries[0], commit: SHA }]);
    const shard = { index: 1, count: 4 };
    expect(() => narrowAudit(entries, { shard, commit: SHA })).toThrow('audit one consumer');
    expect(() => narrowAudit([entries[0]], { shard, commit: SHA })).toThrow('declares no shards');
    expect(() => narrowAudit([entries[1]], { shard: { index: 1, count: 3 }, commit: SHA })).toThrow(
      'declares 4 shards',
    );
    expect(() => narrowAudit([entries[1]], { shard })).toThrow('--shard needs --commit');
  });

  it('takes --shard and --commit on the command line, and refuses missing or malformed values', () => {
    expect(parseArgs(['--only', 'agentfootprint', '--shard', '3/4', '--commit', SHA])).toMatchObject({
      only: ['agentfootprint'],
      shard: { index: 3, count: 4 },
      commit: SHA,
    });
    expect(parseArgs([])).toMatchObject({ shard: null, commit: null });
    for (const flag of ['--shard', '--commit']) {
      expect(() => parseArgs([flag])).toThrow('missing value');
      expect(() => parseArgs([flag, '--keep'])).toThrow('missing value');
    }
    expect(() => parseArgs(['--shard', '4/3'])).toThrow('--shard is not i/N');
    expect(() => parseArgs(['--commit', 'HEAD'])).toThrow('not a full commit SHA');
  });

  it('hands the audit the narrowed entry, and refuses before making a workspace', () => {
    const io = {
      run: vi.fn(() => ({ ok: true })),
      read: vi.fn((command: string) => (command === 'tar' ? '{"version":"10.0.0"}' : 'candidate.tgz')),
      latest: vi.fn(() => '9.48.3'),
      recordSymbolsAt: vi.fn(() => new Set()),
      audit: vi.fn((entry: Entry) => ({
        entry,
        verdict: 'pass',
        seconds: 0,
        candidate: [],
        published: null,
        notes: [],
      })),
      report: vi.fn(),
    };
    const args = ['--only', 'agentfootprint', '--candidate', '/candidate.tgz', '--shard', '4/4', '--commit', SHA];
    expect(audit(args, io).exitCode).toBe(0);
    expect(io.audit).toHaveBeenCalledOnce();
    expect(io.audit.mock.calls[0][0]).toMatchObject({
      commit: SHA,
      checks: expect.arrayContaining(['npm test -- --shard=4/4']),
    });
    for (const [bad, message] of [
      [['--shard', '1/4', '--commit', SHA], 'audit one consumer'],
      [['--only', 'agentfootprint', '--shard', '1/4'], '--shard needs --commit'],
      [['--only', 'hcifootprint', '--shard', '1/4', '--commit', SHA], 'declares no shards'],
    ] as const) {
      io.read.mockClear();
      expect(() => audit([...bad, '--candidate', '/candidate.tgz'], io)).toThrow(message);
      expect(io.read).not.toHaveBeenCalled();
    }
  });
});

describe('the real script, as a shard job runs it', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=audit', '-c', 'user.email=audit@example.invalid', ...args], {
      cwd,
      env: isolatedGitEnv(),
      encoding: 'utf8',
    }).trim();

  it('audits its shard of the suite at the pinned commit after the branch moved on', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'consumer-shards-process-')));
    roots.push(root);
    const repo = join(root, 'footPrint');
    cpSync(resolve('scripts'), join(repo, 'scripts'), { recursive: true });
    symlinkSync(resolve('node_modules'), join(repo, 'node_modules'));
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'footprintjs', dependencies: { foottrace: '*' } }),
    );
    const entry = { package: 'app', repo: 'test/app', branch: 'main', dir: 'app', install: 'true', fallback: false };
    const shards = { check: 'npm test', count: 3 };
    writeFileSync(
      join(repo, 'scripts/family.json'),
      JSON.stringify({ family: [{ ...entry, checks: ['npm test'], shards }] }),
    );

    // The consumer: its test script records its arguments and which commit's file it read.
    const log = join(root, 'ran.jsonl');
    const app = join(root, 'org', 'app');
    mkdirSync(app, { recursive: true });
    const manifest = {
      name: 'app',
      version: '0.0.0',
      private: true,
      scripts: { test: 'node record.cjs' },
      dependencies: { footprintjs: '^1.0.0' },
    };
    writeFileSync(join(app, 'package.json'), JSON.stringify(manifest));
    writeFileSync(
      join(app, 'package-lock.json'),
      JSON.stringify({ name: 'app', version: '0.0.0', lockfileVersion: 3, requires: true, packages: { '': manifest } }),
    );
    writeFileSync(join(app, '.gitignore'), 'node_modules/\n');
    writeFileSync(
      join(app, 'record.cjs'),
      "const fs = require('fs');\n" +
        `fs.appendFileSync(${JSON.stringify(
          log,
        )}, JSON.stringify({ args: process.argv.slice(2), file: fs.readFileSync('which.txt', 'utf8') }) + '\\n');\n`,
    );
    writeFileSync(join(app, 'which.txt'), 'pinned');
    git(app, 'init', '-q', '-b', 'main');
    git(app, 'add', '.');
    git(app, 'commit', '-q', '-m', 'pinned');
    const pinned = git(app, 'rev-parse', 'HEAD');
    writeFileSync(join(app, 'which.txt'), 'moved on');
    git(app, 'commit', '-q', '-am', 'moved on');

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? root,
      TMPDIR: tmpdir(),
      npm_config_cache: join(root, 'npm-cache'),
      npm_config_update_notifier: 'false',
      npm_config_offline: 'true',
    };
    const pkg = join(root, 'pkg');
    mkdirSync(pkg);
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: 'footprintjs', version: '1.0.1', main: 'index.js' }),
    );
    writeFileSync(join(pkg, 'index.js'), 'module.exports = {};\n');
    execFileSync('npm', ['pack', '--pack-destination', root], { cwd: pkg, env, stdio: 'ignore' });
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const realNpm = execFileSync('bash', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'npm'),
      `#!/bin/bash\n[[ "$1" == view ]] && { echo 1.0.0; exit 0; }\nexec "${realNpm}" "$@"\n`,
      {
        mode: 0o755,
      },
    );

    const child = spawnSync(
      process.execPath,
      [
        join(repo, 'scripts/audit-consumers.mjs'),
        ...['--local', '--org', join(root, 'org'), '--only', 'app', '--shard', '2/3', '--commit', pinned],
        ...['--candidate', join(root, 'footprintjs-1.0.1.tgz'), '--base-version', '1.0.1'],
      ],
      { encoding: 'utf8', timeout: 110_000, env: { ...env, PATH: `${bin}:${env.PATH}`, GITHUB_ACTIONS: 'true' } },
    );
    const output = child.stdout + child.stderr;
    expect(child.status, output).toBe(0);
    expect(output).toMatch(/\napp: pass \(/);
    const commands = child.stdout
      .split('\n')
      .filter((line) => line.startsWith('::group::'))
      .map((line) => line.slice('::group::'.length));
    expect(commands).toContain(`git checkout --quiet --detach '${pinned}'`);
    expect(commands.at(-1)).toBe('npm test -- --shard=2/3');
    const ran = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(ran).toEqual([{ args: ['--shard=2/3'], file: 'pinned' }]);
  }, 120_000);
});
