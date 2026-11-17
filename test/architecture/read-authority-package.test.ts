/** Actual packed CJS/ESM private foundation, not a native location feature or new dependency pair. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const parent = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/read-authority-parent-keys.json'), 'utf8'));

it('keeps actual packed CJS/ESM owner layout, current carriers, public keys and callback refusal', () => {
  const temp = mkdtempSync(join(tmpdir(), 'footprint-read-authority-'));
  try {
    const pack = spawnSync(
      'npm',
      ['pack', '--offline', '--ignore-scripts', '--json', '--cache', join(temp, 'cache'), '--pack-destination', temp],
      { cwd: ROOT, encoding: 'utf8', timeout: 30_000 },
    );
    expect(pack.status, pack.stderr).toBe(0);
    const archive = join(temp, JSON.parse(pack.stdout)[0].filename);
    const modules = join(temp, 'node_modules');
    mkdirSync(modules);
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', modules], { encoding: 'utf8', timeout: 10_000 });
    expect(unpack.status, unpack.stderr).toBe(0);
    // Reuse the CI lock's physical native dependency; no install, alias or invented version.
    symlinkSync(realpathSync(join(ROOT, 'node_modules/foottrace')), join(modules, 'foottrace'), 'dir');
    const packageRoot = join(modules, 'footprintjs');
    renameSync(join(modules, 'package'), packageRoot);
    for (const format of ['cjs', 'esm']) {
      const program = `
${
  format === 'cjs'
    ? "const assert = require('node:assert/strict'); const {SharedMemory} = require('foottrace/write'); const load = p => require(" +
      JSON.stringify(packageRoot + '/dist/') +
      "+p+'.js');"
    : "import assert from 'node:assert/strict'; import {SharedMemory} from 'foottrace/write'; import {pathToFileURL} from 'node:url'; const load = p => import(pathToFileURL(" +
      JSON.stringify(packageRoot + '/dist/esm/') +
      "+p+'.js').href);"
}
(async () => {
const main = await load('index'), advanced = await load('advanced');
const ruleOwner = await load('lib/memory/redaction'), contextOwner = await load('lib/memory/StageContext');
const {runPolicy,derivePolicy} = await load('lib/memory/runPolicy');
const ctx = new advanced.StageContext('run','stage','stage',new SharedMemory());
const facade = new advanced.ScopeFacade(ctx,'stage'); const rule = new advanced.RedactionRule();
const keys = value => Reflect.ownKeys(value).map(String).sort();
assert.deepEqual({ruleOwn:keys(rule),ruleProto:keys(advanced.RedactionRule.prototype),contextOwn:keys(ctx),contextProto:keys(advanced.StageContext.prototype),facadeOwn:keys(facade),facadeProto:keys(advanced.ScopeFacade.prototype),advancedExports:Object.keys(advanced).sort(),mainExports:Object.keys(main).sort()},${JSON.stringify(
        parent,
      )});
assert.equal(ruleOwner.observeOwnedRule(rule),true);
rule.mark('secret'); assert.equal(ruleOwner.observeOwnedRule(rule),false);
ctx.usePolicy(runPolicy({},rule)); assert.equal(contextOwner.observeOwnedContext(ctx),false);
ctx.usePolicy(derivePolicy(ctx.getPolicy(),{redaction:undefined})); assert.equal(contextOwner.observeOwnedContext(ctx),true);
ctx.useRedactionRule(new advanced.RedactionRule({keys:['secret']})); assert.equal(contextOwner.observeOwnedContext(ctx),false);
let calls=0; const proxy=new Proxy(rule,{getPrototypeOf(){calls++;throw Error('probe')},getOwnPropertyDescriptor(){calls++;throw Error('probe')}});
assert.equal(ruleOwner.observeOwnedRule(proxy),undefined);
Object.defineProperty(rule,'isInert',{get(){calls++;throw Error('callback')}});
assert.equal(ruleOwner.observeOwnedRule(rule),undefined); assert.equal(calls,0);
const value={count:2}; facade.setValue('public',value); assert.equal(facade.getValue('public'),value);
console.log('packed-${format}: private owners/current policy/public keys/callback refusal PASS');
})().catch(error=>{console.error(error);process.exitCode=1});
`;
      const script = join(temp, `probe.${format === 'esm' ? 'mjs' : 'cjs'}`);
      writeFileSync(script, program);
      const child = spawnSync(process.execPath, [script], { cwd: temp, encoding: 'utf8', timeout: 10_000 });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain(
        `packed-${format}: private owners/current policy/public keys/callback refusal PASS`,
      );
      console.info(child.stdout.trim());
    }
    console.info(
      `actual-foundation-archive-sha256 ${createHash('sha256').update(readFileSync(archive)).digest('hex')}`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 60_000);
