import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { entry, tar } from '../../publish-release/archive/fixture.cjs';
import { inspectPacked, verifyBundle } from '../bytes/index.mjs';
import { produceSource } from './source.mjs';

// Tiny package fixtures prove native strategy plumbing, not the real AF implementation/build.
for (const hasLock of [false, true])
  for (const fault of [null, 'install', 'build', 'graph', 'pack', 'packed-fields', 'save'])
    it(`restores exact source manifest and ${hasLock ? 'lock bytes' : 'lock absence'} after ${
      fault ?? 'success'
    }`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'cohort-native-source-'));
      const workspace = join(dir, 'archive');
      mkdirSync(workspace);
      const row = { package: 'agentfootprint', version: '15.0.0-rc.0', pr: 383, head: 'a'.repeat(40) };
      const tree = 'b'.repeat(40),
        recipe = { repo: 'footprintjs/agentfootprint', build: 'npm run build' };
      const manifest = {
        name: row.package,
        version: '14.7.2',
        peerDependencies: { footprintjs: '^13.0.0-rc.0' },
        devDependencies: { footprintjs: '12.1.0' },
      };
      const original = Buffer.from('  ' + JSON.stringify(manifest) + '\n'),
        lock = Buffer.from('{"original":"unchanged"}\n');
      const file = join(dir, 'package.json'),
        lockFile = join(dir, 'package-lock.json');
      writeFileSync(file, original);
      if (hasLock) writeFileSync(lockFile, lock);
      const phases = [];
      let receipt;
      const io = {
        run: (command) => {
          expect(command).toBe(recipe.build);
          phases.push('build');
          const observed = JSON.parse(readFileSync(file));
          expect(observed.version).toBe('14.7.2');
          expect(observed.devDependencies.footprintjs).toBe('file:paired.tgz');
          return { ok: fault !== 'build' };
        },
        read: (command, args) => {
          if (command === 'git') {
            if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? row.head : tree;
            const changed = [];
            if (!args.includes(':(exclude)package.json') && !readFileSync(file).equals(original))
              changed.push('package.json');
            if (hasLock ? !readFileSync(lockFile).equals(lock) : existsSync(lockFile))
              changed.push('package-lock.json');
            return changed.join('\n');
          }
          expect(command).toBe('npm');
          expect(args).toContain('--ignore-scripts');
          phases.push('pack');
          const staged = JSON.parse(readFileSync(file));
          expect(staged).toEqual({ ...manifest, version: row.version });
          expect(hasLock ? readFileSync(lockFile).equals(lock) : !existsSync(lockFile)).toBe(true);
          if (fault === 'pack') throw Error('pack fault');
          const bytes = gzipSync(
            tar([
              entry(
                'package/package.json',
                JSON.stringify(
                  fault === 'packed-fields' ? { ...staged, peerDependencies: { footprintjs: '*' } } : staged,
                ),
              ),
              entry('package/dist/version.cjs', "module.exports=()=>require('../package.json').version"),
              entry(
                'package/dist/version.mjs',
                "import {createRequire} from 'node:module';const r=createRequire(import.meta.url);export default ()=>r('../package.json').version;",
              ),
            ]),
          );
          writeFileSync(join(workspace, 'native.tgz'), bytes);
          return JSON.stringify([{ filename: 'native.tgz' }]);
        },
      };
      const services = {
        installPaired: () => {
          phases.push('install');
          writeFileSync(file, JSON.stringify({ ...manifest, devDependencies: { footprintjs: 'file:paired.tgz' } }));
          writeFileSync(lockFile, '{"temporary":"paired"}');
          if (fault === 'install') throw Error('install fault');
          return new Map();
        },
        verifyInstalled: () => {
          phases.push('graph');
          if (fault === 'graph') throw Error('graph fault');
        },
      };
      try {
        const work = produceSource(
          { dir, row, manifest, recipe, selected: new Map(), family: [], workspace, expectedTrace: '2.0.0-rc.0' },
          io,
          (_name, path, source, more) => {
            phases.push('save');
            if (fault === 'save') throw Error('save fault');
            const observed = inspectPacked(path, source, more.origin.archiveVersion);
            expect(observed.manifest.version).toBe(row.version);
            expect(more.origin.sourceVersion).toBe('14.7.2');
            receipt = { ...observed, ...more, filename: 'agentfootprint.tgz' };
            writeFileSync(join(workspace, receipt.filename), readFileSync(path));
          },
          services,
        );
        if (fault) await expect(work).rejects.toThrow();
        else {
          await work;
          expect(phases).toEqual(['install', 'build', 'graph', 'pack', 'save']);
          const context = {
            head: 'engine',
            tree: 'engine-tree',
            checkout: 'merge',
            base: 'base',
            run: '1',
            attempt: '1',
          };
          const engine = { name: 'footprintjs', version: '13.0.0-rc.0' };
          const enginePath = join(workspace, 'footprintjs.tgz');
          writeFileSync(
            enginePath,
            gzipSync(
              tar([entry('package/package.json', JSON.stringify(engine)), entry('package/dist/index.js', 'fixture')]),
            ),
          );
          const engineReceipt = {
            ...inspectPacked(enginePath, engine),
            filename: 'footprintjs.tgz',
            head: context.head,
            tree: context.tree,
          };
          const plan = { hash: 'plan', engineVersion: engine.version, packages: [row], registry: [] };
          const bundle = { schema: 1, planHash: plan.hash, context, packages: [engineReceipt, receipt] };
          expect(verifyBundle(bundle, plan, context, workspace).get(row.package).manifest.version).toBe(row.version);
          expect(() =>
            verifyBundle(
              { ...bundle, packages: [engineReceipt, { ...receipt, origin: { ...receipt.origin, pr: 1 } }] },
              plan,
              context,
              workspace,
            ),
          ).toThrow('origin');
          const installed = join(dir, 'node_modules/agentfootprint');
          mkdirSync(installed, { recursive: true });
          execFileSync('tar', ['-xzf', join(workspace, 'agentfootprint.tgz'), '-C', installed, '--strip-components=1']);
          const cjs = execFileSync(
            process.execPath,
            ['-e', `console.log(require(${JSON.stringify(join(installed, 'dist/version.cjs'))})())`],
            { encoding: 'utf8' },
          ).trim();
          const esm = execFileSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `import v from ${JSON.stringify(join(installed, 'dist/version.mjs'))};console.log(v())`,
            ],
            { encoding: 'utf8' },
          ).trim();
          expect([cjs, esm]).toEqual([row.version, row.version]);
        }
        expect(readFileSync(file)).toEqual(original);
        expect(hasLock ? readFileSync(lockFile).equals(lock) : !existsSync(lockFile)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 10000);
