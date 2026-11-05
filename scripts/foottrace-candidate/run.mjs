// Hosted proof driver: resolve once, replay normally, test, restore metadata.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANDIDATE, COHORTS, candidateManifest, requireMetadata } from './plan.mjs';
import { inspectCandidate, sha256, verifyInstalled } from './identity.mjs';
import { observeHiddenLock } from './hidden-lock-fs.mjs';
import { assertHiddenLockConsistent } from './hidden-lock.mjs';

const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const outside = (parent, child) => {
  const delta = relative(parent, child);
  return delta === '..' || delta.startsWith(`..${sep}`) || isAbsolute(delta);
};

/** Logs actual argv/cwd, stdout/stderr and exit separately; every failure throws. */
export function command(program, args, { cwd, log, env, timeout = 60 * 60 * 1000 }) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  writeFileSync(`${log}.stdout`, result.stdout ?? '');
  writeFileSync(`${log}.stderr`, result.stderr ?? '');
  json(`${log}.json`, {
    program,
    args,
    cwd,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
  });
  assert.ok(
    !result.error && result.status === 0 && result.signal === null,
    `${program} failed; retained output: ${log}`,
  );
  return result.stdout;
}

function snapshot(path) {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'regular source metadata required');
  return { bytes: readFileSync(path), mode: stat.mode & 0o777 };
}

function restore(path, original) {
  if (!original) {
    rmSync(path, { force: true });
    return;
  }
  writeFileSync(path, original.bytes);
  chmodSync(path, original.mode);
  assert.deepEqual(readFileSync(path), original.bytes, 'source metadata restoration failed');
  assert.equal(lstatSync(path).mode & 0o777, original.mode);
}

function assertMetadata(path, expected) {
  const actual = snapshot(path);
  assert.equal(actual === undefined, expected === undefined, 'metadata presence changed during proof');
  if (expected) {
    assert.deepEqual(actual.bytes, expected.bytes, 'metadata bytes changed during proof');
    assert.equal(actual.mode, expected.mode, 'metadata mode changed during proof');
  }
}

