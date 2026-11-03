import { expect, it, vi } from 'vitest';

import { observeCallAnswer, readCallEvidence } from '../../../../src/lib/attempt/evidence.js';

it.each(['input', 'output'] as const)('bounds examined %s references even when none fit', (side) => {
  const list = Array.from({ length: 10_000 }, () => 'x'.repeat(201));
  const original = Object.getOwnPropertyDescriptor;
  let examined = 0;
  const read = vi.spyOn(Object, 'getOwnPropertyDescriptor').mockImplementation((object, key) => {
    if (object === list && key !== 'length') examined++;
    return original(object, key);
  });
  let result: unknown;
  try {
    result =
      side === 'input'
        ? readCallEvidence({ evidence: { inputRefs: list } }).input
        : observeCallAnswer(() => ({ outputRefs: list }), 'answer').data;
  } finally {
    read.mockRestore();
  }
  expect(examined).toBeLessThanOrEqual(32);
  expect(result).toEqual(
    side === 'input' ? { inputRefs: [], inputRefsOmitted: 10_000 } : { outputRefs: [], outputRefsOmitted: 10_000 },
  );
});

it.each(['input', 'output'] as const)('counts unexamined %s siblings as omitted', (side) => {
  const list = [...Array.from({ length: 31 }, () => 'x'.repeat(201)), 'kept', 'unexamined'];
  const result =
    side === 'input'
      ? readCallEvidence({ evidence: { inputRefs: list } }).input
      : observeCallAnswer(() => ({ outputRefs: list }), 'answer').data;
  expect(result).toEqual(
    side === 'input' ? { inputRefs: ['kept'], inputRefsOmitted: 32 } : { outputRefs: ['kept'], outputRefsOmitted: 32 },
  );
});
