import { describe, expect, it } from 'vitest';

import { touchesProblem } from '../../../attempt/effect.js';
import { touchesRefusal } from './index.js';

describe('dynamic touching-node refusal wording', () => {
  it('keeps an admitted one-send declaration admitted', () => {
    expect(touchesRefusal({ id: 'send', touches: { system: 'service' } })).toBeUndefined();
  });

  it('prefixes the one shared verdict with the node identity without evaluating a key rule', () => {
    const node = { id: 'send', touches: { system: 'service' }, retry: { attempts: 2 } };
    expect(touchesRefusal(node)).toBe("stage 'send': " + touchesProblem(node.touches, node.retry));
    let keyCalls = 0;
    const keyed = {
      ...node,
      touches: {
        system: 'service',
        idempotencyKey: () => {
          keyCalls++;
          return 'key';
        },
      },
    };
    expect(touchesRefusal(keyed)).toBeUndefined();
    expect(keyCalls).toBe(0);
  });
});
