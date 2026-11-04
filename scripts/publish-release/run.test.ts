import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { expect, it } from 'vitest';

import { minimalChildEnv } from '../../test/helpers/childProcessEnv';

const helperDirectory = resolve('scripts/publish-release');
const workflow = readFileSync(resolve('.github/workflows/publish.yml'), 'utf8');
const publishStep = workflow.split('      - name: Publish to npm\n')[1].split(/\n {6}- /)[0];
const runLine = publishStep.match(/ {8}run: (.+)/)![1];
const publishCommand =
  runLine === '|'
    ? publishStep
        .split('        run: |\n')[1]
        .split('\n')
        .map((row) => row.slice(10))
        .join('\n')
    : runLine;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Member = { name: string; body?: string; type?: string; link?: string };

// Adapted from foottrace's syntheticPackageArchive: portable regular-file USTAR,
// not platform tar output. Malformed members are data only, never extracted.
function archiveBytes(members: Member[]): Buffer {
  const chunks: Buffer[] = [];
  for (const member of members) {
    const bytes = Buffer.from(member.body ?? '');
    const header = Buffer.alloc(512);
    header.write(member.name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(member.type ?? '0', 156);
    header.write(member.link ?? '', 157, 100);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    chunks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

function fixture(version = '11.0.0-rc.1') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fp-rc-route-')));
  const source = join(root, 'source');
  const intake = join(root, 'intake');
  const publishDirectory = join(root, 'publish');
  const bin = join(root, 'bin');
  for (const path of [source, intake, publishDirectory, bin]) mkdirSync(path);
  mkdirSync(join(source, 'scripts'));
  cpSync(helperDirectory, join(source, 'scripts/publish-release'), { recursive: true });
  const log = join(root, 'publish.json');
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env node
const fs = require('node:fs'), crypto = require('node:crypto');
const args = process.argv.slice(2), target = args[1];
const row = { args, cwd: process.cwd(), sha256: target && fs.existsSync(target) && fs.statSync(target).isFile()
  ? crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') : null };
fs.appendFileSync(process.env.PUBLISH_LOG, JSON.stringify(row) + '\\n');
`,
  );
  chmodSync(join(bin, 'npm'), 0o700);
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "$GH_LOG"\n[ "$GH_FAIL" != yes ] || exit 55\nprintf "%s\\n" "$COMPARE_STATUS"\n',
  );
  chmodSync(join(bin, 'gh'), 0o700);
  const sourceManifest = {
    name: 'footprintjs',
    version: version.includes('-rc.') ? '10.7.1' : version,
    description: 'Release fixture',
    files: ['dist'],
    scripts: { prepare: 'echo source metadata only' },
    dependencies: { foottrace: '^1.11.0' },
    sideEffects: false,
  };
  const packedManifest = { ...sourceManifest, version };
  writeFileSync(join(source, 'package.json'), JSON.stringify(sourceManifest));
  writeFileSync(join(source, 'package-lock.json'), 'source lock stays unchanged\n');
  const archive = join(intake, 'package.tgz');
  const pack = (manifest: unknown = packedManifest, extra: Member[] = []) => {
    const bytes = archiveBytes([
      { name: 'package/package.json', body: typeof manifest === 'string' ? manifest : JSON.stringify(manifest) },
      { name: 'package/dist/index.js', body: 'exports.fixture = true;\n' },
      ...extra,
    ]);
    writeFileSync(archive, bytes);
    return bytes;
  };
  pack();
  const env: NodeJS.ProcessEnv = {
    ...minimalChildEnv(process.env),
    PATH: `${bin}:${minimalChildEnv(process.env).PATH}`,
    PUBLISH_LOG: log,
    EXPECTED_VERSION: version,
    RELEASE_TAG: `v${version}`,
    RELEASE_PRERELEASE: String(version.includes('-rc.')),
    TRUSTED_SOURCE: source,
    ARTIFACT_DIRECTORY: intake,
    PUBLISH_DIRECTORY: publishDirectory,
    GITHUB_WORKSPACE: source,
    RUNNER_TEMP: root,
    GITHUB_REPOSITORY: 'fixture/library',
    GITHUB_OUTPUT: join(root, 'output'),
    GH_LOG: join(root, 'gh.log'),
    GH_FAIL: 'no',
    COMPARE_STATUS: 'identical',
  };
  const run = (file: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(file, args, {
      cwd: source,
      env: { ...env, ...extra },
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
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
  env.GITHUB_SHA = head;
  return {
    root,
    source,
    intake,
    archive,
    publishDirectory,
    sourceManifest,
    packedManifest,
    head,
    run,
    git,
    pack,
    command: (operation: string, extra: NodeJS.ProcessEnv = {}) =>
      run('bash', ['scripts/publish-release/run.sh', operation], extra),
    publish: (extra: NodeJS.ProcessEnv = {}) => run('bash', ['-euo', 'pipefail', '-c', publishCommand], extra),
    submissions: (): { args: string[]; cwd: string; sha256: string | null }[] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((row) => JSON.parse(row))
        : [],
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function withFixture(version: string, check: (f: ReturnType<typeof fixture>) => void) {
  const f = fixture(version);
  try {
    check(f);
  } finally {
    f.close();
  }
}

function expectRefusal(f: ReturnType<typeof fixture>, result: ReturnType<typeof spawnSync>) {
  expect(result.status).not.toBe(0);
  expect(String(result.stderr)).toMatch(/ERR_RELEASE_|::error::/);
  expect(f.submissions()).toEqual([]);
}

it.each(['identical', 'ahead'])('admits the event source on main %s without a local tag', (status) => {
  withFixture('11.0.0-rc.1', (f) => {
    const result = f.command('admit', { COMPARE_STATUS: status });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(f.root, 'output'), 'utf8')).toBe(`version=11.0.0-rc.1\nsource=${f.head}\n`);
    expect(readFileSync(join(f.root, 'gh.log'), 'utf8').trim().split('\n')).toEqual([
      'api',
      `repos/fixture/library/compare/${f.head}...main`,
      '--jq',
      '.status',
    ]);
    expect(f.submissions()).toEqual([]);
  });
});

it.each(['behind', 'diverged', 'unknown', ''])('refuses main-containment status %j', (status) => {
  withFixture('11.0.0-rc.1', (f) => {
    expectRefusal(f, f.command('admit', { COMPARE_STATUS: status }));
    expect(existsSync(join(f.root, 'output'))).toBe(false);
  });
});

it.each([
  'v01.0.0-rc.1',
  'v11.0.0-rc.01',
  'v11.0.0-beta.1',
  '11.0.0-rc.1',
  'v11.0.0-rc.',
  'v11.0.0-rc.1+build',
  'v11.0.0-rc.1\nsource=other',
])('refuses noncanonical event tag %j before comparison', (tag) => {
  withFixture('11.0.0-rc.1', (f) => {
    expectRefusal(f, f.command('admit', { RELEASE_TAG: tag }));
    expect(existsSync(join(f.root, 'gh.log'))).toBe(false);
    expect(existsSync(join(f.root, 'output'))).toBe(false);
  });
});

it.each([
  ['v11.0.0-rc.1', 'false'],
  ['v10.7.1', 'true'],
  ['v11.0.0-rc.1', ''],
] as const)('refuses a release flag inconsistent with %s (%j)', (tag, prerelease) => {
  withFixture('11.0.0-rc.1', (f) => {
    expectRefusal(f, f.command('admit', { RELEASE_TAG: tag, RELEASE_PRERELEASE: prerelease }));
    expect(existsSync(join(f.root, 'output'))).toBe(false);
  });
});

it.each([{ GH_FAIL: 'yes' }, { GITHUB_SHA: '0'.repeat(40) }])(
  'refuses unavailable or mismatched source %j',
  (extra) => {
    withFixture('11.0.0-rc.1', (f) => {
      expectRefusal(f, f.command('admit', extra));
      expect(existsSync(join(f.root, 'output'))).toBe(false);
    });
  },
);

it('stable admission and staging preserve the matching source bytes', () => {
  withFixture('10.7.1', (f) => {
    const before = readFileSync(join(f.source, 'package.json'));
    expect(f.command('admit').status).toBe(0);
    expect(f.command('stage').status).toBe(0);
    expect(readFileSync(join(f.source, 'package.json'))).toEqual(before);
    expectRefusal(f, f.command('admit', { RELEASE_TAG: 'v11.0.0' }));
  });
});

it('RC staging changes only the full manifest version, without lock, Git or lifecycle mutation', () => {
  withFixture('11.0.0-rc.1', (f) => {
    const lock = readFileSync(join(f.source, 'package-lock.json'));
    expect(f.command('stage').status).toBe(0);
    expect(JSON.parse(readFileSync(join(f.source, 'package.json'), 'utf8'))).toEqual(f.packedManifest);
    expect(readFileSync(join(f.source, 'package-lock.json'))).toEqual(lock);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.head);
    expect(f.submissions()).toEqual([]);
    expectRefusal(f, f.command('stage', { EXPECTED_VERSION: '11.0.0-rc.01' }));
    expectRefusal(f, f.command('stage', { EXPECTED_VERSION: '11.0.0' }));
  });
});

it('RC staging refuses a differently named source before rewriting it', () => {
  withFixture('11.0.0-rc.1', (f) => {
    const before = JSON.stringify({ ...f.sourceManifest, name: 'other' });
    writeFileSync(join(f.source, 'package.json'), before);
    expectRefusal(f, f.command('stage'));
    expect(readFileSync(join(f.source, 'package.json'), 'utf8')).toBe(before);
  });
});

it.each(['helper', 'workflow'])(
  'the actual %s publishes the identical absolute RC tarball from a clean cwd',
  (entry) => {
    withFixture('11.0.0-rc.1', (f) => {
      const before = readFileSync(f.archive);
      const result = entry === 'helper' ? f.command('publish') : f.publish();
      expect(result.status, result.stderr).toBe(0);
      expect(f.submissions()).toEqual([
        {
          args: ['publish', f.archive, '--ignore-scripts', '--provenance', '--access', 'public', '--tag', 'next'],
          cwd: f.publishDirectory,
          sha256: sha256(before),
        },
      ]);
      expect(isAbsolute(f.submissions()[0].args[1])).toBe(true);
      expect(readFileSync(f.archive)).toEqual(before);
    });
  },
);

it('the actual stable publish body passes no tag and preserves the inspected archive identity', () => {
  withFixture('10.7.1', (f) => {
    const before = readFileSync(f.archive);
    const result = f.publish();
    expect(result.status, result.stderr).toBe(0);
    expect(f.submissions()).toEqual([
      {
        args: ['publish', f.archive, '--ignore-scripts', '--provenance', '--access', 'public'],
        cwd: f.publishDirectory,
        sha256: sha256(before),
      },
    ]);
    expect(f.submissions()[0].args).not.toContain('--tag');
  });
});

it('publish derives the version from the event rather than a forged build output', () => {
  withFixture('11.0.0-rc.1', (f) => {
    const result = f.publish({ EXPECTED_VERSION: '10.7.1', SOURCE_SHA: '0'.repeat(40) });
    expect(result.status, result.stderr).toBe(0);
    expect(f.submissions()[0].args.slice(-2)).toEqual(['--tag', 'next']);
    expect(f.submissions()[0].sha256).toBe(sha256(readFileSync(f.archive)));
  });
});

it.each([
  { RELEASE_TAG: 'v11.0.0-rc.01' },
  { RELEASE_PRERELEASE: 'false' },
  { GITHUB_SHA: '0'.repeat(40) },
  { COMPARE_STATUS: 'diverged' },
  { GH_FAIL: 'yes' },
])('publish independently re-admits source before reading an archive: %j', (extra) => {
  withFixture('11.0.0-rc.1', (f) => {
    writeFileSync(f.archive, 'not an archive');
    const result = f.publish(extra);
    expectRefusal(f, result);
    expect(result.stderr).toMatch(/ERR_RELEASE_/);
    expect(result.stderr).not.toContain('invalid-archive');
  });
});

it.each([
  ['version', { version: '11.0.0-rc.2' }],
  ['name', { name: 'other' }],
  ['tag', { tag: 'latest' }],
  ['publishConfig', { publishConfig: { registry: 'https://registry.invalid' } }],
  ['scripts', { scripts: { prepare: 'echo changed' } }],
  ['dependencies', { dependencies: { other: '1.0.0' } }],
  ['bin', { bin: 'dist/index.js' }],
  ['unknown field', { extraFixtureField: true }],
  ['control field', { ['field\ncontrol-marker']: true }],
  ['number/string', { sideEffects: 'false' }],
] as const)('publish refuses manifest %s changes before npm', (_name, delta) => {
  withFixture('11.0.0-rc.1', (f) => {
    f.pack({ ...f.packedManifest, ...delta });
    const result = f.publish();
    expectRefusal(f, result);
    expect(result.stderr).toContain('::error::');
    expect(result.stderr).not.toContain('field\ncontrol-marker');
  });
});

it('publish compares the full manifest, including fields removed by the artifact', () => {
  withFixture('11.0.0-rc.1', (f) => {
    const { dependencies: _removed, ...changed } = f.packedManifest;
    f.pack(changed);
    expectRefusal(f, f.publish());
  });
});

it.each([
  ['duplicate manifest', { name: 'package/package.json', body: '{"name":"other","version":"99.0.0"}' }],
  ['second root', { name: 'x/package.json', body: '{"name":"other","version":"99.0.0"}' }],
  ['parent traversal', { name: 'package/../outside', body: 'not extracted' }],
  ['symbolic link', { name: 'package/dist/link', type: '2', link: '../../outside' }],
  ['npm config', { name: 'package/.npmrc', body: 'tag=latest\n' }],
  ['gyp normalization', { name: 'package/binding.gyp', body: '{}' }],
  ['start normalization', { name: 'package/server.js', body: 'process.exit(99)' }],
] as const)('publish refuses noncanonical archive %s before npm', (_name, member) => {
  withFixture('11.0.0-rc.1', (f) => {
    f.pack(f.packedManifest, [member]);
    expectRefusal(f, f.publish());
    expect(existsSync(join(f.root, 'outside'))).toBe(false);
  });
});

it.each(['directory', 'symlink', 'extra file', 'extra directory', 'intake npmrc', 'intake symlink'])(
  'publish refuses hostile intake shape %s before npm',
  (shape) => {
    withFixture('11.0.0-rc.1', (f) => {
      if (shape === 'directory') {
        rmSync(f.archive);
        mkdirSync(f.archive);
      } else if (shape === 'symlink') {
        const target = join(f.root, 'outside.tgz');
        writeFileSync(target, readFileSync(f.archive));
        rmSync(f.archive);
        symlinkSync(target, f.archive);
      } else if (shape === 'extra file') writeFileSync(join(f.intake, 'unexpected'), 'untrusted');
      else if (shape === 'extra directory') mkdirSync(join(f.intake, 'scripts'));
      else if (shape === 'intake npmrc') writeFileSync(join(f.intake, '.npmrc'), 'registry=https://registry.invalid\n');
      else {
        const target = join(f.root, 'other-intake');
        mkdirSync(target);
        writeFileSync(join(target, 'package.tgz'), readFileSync(f.archive));
        rmSync(f.intake, { recursive: true });
        symlinkSync(target, f.intake);
      }
      expectRefusal(f, f.publish());
    });
  },
);

it.each(['ARTIFACT_DIRECTORY', 'PUBLISH_DIRECTORY'])('publish requires an absolute %s', (variable) => {
  withFixture('11.0.0-rc.1', (f) => {
    expectRefusal(f, f.publish({ [variable]: 'relative/path' }));
    expectRefusal(f, f.publish({ [variable]: '' }));
  });
});

it('publish refuses a contaminated npm working directory', () => {
  withFixture('11.0.0-rc.1', (f) => {
    writeFileSync(join(f.publishDirectory, '.npmrc'), 'tag=latest\n');
    expectRefusal(f, f.publish());
  });
});