export async function runSweep(options, ports = {}) {
  const run = ports.command ?? command;
  const inspect = ports.inspectCandidate ?? inspectCandidate;
  const verify = ports.verifyInstalled ?? verifyInstalled;
  assert.ok(Object.hasOwn(COHORTS, options.cohort), 'unknown cohort');
  assert.match(options.consumerCommit, /^[a-f0-9]{40}$/u, 'exact consumer head required');
  assert.ok(['22', '24'].includes(process.versions.node.split('.')[0]), 'Node 22 or 24 required');
  for (const key of ['source', 'work', 'tar']) assert.ok(isAbsolute(options[key]), `absolute ${key} required`);
  const source = realpathSync(options.source),
    work = resolve(options.work),
    resolution = join(dirname(source), `${basename(source)}-foottrace-resolve`);
  assert.ok(outside(source, work) && outside(work, source), 'work and checkout must be disjoint');
  assert.equal(dirname(resolution), dirname(source), 'resolver must share the canonical source parent');
  assert.ok(outside(source, resolution) && outside(resolution, source), 'resolver and source must be disjoint');
  assert.ok(outside(work, resolution) && outside(resolution, work), 'resolver and work must be disjoint');
  assert.equal(
    lstatSync(resolution, { throwIfNoEntry: false }),
    undefined,
    'fresh sibling resolver directory required',
  );
  if (process.env.GITHUB_WORKSPACE)
    assert.ok(outside(realpathSync(process.env.GITHUB_WORKSPACE), work), 'work must be outside GITHUB_WORKSPACE');
  for (let parent = dirname(source); ; parent = dirname(parent)) {
    assert.equal(existsSync(join(parent, 'node_modules')), false, 'ambient ancestor node_modules refused');
    assert.equal(existsSync(join(parent, 'package.json')), false, 'ambient ancestor package manifest refused');
    if (dirname(parent) === parent) break;
  }
  assert.equal(existsSync(join(source, 'node_modules')), false, 'fresh source checkout required');
  assert.equal(existsSync(work), false, 'fresh owned work directory required');
  mkdirSync(work, { recursive: true });
  const evidence = join(work, 'evidence');
  mkdirSync(evidence);
  for (const folder of ['home', 'cache']) mkdirSync(join(work, folder));
  // A lock's relative file: requests must retain the same meaning when copied to source.
  mkdirSync(resolution);
  for (const name of ['user.npmrc', 'global.npmrc']) writeFileSync(join(evidence, name), '');
  const env = {
    PATH: process.env.PATH,
    HOME: join(work, 'home'),
    CI: 'true',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    npm_config_userconfig: join(evidence, 'user.npmrc'),
    npm_config_globalconfig: join(evidence, 'global.npmrc'),
    npm_config_cache: join(work, 'cache'),
    npm_config_update_notifier: 'false',
  };
  let ordinal = 0;
  const call = (program, args, cwd, label) =>
    run(program, args, {
      cwd,
      env,
      log: join(evidence, `${String(++ordinal).padStart(2, '0')}-${label}`),
    });
  assert.equal(call('git', ['rev-parse', 'HEAD'], source, 'consumer-head').trim(), options.consumerCommit);
  const metadata = requireMetadata(options.metadata);
  const report = inspect(options);
  json(join(evidence, 'candidate.json'), { metadata, report, node: process.version });
  const manifestPath = join(source, 'package.json'),
    lockPath = join(source, 'package-lock.json');
  const original = snapshot(manifestPath),
    originalLock = snapshot(lockPath);
  assert.ok(original, 'source package manifest required');
  const plan = candidateManifest(JSON.parse(original.bytes), options.tar, options.cohort);
  json(join(evidence, 'replaced.json'), plan.replaced);
  json(join(resolution, 'package.json'), plan.manifest);
  if (originalLock) writeFileSync(join(resolution, 'package-lock.json'), originalLock.bytes);
  // npm creates the lock normally; no hand-edited entries, overrides or peer relaxation.
  call('npm', ['install', '--strict-peer-deps', '--no-audit', '--no-fund'], resolution, 'resolve');
  const generated = readFileSync(join(resolution, 'package-lock.json'));
  writeFileSync(join(evidence, 'candidate-lock.json'), generated);
  const resolved = JSON.parse(generated).packages?.['node_modules/foottrace']?.resolved;
  assert.ok(typeof resolved === 'string' && resolved.startsWith('file:'), 'local candidate lock entry required');
  assert.equal(
    resolve(source, resolved.slice(5)),
    realpathSync(options.tar),
    'generated lock must name the candidate at the consumer',
  );
  const lockSha256 = sha256(generated);
  const candidate = {
    bytes: Buffer.from(`${JSON.stringify(plan.manifest, null, 2)}\n`),
    mode: original.mode,
  };
  const candidateLock = { bytes: generated, mode: originalLock?.mode ?? 0o600 };
  const sourceMetadata = () => {
    restore(manifestPath, original);
    restore(lockPath, originalLock);
  };
  const candidateMetadata = () => {
    restore(manifestPath, candidate);
    restore(lockPath, candidateLock);
  };
  const requireSourceMetadata = () => {
    assertMetadata(manifestPath, original);
    assertMetadata(lockPath, originalLock);
  };
  let failure, summary;
  try {
    candidateMetadata();
    call('npm', ['ci', '--strict-peer-deps', '--no-audit', '--no-fund'], source, 'install');
    assertMetadata(manifestPath, candidate);
    assertMetadata(lockPath, candidateLock);
    const hiddenBaseline = observeHiddenLock({ source, rootLockBytes: readFileSync(lockPath) });
    json(join(evidence, 'installed-hidden-lock.json'), hiddenBaseline);
    assertHiddenLockConsistent(hiddenBaseline);
    const check = async (label) => {
      assertMetadata(manifestPath, candidate);
      assertMetadata(lockPath, candidateLock);
      const hidden = observeHiddenLock({
        source,
        rootLockBytes: readFileSync(lockPath),
        baselineSha256: hiddenBaseline.hidden.sha256,
      });
      json(join(evidence, `${label}-hidden-lock.json`), hidden);
      assertHiddenLockConsistent(hidden);
      call('npm', ['ls', 'foottrace'], source, `${label}-foottrace`);
      const tree = JSON.parse(call('npm', ['ls', '--all', '--json', '--long'], source, `${label}-tree`));
      assert.equal(sha256(readFileSync(lockPath)), lockSha256, 'generated lock changed during proof');
      assert.equal(sha256(readFileSync(options.tar)), metadata.sha256, 'candidate tar changed during proof');
      const installed = await verify({ source, tree, report });
      assertMetadata(manifestPath, candidate);
      assertMetadata(lockPath, candidateLock);
      json(join(evidence, `${label}-installed.json`), installed);
    };
    await check('before');
    sourceMetadata();
    for (const [program, args] of COHORTS[options.cohort].commands) {
      requireSourceMetadata();
      const actualArgs =
        args[0] === 'test' ? [...args, '--', '--reporter=json', `--outputFile=${join(evidence, 'whole.json')}`] : args;
      call(program, actualArgs, source, args.join('-').replaceAll(':', '-'));
      requireSourceMetadata();
    }
    const whole = JSON.parse(readFileSync(join(evidence, 'whole.json'), 'utf8'));
    assert.equal(whole.success, true, 'whole-suite JSON must report success');
    assert.ok(
      Number.isSafeInteger(whole.numTotalTests) && whole.numTotalTests > 0,
      'whole-suite JSON must retain actual test counts',
    );
    assert.equal(whole.numFailedTests, 0, 'whole-suite JSON reports failed tests');
    candidateMetadata();
    try {
      await check('after');
    } finally {
      sourceMetadata();
    }
    summary = {
      status: 'PASS',
      cohort: options.cohort,
      consumerCommit: options.consumerCommit,
      metadata,
      lockSha256,
      node: process.version,
      whole: {
        total: whole.numTotalTests,
        passed: whole.numPassedTests,
        failed: whole.numFailedTests,
        pending: whole.numPendingTests,
      },
    };
  } catch (error) {
    failure = error;
    json(join(evidence, 'result.json'), {
      status: 'FAIL',
      message: error.message,
      cohort: options.cohort,
      consumerCommit: options.consumerCommit,
      metadata,
      node: process.version,
    });
  } finally {
    // Both originals stay preserved even when install, a suite or graph inspection fails.
    const errors = [];
    for (const [path, saved] of [
      [manifestPath, original],
      [lockPath, originalLock],
    ]) {
      try {
        restore(path, saved);
      } catch (error) {
        errors.push(error);
      }
    }
    json(join(evidence, 'restoration.json'), {
      status: errors.length ? 'FAIL' : 'PASS',
      manifestSha256: sha256(original.bytes),
      lockSha256: originalLock ? sha256(originalLock.bytes) : null,
    });
    if (errors.length) {
      json(join(evidence, 'result.json'), {
        status: 'FAIL',
        message: 'source restoration failed',
        cohort: options.cohort,
        consumerCommit: options.consumerCommit,
        metadata,
        node: process.version,
      });
      throw new AggregateError([...(failure ? [failure] : []), ...errors], 'source restoration failed');
    }
  }
  if (failure) throw failure;
  call('git', ['diff', '--exit-code', 'HEAD'], source, 'restored-tracked-source');
  json(join(evidence, 'result.json'), summary);
  return { work, evidence, lockSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(
    process.argv.length,
    6,
    'usage: node run.mjs <consumer-name> <consumer-source> <candidate-artifact-dir> <fresh-evidence-dir>',
  );
  const [name, source, artifact, work] = process.argv.slice(2);
  const cohort = JSON.parse(readFileSync(new URL('./cohort.json', import.meta.url), 'utf8'));
  const consumer = cohort.consumers.find((entry) => entry.name === name);
  assert.ok(consumer, 'consumer must be listed in the exact cohort');
  await runSweep({
    cohort: name,
    consumerCommit: consumer.head,
    source: resolve(source),
    tar: join(resolve(artifact), `foottrace-${CANDIDATE.version}.tgz`),
    work: resolve(work),
    metadata: JSON.parse(readFileSync(join(resolve(artifact), 'candidate.json'), 'utf8')),
  });
}
