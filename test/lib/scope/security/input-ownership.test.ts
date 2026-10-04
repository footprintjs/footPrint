import fc from 'fast-check';

import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { attachScopeMethods } from '../../../../src/lib/scope/providers/baseStateCompatible';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

function context() {
  return new StageContext('input-ownership', 'step', 'step', new SharedMemory(), '', new EventLog({}));
}

const scopeDoors = [
  { name: 'class', create: (input: unknown) => new ScopeFacade(context(), 'step', input) },
  { name: 'factory', create: (input: unknown) => attachScopeMethods({}, context(), 'step', input) },
];

describe.each(scopeDoors)('Input ownership: $name scope', ({ create }) => {
  it('owns frozen nested data without freezing the caller', () => {
    const input = { order: { lines: [{ quantity: 2 }] } };
    const scope = create(input);
    const args = scope.getArgs<typeof input>();

    expect(args).toEqual(input);
    expect(args.order).not.toBe(input.order);
    expect(args.order.lines).not.toBe(input.order.lines);
    expect(args.order.lines[0]).not.toBe(input.order.lines[0]);
    for (const value of [args, args.order, args.order.lines, args.order.lines[0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    for (const value of [input, input.order, input.order.lines, input.order.lines[0]]) {
      expect(Object.isFrozen(value)).toBe(false);
    }
    input.order.lines[0].quantity = 9;
    input.order.lines.push({ quantity: 4 });
    expect(args.order.lines).toEqual([{ quantity: 2 }]);
    expect(scope.getArgs()).toBe(args);
    expect(() => {
      args.order.lines[0].quantity = 5;
    }).toThrow(TypeError);
  });

  it('preserves aliases and closes cycles on the owned graph, including the root', () => {
    const shared: any = { value: 1 };
    const input: any = { left: shared, right: shared };
    input.self = input;
    shared.parent = input;
    shared.self = shared;
    const args = create(input).getArgs<typeof input>();

    expect(args.self).toBe(args);
    expect(args.left).toBe(args.right);
    expect(args.left).not.toBe(shared);
    expect(args.left.parent).toBe(args);
    expect(args.left.self).toBe(args.left);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(shared)).toBe(false);
  });

  it('preserves symbols, null prototypes, sparse arrays, expandos and non-enumerable nested data', () => {
    const symbol = Symbol('selection');
    const record = Object.create(null);
    record.value = { count: 1 };
    Object.defineProperty(record, 'hidden', { value: { count: 2 }, enumerable: false });
    const rows: any[] & { note?: object } = new Array(3);
    rows[2] = record;
    rows.note = { label: 'sparse' };
    const input = { rows, [symbol]: { count: 3 } };
    const args = create(input).getArgs<typeof input>();

    expect(args.rows).not.toBe(rows);
    expect(args.rows.length).toBe(3);
    expect(Object.hasOwn(args.rows, '0')).toBe(false);
    expect(Object.hasOwn(args.rows, '1')).toBe(false);
    expect(Object.getPrototypeOf(args.rows[2])).toBe(null);
    expect(args.rows[2].hidden).toEqual({ count: 2 });
    expect(Object.keys(args.rows[2])).toEqual(['value']);
    expect(Object.isFrozen(args.rows[2].hidden)).toBe(true);
    expect(Object.isFrozen(record.hidden)).toBe(false);
    expect(Object.isFrozen(args.rows.note)).toBe(true);
    expect(Object.isFrozen(rows.note)).toBe(false);
    expect(args[symbol]).not.toBe(input[symbol]);
    expect(Object.isFrozen(args[symbol])).toBe(true);
  });

  it('copies special own keys as data without changing prototypes', () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"data":{"__proto__":{"count":1},"constructor":{"count":2}}}',
    );
    const args = create(input).getArgs<typeof input>();
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(args.data)).toBe(Object.prototype);
    expect(Object.hasOwn(args, '__proto__')).toBe(true);
    expect(Object.hasOwn(args.data, '__proto__')).toBe(true);
    expect(args.data.__proto__).toEqual({ count: 1 });
    expect(args.data.__proto__).not.toBe(input.data.__proto__);
    expect(Object.isFrozen(input.__proto__)).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('materializes each owned accessor once and leaves caller descriptors untouched', () => {
    let reads = 0;
    let current = { count: 1 };
    const nested = {
      get value() {
        reads++;
        return current;
      },
    };
    const input = { nested };
    const args = create(input).getArgs<typeof input>();
    expect(reads).toBe(1);
    expect(Object.getOwnPropertyDescriptor(args.nested, 'value')?.get).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(nested, 'value')?.get).toBeTypeOf('function');
    current = { count: 9 };
    expect(args.nested.value.count).toBe(1);
    expect(args.nested.value.count).toBe(1);
    expect(reads).toBe(1);
    expect(Object.isFrozen(nested)).toBe(false);
  });

  it('captures all root spread values before reading nested accessors', () => {
    const input = {
      nested: {
        get trigger() {
          input.later = 2;
          return 1;
        },
      },
      later: 1,
    };
    const args = create(input).getArgs<typeof input>();
    expect(args.later).toBe(1);
    expect(args.nested.trigger).toBe(1);
    expect(input.later).toBe(2);
  });

  it('leaves every caller object untouched even if an input accessor throws', () => {
    const error = new Error('unavailable input');
    const before = { count: 1 };
    const broken = {
      get value(): never {
        throw error;
      },
    };
    const input = { before, broken };
    expect(() => create(input)).toThrow(error);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(before)).toBe(false);
    expect(Object.isFrozen(broken)).toBe(false);
  });

  it('keeps explicitly frozen wrappers as borrowed boundaries', () => {
    const live = { count: 0 };
    const wrapper = Object.freeze({ live });
    const args = create({ wrapper }).getArgs<{ wrapper: typeof wrapper }>();
    expect(args.wrapper).toBe(wrapper);
    expect(args.wrapper.live).toBe(live);
    args.wrapper.live.count++;
    expect(live.count).toBe(1);
    expect(Object.isFrozen(live)).toBe(false);
  });

  it('retains working live capabilities without freezing them', () => {
    class Counter {
      count = 0;
      increment() {
        return ++this.count;
      }
    }
    const controller = new AbortController();
    const service = new Counter();
    const fn = () => 42;
    const input = { service, fn, signal: controller.signal };
    const args = create(input).getArgs<typeof input>();
    expect(args.service).toBe(service);
    expect(args.fn).toBe(fn);
    expect(args.signal).toBe(controller.signal);
    expect(Object.isFrozen(service)).toBe(false);
    expect(Object.isFrozen(args.signal)).toBe(false);
    expect(args.service.increment()).toBe(1);
    expect(args.fn()).toBe(42);
    controller.abort('finished');
    expect(args.signal.aborted).toBe(true);
  });

  it('borrows array subclasses as capabilities instead of stripping their behavior', () => {
    class Rows extends Array<number> {
      #extra = 1;
      total() {
        return this.reduce((sum, value) => sum + value, this.#extra);
      }
    }
    const rows = new Rows(1, 2, 3);
    const args = create({ rows }).getArgs<{ rows: Rows }>();
    expect(args.rows).toBe(rows);
    expect(Object.isFrozen(rows)).toBe(false);
    expect(args.rows.total()).toBe(7);
    args.rows.push(4);
    expect(rows.total()).toBe(11);
  });

  it('preserves a null-prototype array as an owned array', () => {
    const rows = Object.setPrototypeOf([{ count: 1 }], null);
    const args = create({ rows }).getArgs<{ rows: typeof rows }>();
    expect(args.rows).not.toBe(rows);
    expect(Array.isArray(args.rows)).toBe(true);
    expect(Object.getPrototypeOf(args.rows)).toBe(null);
    expect(args.rows.length).toBe(1);
    expect(args.rows[0]).not.toBe(rows[0]);
    expect(Object.isFrozen(args.rows[0])).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(false);
  });

  it('does not pretend native internal slots are frozen data', () => {
    const input = {
      date: new Date(0),
      map: new Map([['value', 1]]),
      set: new Set([1]),
      buffer: new ArrayBuffer(2),
      bytes: new Uint8Array([1, 2]),
      pattern: /a/g,
    };
    const args = create(input).getArgs<typeof input>();
    for (const key of Object.keys(input) as (keyof typeof input)[]) {
      expect(args[key]).toBe(input[key]);
      expect(Object.isFrozen(args[key])).toBe(false);
    }
    args.date.setTime(1);
    args.map.set('value', 2);
    args.set.add(2);
    args.bytes[0] = 9;
    expect(args.pattern.exec('a')?.[0]).toBe('a');
    expect(input.date.getTime()).toBe(1);
    expect(input.map.get('value')).toBe(2);
    expect(input.set.has(2)).toBe(true);
    expect(input.bytes[0]).toBe(9);
  });

  it('keeps root spread semantics and guards non-enumerable input keys', () => {
    const input = Object.defineProperty({ visible: 1 }, 'hidden', { value: 2 });
    const scope = create(input);
    expect(scope.getArgs()).toEqual({ visible: 1 });
    expect(() => scope.setValue('hidden', 3)).toThrow('readonly input key "hidden"');
    const arrayScope = create([{ count: 1 }]);
    const args = arrayScope.getArgs<Record<string, unknown>>();
    expect(Array.isArray(args)).toBe(false);
    expect(Object.keys(args)).toEqual(['0']);
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(() => arrayScope.setValue('length', 2)).toThrow('readonly input key "length"');
  });

  it.each([null, undefined, false, 0, 'text', () => 1])(
    'normalizes non-object input to frozen empty args: %s',
    (input) => {
      const args = create(input).getArgs();
      expect(args).toEqual({});
      expect(Object.isFrozen(args)).toBe(true);
    },
  );

  it('captures fresh data for a new scope, never a stale input-identity cache', () => {
    const input = { item: { value: 1 } };
    const first = create(input).getArgs<typeof input>();
    input.item.value = 2;
    const second = create(input).getArgs<typeof input>();
    expect(first.item.value).toBe(1);
    expect(second.item.value).toBe(2);
    expect(first.item).not.toBe(second.item);
  });

  it('owns every ordinary node in generated JSON inputs while preserving values', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const input = { value };
        const args = create(input).getArgs<typeof input>();
        expect(args).toEqual(input);
        function check(source: any, copy: any) {
          if (!source || typeof source !== 'object') return;
          expect(copy).not.toBe(source);
          expect(Object.isFrozen(copy)).toBe(true);
          expect(Object.isFrozen(source)).toBe(false);
          for (const key of Object.keys(source)) check(source[key], copy[key]);
        }
        check(input, args);
      }),
      { seed: 41004, numRuns: 150 },
    );
  });
});
