import { expect, it } from 'vitest';

import { detachMappedInput } from './index.js';

it('detaches mapped containers without changing the parent or class identity', () => {
  class Foreign {}
  const foreign = new Foreign();
  const input = { box: { nested: [1] }, date: new Date(0), map: new Map([['a', 1]]), foreign };
  const args = detachMappedInput(input);
  args.box.nested.push(2);
  args.map.set('b', 2);
  args.date.setTime(10);
  expect(input.box.nested).toEqual([1]);
  expect([...input.map]).toEqual([['a', 1]]);
  expect(input.date.getTime()).toBe(0);
  expect(args.foreign).toBe(foreign);
});

it('samples every own getter once before its owner closes the view', () => {
  const symbol = Symbol('hidden');
  let open = true;
  let calls = 0;
  const read = () => {
    if (!open) throw new Error('closed view');
    calls++;
    return 7;
  };
  const input = Object.defineProperties(
    {},
    {
      visible: { get: read, enumerable: true },
      hidden: { get: read },
      [symbol]: { get: read },
    },
  );
  const args = detachMappedInput(input);
  open = false;
  expect([args.visible, args.hidden, args[symbol]]).toEqual([7, 7, 7]);
  expect(calls).toBe(3);
  expect(Object.getOwnPropertyDescriptor(args, 'hidden').enumerable).toBe(false);
});
