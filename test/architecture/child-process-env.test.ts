/** Fixture children inherit capabilities by allowlist, beyond Git repository isolation. */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { isolatedGitEnv } from '../../scripts/git-env.mjs';
import { minimalChildEnv, TEMP_DIR_ENV } from '../helpers/childProcessEnv';

/**
 * The exact set a fixture child may receive, and nothing else: the executable search path, the
 * Windows startup root, and the host's temporary-directory pointers (a location, not a capability;
 * see `childProcessEnv.ts · TEMP_DIR_ENV`).
 */
const ALLOWED = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'];

const executable = resolve('generated-runtime', 'bin', 'node');
const inheritedPath = join('synthetic', 'bin');
const hostile = Object.freeze({
  PATH: inheritedPath,
  SystemRoot: 'synthetic-system-root',
  TMPDIR: 'synthetic-temp-directory',
  TMP: 'synthetic-tmp-directory',
  TEMP: 'synthetic-temp-fallback',
  NODE_OPTIONS: '--footprint-synthetic-forbidden-option',
  NODE_PATH: 'synthetic-node-path',
  __CF_USER_TEXT_ENCODING: 'synthetic-core-foundation-setting',
  BASH_ENV: 'synthetic-shell-initializer',
  ENV: 'synthetic-shell-environment',
  NPM_TOKEN: 'synthetic-npm-token',
  NODE_AUTH_TOKEN: 'synthetic-node-auth-token',
  npm_config_userconfig: 'synthetic-npm-config',
  npm_config_registry: 'https://synthetic.invalid/',
  NPM_CONFIG_PREFIX: 'synthetic-npm-prefix',
  AWS_ACCESS_KEY_ID: 'synthetic-aws-key',
  AWS_SECRET_ACCESS_KEY: 'synthetic-aws-secret',
  ANTHROPIC_API_KEY: 'synthetic-model-key',
  GIT_SSH_COMMAND: 'synthetic-git-ssh',
  GIT_CONFIG_GLOBAL: 'synthetic-global-config',
  GIT_CONFIG_SYSTEM: 'synthetic-system-config',
  GIT_DIR: 'synthetic-hook-repository',
  GIT_INDEX_FILE: 'synthetic-hook-index',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'synthetic.config',
  GIT_CONFIG_VALUE_0: 'synthetic-config-value',
});

/** Every string-valued name of the real environment, so a recording source holds whatever this host has. */
const realEnvironment = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );

/** Names a host commonly has and a fixture child must not get: `HOME` alone points npm and git at the user's config. */
const ambient = {
  HOME: 'synthetic-home',
  USER: 'synthetic-user',
  CI: 'true',
  LANG: 'C.UTF-8',
  SHELL: 'synthetic-shell',
  [`FOOTPRINT_SYNTHETIC_${process.pid}`]: 'synthetic-random-name',
};

/**
 * A source that records every key read from it and whether anything enumerated it. It holds every name
 * of the real environment plus the hostile and ambient ones, so ANY name passed through, or a copy of
 * the whole source, is seen: the pin does not depend on guessing which names to plant.
 */
