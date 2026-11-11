/**
 * The other write doors: `Object.defineProperty`, `Object.setPrototypeOf` and
 * `Object.freeze` / `seal` / `preventExtensions`.
 *
 * A Proxy with no trap for these lets them through to the RAW object it stands
 * for. `Object.defineProperty(scope.obj, 'b', …)` then changed committed state
 * and the commit log had no row for it: the record missed a state change.
 *
 * The law (reactive/writeTraps.ts): no state change without a row. A define
 * that is exactly an assignment is recorded as one. Everything a row cannot
 * hold (special attributes, an accessor, a prototype, a lock) is refused.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { FlowChartExecutor } from '../../../../src/lib/runner';

type Probe = (s: any) => void;
const OPEN = { writable: true, enumerable: true, configurable: true } as const;

async function run(seed: Record<string, unknown>, probe: Probe) {
  const chart = flowChart<any>(
    'Seed',
    (s) => {
      for (const [key, value] of Object.entries(seed)) s[key] = value;
    },
    'seed',
  )
    .addFunction('Probe', probe, 'probe')
    .build();
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  const snapshot = executor.getSnapshot();
  const rows = (snapshot.commitLog.find((bundle) => bundle.stageId === 'probe')?.trace ?? []).map(
    (entry) => `${entry.verb} ${entry.path}`,
  );
  return { state: snapshot.sharedState as Record<string, any>, rows };
}

/** The message of what `act` throws, or 'did not throw'. */
function refusal(act: () => void): string {
  try {
    act();
    return 'did not throw';
  } catch (error) {
    return error instanceof TypeError ? error.message : `not a TypeError: ${String(error)}`;
  }
}

describe('reactive scenario -- the other write doors', () => {
  it('a define that is an assignment is recorded as one (nested object)', async () => {
    const { state, rows } = await run({ obj: { a: 1 } }, (s) => {
      Object.defineProperty(s.obj, 'b', { value: 2, ...OPEN });
    });
    expect(state.obj).toEqual({ a: 1, b: 2 });
    expect(rows).toEqual(['merge obj']);
  });

  it('a bare { value } define of an existing key is an assignment; of a new key it is refused', async () => {
    let message = '';
    const { state, rows } = await run({ obj: { a: 1 } }, (s) => {
      Object.defineProperty(s.obj, 'a', { value: 9 });
      message = refusal(() => Object.defineProperty(s.obj, 'c', { value: 1 }));
    });
    expect(state.obj).toEqual({ a: 9 });
    expect(rows).toEqual(['merge obj']);
    expect(message).toContain("Cannot define a property with special attributes on scope state ('c')");
  });

  it('Reflect.set with a scope value as the receiver lands as a recorded write', async () => {
    const { state, rows } = await run({ obj: { a: 1 } }, (s) => {
      Reflect.set({}, 'a', 5, s.obj);
    });
    expect(state.obj).toEqual({ a: 5 });
    expect(rows).toEqual(['merge obj']);
  });

  it('an accessor, a closed attribute, a prototype change and a lock are refused, and state does not move', async () => {
    const messages: string[] = [];
    const { state, rows } = await run({ obj: { a: 1 } }, (s) => {
      messages.push(
        refusal(() => Object.defineProperty(s.obj, 'g', { get: () => 1, enumerable: true, configurable: true })),
      );
      messages.push(refusal(() => Object.defineProperty(s.obj, 'h', { value: 1, ...OPEN, writable: false })));
      messages.push(refusal(() => Object.setPrototypeOf(s.obj, null)));
      messages.push(refusal(() => Object.freeze(s.obj)));
      messages.push(refusal(() => Object.seal(s.obj)));
      messages.push(refusal(() => Object.preventExtensions(s.obj)));
      // The object is still an ordinary, writable state value.
      s.obj.a = 2;
    });
    expect(messages).toEqual([
      expect.stringContaining('Cannot define a property with special attributes'),
      expect.stringContaining('Cannot define a property with special attributes'),
      expect.stringContaining('Cannot change the prototype of a value'),
      expect.stringContaining('Cannot freeze, seal or lock a value'),
      expect.stringContaining('Cannot freeze, seal or lock a value'),
      expect.stringContaining('Cannot freeze, seal or lock a value'),
    ]);
    expect(state.obj).toEqual({ a: 2 });
    expect(rows).toEqual(['merge obj']);
  });

  it('the scope itself: a define that is an assignment writes a state key; a lock is refused', async () => {
    const messages: string[] = [];
    const { state, rows } = await run({ a: 1 }, (s) => {
      Object.defineProperty(s, 'k', { value: 7, ...OPEN });
      messages.push(refusal(() => Object.defineProperty(s, 'closed', { value: 1 })));
      messages.push(refusal(() => Object.freeze(s)));
      messages.push(refusal(() => Object.setPrototypeOf(s, null)));
      messages.push(refusal(() => Object.defineProperty(s, '$getValue', { value: 1, ...OPEN })));
    });
    expect(state).toEqual({ a: 1, k: 7 });
    expect(rows).toEqual(['set k']);
    expect(messages[0]).toContain("('closed')");
    expect(messages[1]).toContain('Cannot freeze, seal or lock the scope');
    expect(messages[2]).toContain('Cannot change the prototype of the scope');
    expect(messages[3]).toContain('not a TypeError');
  });

  it('an array: a define on an index is a recorded write; a lock is refused', async () => {
    const messages: string[] = [];
    const { state, rows } = await run({ list: [1, 2] }, (s) => {
      Object.defineProperty(s.list, '0', { value: 9, ...OPEN });
      messages.push(refusal(() => Object.freeze(s.list)));
      messages.push(refusal(() => Object.defineProperty(s.list, 'extra', { value: 1, ...OPEN })));
    });
    expect(state.list).toEqual([9, 2]);
    expect(rows).toEqual(['set list']);
    expect(messages[0]).toContain('Cannot freeze, seal or lock an array');
    expect(messages[1]).toContain('Cannot define a property with special attributes');
  });

  it('an element inside an array: the define is recorded through the owning array', async () => {
    const { state, rows } = await run({ rows: [{ id: 1 }] }, (s) => {
      Object.defineProperty(s.rows[0], 'qty', { value: 3, ...OPEN });
    });
    expect(state.rows).toEqual([{ id: 1, qty: 3 }]);
    expect(rows).toEqual(['set rows']);
  });
});
