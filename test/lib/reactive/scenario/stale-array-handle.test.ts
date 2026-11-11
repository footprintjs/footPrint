/**
 * Regression: an array handle kept after its key stopped holding an array.
 *
 * A held array handle read the key's current value and used it as an array
 * with no check. After `scope.list = 'xy'` in the same stage, `held.push('z')`
 * spread the string and committed `["x","y","z"]`; after `delete scope.list`
 * it committed `["z"]`; `held.length` answered the string's length.
 *
 * THE RULE (`reactive/arrayTraps.ts · liveArray / writableArray`) is the one a
 * held object handle already follows (`liveView.ts · liveObject`):
 *
 *   - a READ answers from the key while it holds an array, and from the array
 *     the handle was made over once it does not;
 *   - a WRITE through a handle whose key holds no array is refused with a
 *     `TypeError` that names the key, and changes nothing.
 *
 * The second reader of this change found what refusing reads too would cost: a
 * plain read of an array member of a held OBJECT handle threw, while that
 * object's other fields and its JSON still answered. Those cases are pinned
 * below.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import { createArrayProxy } from '../../../../src/lib/reactive/arrayTraps';
import { FlowChartExecutor } from '../../../../src/lib/runner';

type State = Record<string, any>;

/** Seed, then one stage that holds a handle, changes state, and uses the handle. */
async function useHeld(hold: (s: State) => any, change: (s: State) => void, use: (held: any) => unknown) {
  let caught: unknown;
  let result: unknown;
  const chart = flowChart<State>(
    'Seed',
    (s) => {
      s.list = ['a', 'b'];
      s.order = { id: 7, lines: ['a'], meta: { tags: ['t'] } };
      s.rows = [{ tags: ['r0'] }, { tags: ['r1'] }];
    },
    'seed',
  )
    .addFunction(
      'Use',
      (s) => {
        const held = hold(s);
        change(s);
        try {
          result = use(held);
        } catch (error) {
          caught = error;
        }
      },
      'use',
    )
    .build();
  const ex = new FlowChartExecutor(chart);
  await ex.run();
  return { caught, result, state: ex.getSnapshot().sharedState };
}

const refusal = (name: string) =>
  `Cannot write through the array handle for '${name}': the key no longer holds an array. ` +
  'The handle still reads the array as it was. Read the key from the scope again to change it.';
const toString = (s: State) => {
  s.list = 'xy';
};

