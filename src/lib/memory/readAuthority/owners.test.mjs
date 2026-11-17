import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { SharedMemory } from 'foottrace/write';
import { expect, it } from 'vitest';

import * as port from '../readAuthority.js';
import * as ruleOwner from '../redaction.js';
import * as contextOwner from '../StageContext.js';

it('Rule registration carries original owner data, without observation callbacks', () => {
  expect(ruleOwner.observeOwnedRule(new ruleOwner.RedactionRule())).toBe(true);
  const authority = port.createRuleAuthority(ruleOwner.RedactionRule.prototype);
  // Method/constructor identities inside descriptor snapshots are legitimate DATA.
  expect(Object.hasOwn(authority, 'observe')).toBe(false);
  expect(Object.hasOwn(authority, 'register')).toBe(false);
  expect(Object.hasOwn(authority, 'admits')).toBe(false);
  expect(authority.prototype).toBe(ruleOwner.RedactionRule.prototype);
  expect(authority.descriptors.find(([key]) => key === 'constructor')[1].value).toBe(ruleOwner.RedactionRule);
  expect(authority.descriptors.find(([key]) => key === 'isInert')[1].value).toBe(
    ruleOwner.RedactionRule.prototype.isInert,
  );
});

it('context registration does not capture Rule/policy observation callbacks', () => {
  const context = new contextOwner.StageContext('r', 's', 's', new SharedMemory());
  expect(contextOwner.observeOwnedContext(context)).toBe(true);
  const authority = port.createContextAuthority(contextOwner.StageContext.prototype);
  expect(Object.hasOwn(authority, 'observe')).toBe(false);
  expect(Object.hasOwn(authority, 'register')).toBe(false);
  expect(Object.hasOwn(authority, 'admits')).toBe(false);
});

const ROOT = resolve(import.meta.dirname, '../../../..');
const COLD_METHODS = [
  ['rule', 'constructor'],
  ['rule', 'isInert'],
  ['context', 'constructor'],
  ['context', 'getPolicy'],
  ['context', 'getRedactionRule'],
  ['context', 'usePolicy'],
  ['context', 'useRedactionRule'],
  ['context', 'adoptPolicy'],
];

for (const [kind, method] of COLD_METHODS) {
  for (const beforeConstruction of [true, false]) {
    it(`cold native ${kind}.${method} refuses changed authority before first ${
      beforeConstruction ? 'construction' : 'observation'
    }`, () => {
      const program = `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(${JSON.stringify(resolve(ROOT, 'package.json'))});
const api=require(${JSON.stringify(resolve(ROOT, 'src/advanced.ts'))});
const {SharedMemory}=require('foottrace/write');
const kind=${JSON.stringify(kind)}, key=${JSON.stringify(method)}, before=${beforeConstruction};
const raw=require(${JSON.stringify(
        resolve(ROOT, `src/lib/memory/${kind === 'rule' ? 'redaction' : 'StageContext'}.ts`),
      )});
const Ctor=kind==='rule'?api.RedactionRule:api.StageContext;
assert.equal(Ctor,kind==='rule'?raw.RedactionRule:raw.StageContext);
const observe=kind==='rule'?raw.observeOwnedRule:raw.observeOwnedContext;
const make=()=>kind==='rule'?new Ctor():new Ctor('run','stage','stage',new SharedMemory());
const original=Object.getOwnPropertyDescriptor(Ctor.prototype,key); let calls=0;
const instance=before?undefined:make(); let value;
try {
 Object.defineProperty(Ctor.prototype,key,{...original,value:function(){calls++;throw Error('foreign method')}});
 value=instance??make();
 assert.equal(observe(value),undefined);
 assert.equal(calls,0);
} finally {Object.defineProperty(Ctor.prototype,key,original)}
assert.equal(observe(value),true);
console.log('cold actual source authority PASS');
`;
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain('cold actual source authority PASS');
    });
  }
}
