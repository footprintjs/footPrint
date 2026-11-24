import { readFileSync } from 'node:fs';
import { SharedMemory } from 'foottrace/write';
import { expect, it } from 'vitest';
import * as main from '../../../index.js';
import * as advanced from '../../../advanced.js';

it('keeps owner and facade keys stable and adds only the declared public exports', () => {
  const parent = JSON.parse(
    readFileSync(new URL('../../../../test/fixtures/read-authority-parent-keys.json', import.meta.url), 'utf8'),
  );
  const ctx = new advanced.StageContext('run', 'stage', 'stage', new SharedMemory());
  const facade = new advanced.ScopeFacade(ctx, 'stage');
  const rule = new advanced.RedactionRule();
  const keys = (value) => Reflect.ownKeys(value).map(String).sort();
  expect({
    ruleOwn: keys(rule),
    ruleProto: keys(advanced.RedactionRule.prototype),
    contextOwn: keys(ctx),
    contextProto: keys(advanced.StageContext.prototype),
    facadeOwn: keys(facade),
    facadeProto: keys(advanced.ScopeFacade.prototype),
    advancedExports: Object.keys(advanced).sort(),
    mainExports: Object.keys(main).sort(),
  }).toEqual({
    ...parent,
    contextProto: [...parent.contextProto, 'declaredInvocationOpen', 'endDeclaredAttemptInvocation', 'useDeclaredWrites'].sort(),
    facadeProto: [...parent.facadeProto, 'declaredFailureOwner'].sort(),
    mainExports: [...parent.mainExports, 'readKeysOf', 'describeChart', 'listMounts'].sort(),
  });
  expect(typeof main.readKeysOf).toBe('function');
});