describe('reactive scenario -- an array handle whose key no longer holds an array', () => {
  const writes: [string, (held: any) => unknown][] = [
    ['push', (held) => held.push('z')],
    ['index write', (held) => (held[0] = 'q')],
    ['length write', (held) => (held.length = 0)],
    ['delete', (held) => delete held[0]],
    ['sort', (held) => held.sort()],
    ['defineProperty on an index', (held) => Object.defineProperty(held, '0', { value: 'q' })],
  ];
  for (const [label, use] of writes) {
    it(`${label} through the handle is refused and changes nothing, after a string replaced the array`, async () => {
      const { caught, state } = await useHeld((s) => s.list, toString, use);
      expect(caught).toBeInstanceOf(TypeError);
      expect((caught as Error).message).toBe(refusal('list'));
      expect(state.list).toBe('xy');
    });
  }

  const reads: [string, (held: any) => unknown, unknown][] = [
    ['length', (held) => held.length, 2],
    ['an index', (held) => held[1], 'b'],
    ['spread', (held) => [...held], ['a', 'b']],
    [
      'for…of',
      (held) => {
        const out = [];
        for (const item of held) out.push(item);
        return out;
      },
      ['a', 'b'],
    ],
    ['map', (held) => held.map((item: string) => item.toUpperCase()), ['A', 'B']],
    ['JSON.stringify', (held) => JSON.stringify(held), '["a","b"]'],
    ['Object.keys', (held) => Object.keys(held), ['0', '1']],
    ['Array.isArray', (held) => Array.isArray(held), true],
  ];
  for (const [label, use, expected] of reads) {
    it(`a read (${label}) answers from the array as it was, not from the string that replaced it`, async () => {
      const { caught, result, state } = await useHeld((s) => s.list, toString, use);
      expect(caught).toBeUndefined();
      expect(result).toEqual(expected);
      expect(state.list).toBe('xy');
    });
  }

  it('the items taken before the key was cleared can still be walked', async () => {
    const { caught, result, state } = await useHeld(
      (s) => s.list,
      (s) => {
        s.list = undefined;
      },
      (held) => held.join('+'),
    );
    expect(caught).toBeUndefined();
    expect(result).toBe('a+b');
    expect(state.list).toBeUndefined();
  });

  it('a write after the key was deleted is refused, and does not bring the key back', async () => {
    const { caught, state } = await useHeld(
      (s) => s.list,
      (s) => {
        delete s.list;
      },
      (held) => held.push('z'),
    );
    expect((caught as Error).message).toBe(refusal('list'));
    expect(state.list).toBeUndefined();
  });

  it('the refusal names a nested key and a key inside an array element', async () => {
    const nested = await useHeld(
      (s) => s.order.lines,
      (s) => {
        s.order.lines = 'xy';
      },
      (held) => held.push('z'),
    );
    expect((nested.caught as Error).message).toBe(refusal('order.lines'));
    expect(nested.state.order.lines).toBe('xy');

    const element = await useHeld(
      (s) => s.rows[0].tags,
      (s) => {
        s.rows[0].tags = { k: 1 };
      },
      (held) => held.push('z'),
    );
    expect((element.caught as Error).message).toBe(refusal('rows[0].tags'));
    expect(element.state.rows[0]).toEqual({ tags: { k: 1 } });
  });

  it('a handle whose key holds a NEW array reads and writes that array', async () => {
    const { caught, result, state } = await useHeld(
      (s) => s.list,
      (s) => {
        s.list = ['c'];
      },
      (held) => {
        held.push('z');
        return held.length;
      },
    );
    expect(caught).toBeUndefined();
    expect(result).toBe(2);
    expect(state.list).toEqual(['c', 'z']);
  });

  it('createArrayProxy without a name: the same rule, a message without a key', () => {
    let current: unknown = [1];
    const proxy = createArrayProxy(
      () => current as unknown[],
      (next) => {
        current = next;
      },
    );
    current = 'xy';
    expect(proxy.length).toBe(1);
    expect(() => proxy.push(3)).toThrow(
      new TypeError(
        'Cannot write through this array handle: its value is no longer an array. ' +
          'The handle still reads the array as it was. Read the key from the scope again to change it.',
      ),
    );
    expect(current).toBe('xy');
  });
});

describe('reactive scenario -- an array member of a held object whose path is gone', () => {
  // One object handle must answer its members the way its JSON does (liveView.ts).
  const gone: [string, (s: State) => void][] = [
    [
      'deleted',
      (s) => {
        delete s.order;
      },
    ],
    [
      'replaced by a string',
      (s) => {
        s.order = 'gone';
      },
    ],
  ];
  for (const [label, change] of gone) {
    it(`the object was ${label}: its array members read as they were, like its fields and its JSON`, async () => {
      const { caught, result } = await useHeld(
        (s) => s.order,
        change,
        (held) => ({
          id: held.id,
          kind: typeof held.lines,
          lines: [...held.lines],
          spread: JSON.stringify({ ...held }),
          entries: Object.entries(held).map(([key]) => key),
          deep: [...held.meta.tags],
          json: JSON.stringify(held),
        }),
      );
      expect(caught).toBeUndefined();
      expect(result).toEqual({
        id: 7,
        kind: 'object',
        lines: ['a'],
        spread: '{"id":7,"lines":["a"],"meta":{"tags":["t"]}}',
        entries: ['id', 'lines', 'meta'],
        deep: ['t'],
        json: '{"id":7,"lines":["a"],"meta":{"tags":["t"]}}',
      });
    });
  }

  it('an element whose array was emptied or shifted reads its array member as it was', async () => {
    const emptied = await useHeld(
      (s) => s.rows[0],
      (s) => {
        s.rows = [];
      },
      (held) => [[...held.tags], JSON.stringify({ ...held })],
    );
    expect(emptied.caught).toBeUndefined();
    expect(emptied.result).toEqual([['r0'], '{"tags":["r0"]}']);

    const shifted = await useHeld(
      (s) => s.rows[1],
      (s) => {
        s.rows.splice(0, 1);
      },
      (held) => [...held.tags],
    );
    expect(shifted.caught).toBeUndefined();
    expect(shifted.result).toEqual(['r1']);
  });

  it('a write through such a member is refused: there is no array at that path to change', async () => {
    const { caught, state } = await useHeld(
      (s) => s.order,
      (s) => {
        delete s.order;
      },
      (held) => held.lines.push('z'),
    );
    expect((caught as Error).message).toBe(refusal('order.lines'));
    expect(state.order).toBeUndefined();
  });
});
