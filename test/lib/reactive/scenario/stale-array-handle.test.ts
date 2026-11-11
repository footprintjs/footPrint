/**
 * Regression: an array handle kept after its key stopped holding an array.
 *
 * A held array handle read the key's current value and used it as an array
 * with no check. After `scope.list = 'xy'` in the same stage, `held.push('z')`
 * spread the string and committed `["x","y","z"]`; after `delete scope.list`
 * it committed `["z"]`; `held.length` answered the string's length. Every use
 * of such a handle now throws a `TypeError` that names the key
 * (`reactive/arrayTraps.ts · checkedRead`).
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { createArrayProxy } from '../../../../src/lib/reactive/arrayTraps';
import { FlowChartExecutor } from '../../../../src/lib/runner';

type State = Record<string, any>;

/** Seed, then one stage that holds a handle, replaces its value, and uses the handle. */
async function useStale(hold: (s: State) => any, replace: (s: State) => void, use: (held: any) => unknown) {
  let caught: unknown;
  const chart = flowChart<State>(
    'Seed',
    (s) => {
      s.list = ['a'];
      s.order = { lines: ['a'] };
      s.rows = [{ tags: ['a'] }];
    },
    'seed',
  )
    .addFunction(
      'Use',
      (s) => {
        const held = hold(s);
        replace(s);
        try {
          use(held);
        } catch (error) {
          caught = error;
        }
      },
      'use',
    )
    .build();
  const ex = new FlowChartExecutor(chart);
  await ex.run();
  return { caught, state: ex.getSnapshot().sharedState };
}

const message = (name: string) =>
  `Cannot use the array handle for '${name}': the key no longer holds an array. ` +
  'A handle reads its key as it is now. Copy the array before the key changes if you still need it, or read the key again.';

describe('reactive scenario -- an array handle whose key no longer holds an array', () => {
  const uses: [string, (held: any) => unknown][] = [
    ['push', (held) => held.push('z')],
    ['index write', (held) => (held[0] = 'q')],
    ['length write', (held) => (held.length = 0)],
    ['delete', (held) => delete held[0]],
    ['length read', (held) => held.length],
    ['index read', (held) => held[0]],
  ];

  for (const [label, use] of uses) {
    it(`${label} through the handle throws and changes nothing, after a string replaced the array`, async () => {
      const { caught, state } = await useStale(
        (s) => s.list,
        (s) => {
          s.list = 'xy';
        },
        use,
      );
      expect(caught).toBeInstanceOf(TypeError);
      expect((caught as Error).message).toBe(message('list'));
      expect(state.list).toBe('xy');
    });
  }

  it('throws after the key was deleted, and does not bring it back as a new array', async () => {
    const { caught, state } = await useStale(
      (s) => s.list,
      (s) => {
        delete s.list;
      },
      (held) => held.push('z'),
    );
    expect((caught as Error).message).toBe(message('list'));
    expect(state.list).toBeUndefined();
  });

  it('names a nested key and a key inside an array element', async () => {
    const nested = await useStale(
      (s) => s.order.lines,
      (s) => {
        s.order.lines = 'xy';
      },
      (held) => held.push('z'),
    );
    expect((nested.caught as Error).message).toBe(message('order.lines'));
    expect(nested.state.order).toEqual({ lines: 'xy' });

    const element = await useStale(
      (s) => s.rows[0].tags,
      (s) => {
        s.rows[0].tags = { k: 1 };
      },
      (held) => held.push('z'),
    );
    expect((element.caught as Error).message).toBe(message('rows[0].tags'));
    expect(element.state.rows).toEqual([{ tags: { k: 1 } }]);
  });

  it('a handle still holding an array keeps working', async () => {
    const { caught, state } = await useStale(
      (s) => s.list,
      (s) => {
        s.list = ['b'];
      },
      (held) => held.push('z'),
    );
    expect(caught).toBeUndefined();
    expect(state.list).toEqual(['b', 'z']);
  });

  it('createArrayProxy without a name says the handle no longer holds an array', () => {
    let current: unknown = [1];
    const proxy = createArrayProxy(
      () => current as unknown[],
      (next) => {
        current = next;
      },
    );
    current = 'xy';
    expect(() => proxy.push(3)).toThrow(
      new TypeError(
        'Cannot use this array handle: its value is no longer an array. ' +
          'A handle reads its key as it is now. Copy the array before the key changes if you still need it, or read the key again.',
      ),
    );
    expect(current).toBe('xy');
  });
});
