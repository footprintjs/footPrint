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
const cold=process.argv.slice(2);
if(cold.length) {
 const [kind,key,phase]=cold;
 const Ctor=kind==='rule'?advanced.RedactionRule:advanced.StageContext;
 const raw=kind==='rule'?ruleOwner:contextOwner;
 assert.equal(Ctor,kind==='rule'?raw.RedactionRule:raw.StageContext);
 const observe=kind==='rule'?raw.observeOwnedRule:raw.observeOwnedContext;
 const make=()=>kind==='rule'?new Ctor():new Ctor('run','stage','stage',new SharedMemory());
 const original=Object.getOwnPropertyDescriptor(Ctor.prototype,key); let calls=0;
 const first=phase==='before'?undefined:make(); let instance;
 try {
  Object.defineProperty(Ctor.prototype,key,{...original,value:function(){calls++;throw Error('foreign method')}});
  instance=first??make(); assert.equal(observe(instance),undefined); assert.equal(calls,0);
 } finally {Object.defineProperty(Ctor.prototype,key,original)}
 assert.equal(observe(instance),true);
 console.log('packed-${format}: cold original authority PASS'); return;
}
const ctx = new advanced.StageContext('run','stage','stage',new SharedMemory());
const facade = new advanced.ScopeFacade(ctx,'stage'); const rule = new advanced.RedactionRule();
const keys = value => Reflect.ownKeys(value).map(String).sort();
assert.deepEqual({ruleOwn:keys(rule),ruleProto:keys(advanced.RedactionRule.prototype),contextOwn:keys(ctx),contextProto:keys(advanced.StageContext.prototype),facadeOwn:keys(facade),facadeProto:keys(advanced.ScopeFacade.prototype),advancedExports:Object.keys(advanced).sort(),mainExports:Object.keys(main).sort()},${JSON.stringify(
        { ...parent, mainExports: [...parent.mainExports, 'readKeysOf', 'describeChart', 'listMounts'].sort() },
      )});
assert.equal(typeof main.readKeysOf,'function');
assert.equal(ruleOwner.observeOwnedRule(rule),true);
rule.mark('secret'); assert.equal(ruleOwner.observeOwnedRule(rule),false);
ctx.usePolicy(runPolicy({},rule)); assert.equal(contextOwner.observeOwnedContext(ctx),false);
ctx.usePolicy(derivePolicy(ctx.getPolicy(),{redaction:undefined})); assert.equal(contextOwner.observeOwnedContext(ctx),true);
ctx.useRedactionRule(new advanced.RedactionRule({keys:['secret']})); assert.equal(contextOwner.observeOwnedContext(ctx),false);
let calls=0; const proxy=new Proxy(rule,{getPrototypeOf(){calls++;throw Error('probe')},getOwnPropertyDescriptor(){calls++;throw Error('probe')}});
assert.equal(ruleOwner.observeOwnedRule(proxy),undefined);
Object.defineProperty(rule,'isInert',{get(){calls++;throw Error('callback')}});
assert.equal(ruleOwner.observeOwnedRule(rule),undefined); assert.equal(calls,0);
const bare=new advanced.StageContext('run','bare','bare',new SharedMemory());
const explicit=new advanced.StageContext('run','own','own',new SharedMemory());
explicit.usePolicy(derivePolicy(explicit.getPolicy(),{redaction:undefined}));
const inheritedRule=new advanced.RedactionRule({keys:['private']});
for(const accessor of [false,true]) {
 const previous=Object.getOwnPropertyDescriptor(Object.prototype,'redaction'); let getters=0;
 try {
  Object.defineProperty(Object.prototype,'redaction',accessor?{configurable:true,get(){getters++;return inheritedRule}}:{configurable:true,value:inheritedRule});
  assert.equal(bare.getRedactionRule(),inheritedRule); getters=0;
  assert.equal(contextOwner.observeOwnedContext(bare),undefined);
  assert.equal(contextOwner.observeOwnedContext(explicit),true); assert.equal(getters,0);
 } finally { if(previous) Object.defineProperty(Object.prototype,'redaction',previous); else delete Object.prototype.redaction; }
}
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
      for (const [kind, method] of [
        ['rule', 'constructor'],
        ['rule', 'isInert'],
        ['context', 'constructor'],
        ['context', 'getPolicy'],
        ['context', 'getRedactionRule'],
        ['context', 'usePolicy'],
        ['context', 'useRedactionRule'],
        ['context', 'adoptPolicy'],
      ]) {
        for (const phase of ['before', 'after']) {
          const cold = spawnSync(process.execPath, [script, kind, method, phase], {
            cwd: temp,
            encoding: 'utf8',
            timeout: 5_000,
          });
          expect(cold.status, cold.stderr).toBe(0);
          expect(cold.stdout).toContain(`packed-${format}: cold original authority PASS`);
        }
      }
      console.info(`packed-${format}: 16 cold original authority cases PASS`);
    }
    const consumer = `import {StageContext,RedactionRule} from 'footprintjs/advanced';
import {SharedMemory} from 'foottrace/write';
const frame=new StageContext('run','stage','stage',new SharedMemory());
frame.useRedactionRule(new RedactionRule());
const policy=frame.getPolicy(); void policy;
// @ts-expect-error private owner observation is absent from the public door
import {observeOwnedRule} from 'footprintjs/advanced'; void observeOwnedRule;
`;
    writeFileSync(join(temp, 'consumer.mts'), consumer);
    writeFileSync(join(temp, 'consumer.cts'), consumer);
    writeFileSync(
      join(temp, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          exactOptionalPropertyTypes: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2022',
          lib: ['ES2022', 'DOM'],
          types: [],
        },
        files: ['consumer.mts', 'consumer.cts'],
      }),
    );
    const declarations = spawnSync(
      process.execPath,
      [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(temp, 'tsconfig.json')],
      { cwd: temp, encoding: 'utf8', timeout: 15_000 },
    );
    expect(declarations.status, declarations.stdout + declarations.stderr).toBe(0);
    console.info('packed strict .mts/.cts public owner declarations and private-export refusal PASS');
    console.info(
      `actual-foundation-archive-sha256 ${createHash('sha256').update(readFileSync(archive)).digest('hex')}`,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 60_000);
