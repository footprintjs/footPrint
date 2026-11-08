import { expect, it } from 'vitest';

import { cutNativeCapture } from './cut.js';
import { NO_CLOSED_CAPTURE } from './record.js';
import { NativeClosureState } from './state.js';

it('latches before reentry and preserves exactly one refused result until an explicit new-leg reset', () => {
  const state = new NativeClosureState();
  const refusal = Object.freeze({ status: 'unknown', reason: 'pending-native-invocations' });
  let calls = 0;
  state.closeOnce(() => {
    calls++;
    expect(state.sealed).toBe(true);
    expect(state.result).toBe(NO_CLOSED_CAPTURE);
    state.closeOnce(() => {
      throw new Error('reentrant cut ran');
    });
    return refusal;
  });
  state.closeOnce(() => {
    throw new Error('second cut ran');
  });
  expect(calls).toBe(1);
  expect(state.result).toBe(refusal);
  state.reset();
  expect(state.sealed).toBe(false);
  expect(state.result).toBe(NO_CLOSED_CAPTURE);
  const next = Object.freeze({ status: 'unknown', reason: 'capture-unavailable' });
  state.closeOnce(() => next);
  expect(state.result).toBe(next);
});

it('keeps a throwing cut sealed without adding a broader catch or retry', () => {
  const state = new NativeClosureState();
  const original = Object.freeze({ failure: 'refusal getter' });
  let caught;
  try {
    state.closeOnce(() => {
      throw original;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(original);
  expect(state.sealed).toBe(true);
  expect(state.result).toBe(NO_CLOSED_CAPTURE);
  state.closeOnce(() => {
    throw new Error('retried');
  });
});

it('reads the refusal before any snapshot port and leaves refusal getter errors outside the copy catch', () => {
  const forbidden = new Proxy(
    {},
    {
      get() {
        throw new Error('port read');
      },
    },
  );
  expect(cutNativeCapture({ captureExtent: { closureRefusal: 'counter-saturated' } }, forbidden)).toEqual({
    status: 'unknown',
    reason: 'counter-saturated',
  });
  const original = Object.freeze({ failure: 'refusal getter' });
  const extent = {
    get closureRefusal() {
      throw original;
    },
  };
  let caught;
  try {
    cutNativeCapture({ captureExtent: extent }, forbidden);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(original);
});

it('keeps snapshot/copy failures unknown and preserves lazy initial/selected/budget read order', () => {
  const error = new Error('snapshot');
  expect(
    cutNativeCapture(
      {},
      {
        snapshot() {
          throw error;
        },
      },
    ),
  ).toEqual({ status: 'unknown', reason: 'evidence-refused' });
  const order = [];
  const result = cutNativeCapture(
    {},
    {
      snapshot() {
        order.push('snapshot');
        return { initialState: { a: 1 } };
      },
      initialState(value) {
        order.push('initial');
        return value;
      },
      selected() {
        order.push('selected');
        return undefined;
      },
      serve() {
        throw new Error('missing capture cannot serve');
      },
      maxBytes() {
        order.push('max');
        return 1024;
      },
    },
  );
  expect(order).toEqual(['snapshot', 'initial', 'selected', 'max']);
  expect(result).toEqual({ status: 'unknown', reason: 'capture-unavailable' });
  order.length = 0;
  cutNativeCapture(
    {},
    {
      snapshot() {
        order.push('snapshot');
        return {};
      },
      initialState() {
        throw new Error('initial state read while absent');
      },
      selected() {
        order.push('selected');
      },
      serve() {
        throw new Error('serve');
      },
      maxBytes() {
        order.push('max');
        return 1024;
      },
    },
  );
  expect(order).toEqual(['snapshot', 'selected', 'max']);
});
