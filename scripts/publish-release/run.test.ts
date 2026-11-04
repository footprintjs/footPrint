import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

import { minimalChildEnv } from '../../test/helpers/childProcessEnv';

const workflow = readFileSync(resolve('.github/workflows/publish.yml'), 'utf8');
const script = resolve('scripts/publish-release/run.sh');
const publishStep = workflow.split('      - name: Publish to npm\n')[1].split(/\n {6}- /)[0];
const line = publishStep.match(/ {8}run: (.+)/)![1];
const publish =
  line === '|'
    ? publishStep
        .split('        run: |\n')[1]
        .split('\n')
        .map((row) => row.slice(10))
        .join('\n')
    : line;

function fixture(version: string) {
  const root = mkdtempSync(join(tmpdir(), 'fp-rc-route-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'scripts/publish-release'), { recursive: true });
  if (existsSync(script)) copyFileSync(script, join(root, 'scripts/publish-release/run.sh'));
  const log = join(root, 'publish.log');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$PUBLISH_LOG"\n');
  chmodSync(join(bin, 'npm'), 0o700);
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$GH_LOG"\n[ "$GH_FAIL" != yes ] || exit 55\nprintf "%s\\n" "$COMPARE_STATUS"\n',
  );
  chmodSync(join(bin, 'gh'), 0o700);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'footprintjs', version: '10.7.1', untouched: true }),
  );
  writeFileSync(join(root, 'package-lock.json'), 'source lock stays unchanged\n');
  mkdirSync(join(root, 'archive/package'), { recursive: true });
  writeFileSync(join(root, 'archive/package/package.json'), JSON.stringify({ name: 'footprintjs', version }));
  const env = {
    ...minimalChildEnv(process.env),
    PATH: `${bin}:${process.env.PATH}`,
    PUBLISH_LOG: log,
    EXPECTED_VERSION: version,
    GITHUB_REPOSITORY: 'fixture/library',
    GITHUB_OUTPUT: join(root, 'output'),
    GH_LOG: join(root, 'gh.log'),
    GH_FAIL: 'no',
    COMPARE_STATUS: 'identical',
  };
  const run = (file: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(file, args, {
      cwd: root,
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
  const archive = run('tar', ['-czf', 'package.tgz', '-C', 'archive', 'package']);
  expect(archive.status, archive.stderr).toBe(0);
  const git = (...args: string[]) => {
    const result = run('git', [
      '-c',
      'commit.gpgSign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      `core.hooksPath=${bin}`,
      ...args,
    ]);
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git('init', '-q', `--template=${bin}`);
  git('add', 'package.json', 'package-lock.json');
  git('commit', '-qm', 'Fixture source');
  const head = git('rev-parse', 'HEAD');
  return {
    root,
    log,
    run,
    git,
    head,
    command: (operation: string, extra: NodeJS.ProcessEnv = {}) =>
      run('bash', ['scripts/publish-release/run.sh', operation], extra),
    admit: (tag: string, prerelease: boolean, extra: NodeJS.ProcessEnv = {}) =>
      run('bash', ['scripts/publish-release/run.sh', 'admit'], {
        RELEASE_TAG: tag,
        RELEASE_PRERELEASE: String(prerelease),
        GITHUB_SHA: head,
        ...extra,
      }),
    publish: (extra: NodeJS.ProcessEnv = {}) => run('bash', ['-euo', 'pipefail', '-c', publish], extra),
    args: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

it('the actual publish step sends an RC archive only to next', () => {
  const f = fixture('11.0.0-rc.1');
  try {
    const result = f.publish();
    expect(result.status, result.stderr).toBe(0);
    const args = f.args();
    const tag = args.indexOf('--tag');
    expect(tag === -1 ? 'latest' : args[tag + 1]).toBe('next');
    expect(args).toContain('--provenance');
  } finally {
    f.close();
  }
});

it.each(['identical', 'ahead'])('admits an RC only at its real tag/event source and main %s', (status) => {
  const f = fixture('11.0.0-rc.1');
  try {
    f.git('tag', '-a', 'v11.0.0-rc.1', '-m', 'Candidate');
    const result = f.admit('v11.0.0-rc.1', true, { COMPARE_STATUS: status });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.root, 'output'), 'utf8')).toBe(`version=11.0.0-rc.1\nsource=${f.head}\n`);
    expect(readFileSync(join(f.root, 'gh.log'), 'utf8').trim().split('\n')).toEqual([
      'api',
      `repos/fixture/library/compare/${f.head}...main`,
      '--jq',
      '.status',
    ]);
    expect(f.args()).toEqual([]);
  } finally {
    f.close();
  }
});

it.each(['behind', 'diverged', 'unknown', ''])(
  'refuses main-containment status %j without admission output',
  (status) => {
    const f = fixture('11.0.0-rc.1');
    try {
      f.git('tag', 'v11.0.0-rc.1');
      expect(f.admit('v11.0.0-rc.1', true, { COMPARE_STATUS: status }).status).not.toBe(0);
      expect(existsSync(join(f.root, 'output'))).toBe(false);
      expect(f.args()).toEqual([]);
    } finally {
      f.close();
    }
  },
);

it.each([
  'v01.0.0-rc.1',
  'v11.0.0-rc.01',
  'v11.0.0-beta.1',
  '11.0.0-rc.1',
  'v11.0.0-rc.',
  'v11.0.0-rc.1+build',
  'v11.0.0-rc.1\nsource=other',
])('refuses noncanonical tag %j before GitHub comparison', (tag) => {
  const f = fixture('11.0.0-rc.1');
  try {
    if (f.run('git', ['check-ref-format', `refs/tags/${tag}`]).status === 0) f.git('tag', tag);
    expect(f.admit(tag, true).status).not.toBe(0);
    expect(existsSync(join(f.root, 'gh.log'))).toBe(false);
    expect(existsSync(join(f.root, 'output'))).toBe(false);
  } finally {
    f.close();
  }
});

it.each([
  ['v11.0.0-rc.1', false],
  ['v10.7.1', true],
] as const)('refuses a release flag inconsistent with %s', (tag, prerelease) => {
  const f = fixture('11.0.0-rc.1');
  try {
    f.git('tag', tag);
    expect(f.admit(tag, prerelease).status).not.toBe(0);
    expect(existsSync(join(f.root, 'output'))).toBe(false);
  } finally {
    f.close();
  }
});

it('refuses a failed compare read and a mismatched event SHA', () => {
  const f = fixture('11.0.0-rc.1');
  try {
    f.git('tag', 'v11.0.0-rc.1');
    expect(f.admit('v11.0.0-rc.1', true, { GH_FAIL: 'yes' }).status).not.toBe(0);
    expect(f.admit('v11.0.0-rc.1', true, { GITHUB_SHA: '0'.repeat(40) }).status).not.toBe(0);
    expect(existsSync(join(f.root, 'output'))).toBe(false);
  } finally {
    f.close();
  }
});

it('refuses a real tag that points to a different commit', () => {
  const f = fixture('11.0.0-rc.1');
  try {
    f.git('tag', 'v11.0.0-rc.1');
    writeFileSync(join(f.root, 'next'), 'later source');
    f.git('add', 'next');
    f.git('commit', '-qm', 'Later source');
    expect(f.admit('v11.0.0-rc.1', true, { GITHUB_SHA: f.git('rev-parse', 'HEAD') }).status).not.toBe(0);
    expect(existsSync(join(f.root, 'output'))).toBe(false);
  } finally {
    f.close();
  }
});

it('admits a stable version only when it already matches the unchanged source manifest', () => {
  const f = fixture('10.7.1');
  try {
    f.git('tag', 'v10.7.1');
    expect(f.admit('v10.7.1', false).status).toBe(0);
    f.git('tag', 'v11.0.0');
    expect(f.admit('v11.0.0', false).status).not.toBe(0);
  } finally {
    f.close();
  }
});

it('stages only the RC package version, with no lock, Git or lifecycle mutation', () => {
  const f = fixture('11.0.0-rc.1');
  try {
    const lock = readFileSync(join(f.root, 'package-lock.json'), 'utf8');
    expect(f.command('stage').status).toBe(0);
    expect(JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8'))).toEqual({
      name: 'footprintjs',
      version: '11.0.0-rc.1',
      untouched: true,
    });
    expect(readFileSync(join(f.root, 'package-lock.json'), 'utf8')).toBe(lock);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.head);
    expect(f.args()).toEqual([]);
    expect(f.command('stage', { EXPECTED_VERSION: '11.0.0-rc.01' }).status).not.toBe(0);
    expect(f.command('stage', { EXPECTED_VERSION: '11.0.0' }).status).not.toBe(0);
  } finally {
    f.close();
  }
});

