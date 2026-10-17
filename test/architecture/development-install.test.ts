/** The contributor install pins Foottrace without narrowing the published runtime dependency. */
import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { minimalChildEnv } from '../helpers/childProcessEnv';

const repositoryManifest = resolve(__dirname, '../../package.json');
const repositoryLock = resolve(__dirname, '../../package-lock.json');
const readManifest = (directory: string) => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function npmCli(): string {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  ];
  const cli = candidates.find((file) => file && basename(file) === 'npm-cli.js' && existsSync(file));
  if (!cli) throw new Error('Run this integration test with npm and its Node installation available.');
  return cli;
}

describe('Foottrace development installation', () => {
  it('pins the development root while a packed consumer can resolve a newer compatible runtime', async () => {
    const original = readFileSync(repositoryManifest, 'utf8');
    const source = JSON.parse(original);
    expect(source.dependencies.foottrace).toBe('^1.3.0');
    expect(source.devDependencies.foottrace).toBeUndefined();
    expect(source.overrides?.foottrace).toBeUndefined();
    const originalLock = readFileSync(repositoryLock, 'utf8');
    const sourceLock = JSON.parse(originalLock);
    expect(sourceLock.packages[''].dependencies.foottrace).toBe('^1.3.0');
    expect(sourceLock.packages['node_modules/foottrace'].version).toBe('1.4.0');
    expect(Object.keys(sourceLock.packages).filter((path) => /(^|\/)node_modules\/foottrace$/.test(path))).toEqual([
      'node_modules/foottrace',
    ]);

    const deadline = Date.now() + 60_000;
    const root = mkdtempSync(join(tmpdir(), 'foottrace-development-'));
    const children = new Set<ChildProcess>();
    const routes = new Map<string, { body: Buffer; type: string }>();
    const unexpectedRequests: string[] = [];
    let requestCount = 0;
    const server = createServer((request, response) => {
      request.resume();
      const route = request.method === 'GET' ? routes.get(request.url ?? '') : undefined;
      if (++requestCount > 64 || !route) {
        if (unexpectedRequests.length < 8) unexpectedRequests.push(`${request.method} ${request.url}`);
        response.writeHead(404).end('Generated fixture routes only');
        return;
      }
      response.writeHead(200, { 'content-type': route.type, 'content-length': route.body.length }).end(route.body);
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 100;
    server.maxConnections = 8;

    const kill = (child: ChildProcess, signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        // Terminate every child in the generated process group on timeout or cleanup.
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };

    try {
      for (const directory of ['cache', 'archives']) mkdirSync(join(root, directory));
      const userConfig = join(root, 'user.npmrc');
      const globalConfig = join(root, 'global.npmrc');
      writeFileSync(userConfig, '');
      writeFileSync(globalConfig, '');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing generated loopback registry address.');
      const registry = `http://127.0.0.1:${address.port}`;
      const env: NodeJS.ProcessEnv = {
        ...minimalChildEnv(process.env),
        npm_config_registry: registry,
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
        npm_config_cache: join(root, 'cache'),
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_package_lock: 'true',
        npm_config_update_notifier: 'false',
        npm_config_fetch_retries: '0',
        npm_config_fetch_timeout: '5000',
      };
      const flags = [
        `--registry=${registry}`,
        `--userconfig=${userConfig}`,
        `--globalconfig=${globalConfig}`,
        `--cache=${join(root, 'cache')}`,
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefer-online',
      ];
      const cli = npmCli();
      const npm = (directory: string, args: string[]): Promise<string> => {
        const remaining = Math.min(12_000, deadline - Date.now());
        if (remaining <= 0) throw new Error('Generated npm fixture exceeded its 60 second total budget.');
        return new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [cli, ...args], {
            cwd: directory,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
          });
          children.add(child);
          let output = '';
          let failure: string | undefined;
          let forceKill: ReturnType<typeof setTimeout> | undefined;
          const stop = (reason: string) => {
            if (failure) return;
            failure = reason;
            kill(child, 'SIGTERM');
            forceKill = setTimeout(() => kill(child, 'SIGKILL'), 1_000);
          };
          const timer = setTimeout(() => stop('exceeded its time budget'), remaining);
          const collect = (chunk: Buffer) => {
            if (output.length + chunk.length > 64 * 1024) stop('exceeded 64 KiB output');
            else output += chunk.toString();
          };
          child.stdout.on('data', collect);
          child.stderr.on('data', collect);
          child.once('error', (error) => {
            failure = error.message;
          });
          child.once('close', (code) => {
            clearTimeout(timer);
            if (forceKill) clearTimeout(forceKill);
            children.delete(child);
            if (failure || code !== 0) reject(new Error(`npm ${args[0]} ${failure ?? `exited ${code}`}\n${output}`));
            else resolve(output);
          });
        });
      };

      const project = (name: string, manifest: Record<string, unknown>) => {
        const directory = join(root, name);
        mkdirSync(directory);
        writeFileSync(join(directory, 'package.json'), json(manifest));
        writeFileSync(join(directory, 'index.js'), "module.exports = require('foottrace');\n");
        return directory;
      };
      const pack = async (directory: string): Promise<string> => {
        const output = JSON.parse(
          await npm(directory, ['pack', '--json', `--pack-destination=${join(root, 'archives')}`, ...flags]),
        );
        expect(output).toHaveLength(1);
        expect(output[0].files.map((file: { path: string }) => file.path)).not.toContain('package-lock.json');
        const file = join(root, 'archives', basename(output[0].filename));
        expect(readFileSync(file).length).toBeLessThan(64 * 1024);
        return file;
      };
      let publishNewerFoottrace: (() => void) | undefined;
      for (const [name, versions] of [
        ['foottrace', ['1.4.0', '1.4.1']],
        ['development-helper-fixture', ['1.0.0']],
      ] as const) {
        const metadata: Record<string, unknown> = {};
        for (const version of versions) {
          const directory = project(`${name}-${version}`, { name, version, main: 'index.js' });
          writeFileSync(join(directory, 'index.js'), `module.exports = ${JSON.stringify(version)};\n`);
          const archive = readFileSync(await pack(directory));
          const path = `/${name}/-/${name}-${version}.tgz`;
          routes.set(path, { body: archive, type: 'application/octet-stream' });
          metadata[version] = {
            name,
            version,
            dist: {
              tarball: `${registry}${path}`,
              integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
            },
          };
        }
        const publish = (available: readonly string[]) => {
          routes.set(`/${name}`, {
            body: Buffer.from(
              json({
                name,
                'dist-tags': { latest: available[available.length - 1] },
                versions: Object.fromEntries(available.map((version) => [version, metadata[version]])),
              }),
            ),
            type: 'application/json',
          });
        };
        publish(name === 'foottrace' ? ['1.4.0'] : versions);
        if (name === 'foottrace') publishNewerFoottrace = () => publish(versions);
      }

      const development = project('development', {
        name: 'development-library-fixture',
        version: '1.0.0',
        main: 'index.js',
        dependencies: { foottrace: source.dependencies.foottrace },
        devDependencies: { 'development-helper-fixture': '1.0.0' },
        scripts: { clean: source.scripts.clean },
      });
      const before = readFileSync(join(development, 'package.json'), 'utf8');
      await npm(development, ['install', '--package-lock-only', '--include=dev', ...flags]);
      const locked = readFileSync(join(development, 'package-lock.json'), 'utf8');
      expect(JSON.parse(locked).packages['node_modules/foottrace'].version).toBe('1.4.0');
      if (!publishNewerFoottrace) throw new Error('Missing generated Foottrace metadata.');
      publishNewerFoottrace();

      for (const command of ['ci', 'install']) {
        const directory = project(command, JSON.parse(before));
        writeFileSync(join(directory, 'package-lock.json'), locked);
        await npm(directory, [command, '--include=dev', ...flags]);
        expect(createRequire(join(directory, 'package.json'))('foottrace'), command).toBe('1.4.0');
        expect(readManifest(join(directory, 'node_modules/development-helper-fixture')).version, command).toBe('1.0.0');
        expect(readFileSync(join(directory, 'package.json'), 'utf8'), command).toBe(before);
        expect(readFileSync(join(directory, 'package-lock.json'), 'utf8'), command).toBe(locked);
        if (command === 'ci') {
          await npm(directory, ['run', 'clean']);
          expect(existsSync(join(directory, 'package-lock.json'))).toBe(true);
          expect(readFileSync(join(directory, 'package-lock.json'), 'utf8')).toBe(locked);
          expect(readFileSync(join(directory, 'package.json'), 'utf8')).toBe(before);
        }
      }

      const archive = await pack(development);
      const consumer = project('consumer', {
        name: 'normal-consumer-fixture',
        version: '1.0.0',
        private: true,
        dependencies: { 'development-library-fixture': `file:${archive}` },
      });
      await npm(consumer, ['install', '--omit=dev', ...flags]);
      const library = join(consumer, 'node_modules/development-library-fixture');
      const consumerRequire = createRequire(join(consumer, 'package.json'));
      const libraryRequire = createRequire(join(library, 'package.json'));
      expect(consumerRequire('foottrace')).toBe('1.4.1');
      expect(libraryRequire('foottrace')).toBe('1.4.1');
      expect(realpathSync(libraryRequire.resolve('foottrace'))).toBe(
        realpathSync(consumerRequire.resolve('foottrace')),
      );
      expect(existsSync(join(library, 'node_modules/foottrace'))).toBe(false);
      expect(existsSync(join(consumer, 'node_modules/development-helper-fixture'))).toBe(false);
      expect(existsSync(join(library, 'package-lock.json'))).toBe(false);
      expect(readManifest(library).dependencies.foottrace).toBe('^1.3.0');

      expect(readFileSync(join(development, 'package.json'), 'utf8')).toBe(before);
      expect(readManifest(development).dependencies.foottrace).toBe('^1.3.0');
      expect(readFileSync(repositoryManifest, 'utf8')).toBe(original);
      expect(readFileSync(repositoryLock, 'utf8')).toBe(originalLock);
      expect(unexpectedRequests).toEqual([]);
      expect(requestCount).toBeGreaterThan(0);
    } finally {
      for (const child of children) kill(child, 'SIGKILL');
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
