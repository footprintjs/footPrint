/** Engine input ownership: the record freezer's unit laws now live in foottrace. */
import { flowChart, FlowChartExecutor } from '../../../src';
import { createFrozenArgs } from '../../../src/lib/scope/protection/readonlyInput';

it('regression: a class instance inside a frozen argument stays callable — and the caller’s object is not frozen', async () => {
  class Counter {
    n = 0;
    bump() {
      this.n++;
    }
  }
  const svc = new Counter();
  const chart = flowChart(
    'A',
    (s: any) => {
      svc.bump();
      s.x = 1;
    },
    'a',
  ).build();
  const executor = new FlowChartExecutor(chart);
  await executor.run({ input: { cfg: Object.freeze({ svc }) } });
  expect(svc.n).toBe(1);
  expect(Object.isFrozen(svc)).toBe(false);
  svc.bump(); // after the run, the caller's object is still the caller's
  expect(svc.n).toBe(2);
});

it('createFrozenArgs keeps its 9.32.0 contract: a shallow-frozen argument is not walked past; a typed array is skipped', () => {
  const lines = [{ sku: 'A' }];
  const order = Object.freeze({ lines });
  const args = createFrozenArgs({ order, plain: { n: 1 }, bytes: new Uint8Array([1]) }) as {
    order: typeof order;
    plain: { n: number };
  };
  expect(Object.isFrozen(args)).toBe(true);
  expect(Object.isFrozen(args.plain)).toBe(true);
  expect(Object.isFrozen(lines)).toBe(false);
});