it('keeps tests/package checks before staging and OIDC solely in the archive-publish job', () => {
  expect(workflow.indexOf('run: npm test')).toBeLessThan(workflow.indexOf('bash scripts/publish-release/run.sh stage'));
  expect(workflow.indexOf('run: npx @arethetypeswrong/cli --pack')).toBeLessThan(
    workflow.indexOf('bash scripts/publish-release/run.sh stage'),
  );
  const publisher = workflow.split('\n  publish:\n')[1];
  expect(workflow.match(/id-token: write/g)).toHaveLength(1);
  expect(publisher).toContain('id-token: write');
  expect(publisher).toMatch(/ref: \$\{\{ needs\.build\.outputs\.source \}\}/);
  expect(publisher).toMatch(/EXPECTED_VERSION: \$\{\{ needs\.build\.outputs\.version \}\}/);
  expect(publisher).not.toMatch(/npm (?:ci|pack)|npm version/);
  expect(workflow).not.toContain('npm version');
});

it('refuses a differently named package inside the real archive before npm', () => {
  const f = fixture('11.0.0-rc.1');
  try {
    writeFileSync(
      join(f.root, 'archive/package/package.json'),
      JSON.stringify({ name: 'other', version: '11.0.0-rc.1' }),
    );
    expect(f.run('tar', ['-czf', 'package.tgz', '-C', 'archive', 'package']).status).toBe(0);
    expect(f.publish().status).not.toBe(0);
    expect(f.args()).toEqual([]);
  } finally {
    f.close();
  }
});

it('the actual publish step refuses an archive that differs from the admitted version before npm', () => {
  const f = fixture('11.0.0-rc.2');
  try {
    const result = f.publish({ EXPECTED_VERSION: '11.0.0-rc.1' });
    expect(result.status).not.toBe(0);
    expect(f.args()).toEqual([]);
  } finally {
    f.close();
  }
});

it('the actual stable publish step preserves the latest channel', () => {
  const f = fixture('11.0.0');
  try {
    const result = f.publish();
    expect(result.status, result.stderr).toBe(0);
    const args = f.args();
    const tag = args.indexOf('--tag');
    expect(tag === -1 ? 'latest' : args[tag + 1]).toBe('latest');
  } finally {
    f.close();
  }
});