function recordingSource() {
  const seed: Record<string, string> = { ...realEnvironment(), ...hostile, ...ambient };
  const reads = new Set<string>();
  let enumerated = false;
  const source = new Proxy(seed, {
    get: (target, key, receiver) => {
      reads.add(String(key));
      return Reflect.get(target, key, receiver);
    },
    has: (target, key) => {
      reads.add(String(key));
      return Reflect.has(target, key);
    },
    getOwnPropertyDescriptor: (target, key) => {
      reads.add(String(key));
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    ownKeys: (target) => {
      enumerated = true;
      return Reflect.ownKeys(target);
    },
  });
  return { seed, source, reads, enumerated: () => enumerated };
}

/** The durable-sqlite example's Node check, which starts its mutant children itself (it cannot import the helper). */
const EXAMPLE_CHECK = resolve('examples/runtime-features/pause-resume/durable-sqlite/store.node-check.cjs');

const child = (
  env: NodeJS.ProcessEnv,
  script = 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))',
) =>
  spawnSync(process.execPath, ['-e', script], {
    env,
    encoding: 'utf8',
    timeout: 3_000,
    maxBuffer: 4_096,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe('minimal fixture child environment', () => {
  it('keeps only the executable search path, Windows SystemRoot and temp pointers without mutating the seed', () => {
    const original = { ...hostile };
    const safe = minimalChildEnv(hostile, executable);
    expect(safe).toEqual({
      PATH: [dirname(executable), inheritedPath].join(delimiter),
      SystemRoot: hostile.SystemRoot,
      TMPDIR: hostile.TMPDIR,
      TMP: hostile.TMP,
      TEMP: hostile.TEMP,
    });
    expect(Object.keys(safe).sort()).toEqual(ALLOWED);
    expect(hostile).toEqual(original);
    expect(Object.isFrozen(hostile)).toBe(true);
  });

  it("passes exactly the names Node's os.tmpdir() reads, in its POSIX order", () => {
    expect(TEMP_DIR_ENV).toEqual(['TMPDIR', 'TMP', 'TEMP']);
    expect(Object.isFrozen(TEMP_DIR_ENV)).toBe(true);
    expect([...TEMP_DIR_ENV].sort()).toEqual(ALLOWED.filter((key) => key !== 'PATH' && key !== 'SystemRoot'));
  });

  it.each([undefined, ''])('does not add a current-directory search entry when PATH is %s', (PATH) => {
    expect(minimalChildEnv(Object.freeze({ PATH }), executable)).toEqual({ PATH: dirname(executable) });
  });

  it.each([undefined, ''])('does not invent a temp pointer the host left %s', (value) => {
    const seed = Object.freeze({ PATH: inheritedPath, TMPDIR: value, TMP: value, TEMP: value });
    expect(minimalChildEnv(seed, executable)).toEqual({ PATH: [dirname(executable), inheritedPath].join(delimiter) });
  });

  it('passes one pointer alone, as the host set it', () => {
    for (const name of TEMP_DIR_ENV) {
      const seed = Object.freeze({ PATH: inheritedPath, [name]: `synthetic-${name}` });
      expect(minimalChildEnv(seed, executable)).toEqual({
        PATH: [dirname(executable), inheritedPath].join(delimiter),
        [name]: `synthetic-${name}`,
      });
    }
  });

  it('reads exactly the allowed names from its source and never enumerates it, whatever the source holds', () => {
    const { seed, source, reads, enumerated } = recordingSource();
    const safe = minimalChildEnv(source, executable);
    expect([...reads].sort()).toEqual(ALLOWED);
    expect(enumerated()).toBe(false);
    expect(Object.keys(safe).sort()).toEqual(ALLOWED);
    for (const name of ALLOWED.filter((key) => key !== 'PATH')) expect(safe[name]).toBe(seed[name]);
  });

  it("keeps the durable-sqlite example's own copy equal to the helper's: its mutant child gets PATH and the pointers only", () => {
    const text = readFileSync(EXAMPLE_CHECK, 'utf8');
    // The example's helper statement and the one mutant spawn's env, evaluated as written, against a
    // process whose environment holds every real name plus the hostile and ambient ones.
    const helper = text.match(/^const tempDirEnv = [^;]*;$/m);
    const spawns = [...text.matchAll(/\benv: (.+),\n/g)];
    expect(helper, 'store.node-check.cjs · tempDirEnv').not.toBeNull();
    expect(spawns, 'one child env in store.node-check.cjs').toHaveLength(1);
    const env = { ...realEnvironment(), ...hostile, ...ambient, PATH: inheritedPath };
    const given = JSON.parse(
      JSON.stringify(runInNewContext(`${helper?.[0]}\n(${spawns[0][1]})`, { process: { env } }, { timeout: 1_000 })),
    );
    expect(given).toEqual(
      Object.fromEntries(['PATH', ...TEMP_DIR_ENV].map((name) => [name, env[name as keyof typeof env]])),
    );
  });

  it("gives a real child the host's own temporary directory", () => {
    const result = child(minimalChildEnv(process.env), "process.stdout.write(require('node:os').tmpdir())");
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(tmpdir());
  });

  it('blocks a real Node startup injection that Git-only isolation intentionally preserves', () => {
    const seed = Object.freeze({
      ...hostile,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : { SystemRoot: undefined }),
    });
    const original = { ...seed };
    const gitOnly = isolatedGitEnv(seed);
    for (const key of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'BASH_ENV',
      'npm_config_userconfig',
      'GIT_SSH_COMMAND',
      'GIT_CONFIG_GLOBAL',
    ]) {
      expect(gitOnly[key]).toBe(seed[key as keyof typeof seed]);
    }
    expect(gitOnly.GIT_DIR).toBeUndefined();
    expect(gitOnly.GIT_CONFIG_KEY_0).toBeUndefined();
    const unsafe = child(gitOnly);
    expect(unsafe.error).toBeUndefined();
    expect(unsafe.signal).toBeNull();
    expect(unsafe.status).not.toBe(0);
    expect(unsafe.stdout).toBe('');

    const safe = minimalChildEnv(seed);
    const result = child(safe);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    // Core Foundation may add its own encoding key on macOS; it was not inherited from the seed.
    const runtimeKeys = (JSON.parse(result.stdout) as string[]).filter(
      (key) => process.platform !== 'darwin' || key !== '__CF_USER_TEXT_ENCODING',
    );
    expect(runtimeKeys.map((key) => key.toUpperCase()).sort()).toEqual(
      Object.keys(safe)
        .map((key) => key.toUpperCase())
        .sort(),
    );
    expect(Object.keys(safe).sort()).toEqual(ALLOWED.filter((key) => key !== 'SystemRoot' || seed.SystemRoot));
    expect(seed).toEqual(original);
  });
});
