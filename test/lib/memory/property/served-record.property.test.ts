/**
 * Property — no reachable mutation of a served record changes what a later reader returns (9.44.2).
 *
 * A random run (test/helpers/valueKinds.ts · `cloneable` in `initialContext`, in two stages' writes and
 * through a subflow's merge-back) is read every way the record is read: the served log, the fold base,
 * `stateAt` at every commit, `commitValueAt` of every key at every commit, the cursor's last state,
 * the subflow's history and base. Then:
 *
 *   1. every ANSWER is vandalized (test/helpers/valueKinds.ts · `vandalize` — every method of every
 *      prototype, assignment, delete, defineProperty, writes through views, `transfer()`), and the same
 *      snapshot is asked again — the readers' memos included: the answers are unchanged;
 *   2. the commit log the snapshot serves is vandalized — the log and the fold base — and a FRESH
 *      snapshot is asked: the answers are unchanged. (A subflow's stored results are not a door of
 *      this release: the served-surface law, with the record-frame clean-up C3/C4.)
 *
 * Red before 9.44.2 at step 2 whenever the run holds a Date, a Map, a buffer … (the record froze them
 * but served them as they were). It writes and asks TOP-LEVEL keys only, so it does not reach the
 * `commitValueAt` memo (a nested key folded from a kept generation): served-record-doors pins that.
 */
import fc from 'fast-check';
import { commitValueAt, stateAt, timeTravel } from 'foottrace';

import type { CommitBundle } from '../../../../src';
import { flowChart, FlowChartExecutor, getSubtreeSnapshot } from '../../../../src';
import { cloneable, recordKey, vandalize } from '../../../helpers/valueKinds';

const write = fc.tuple(fc.constantFrom('a', 'b', 'c'), cloneable);
const program = fc.record({
  base: fc.dictionary(fc.constantFrom('a', 'd'), cloneable, { maxKeys: 2 }),
  first: fc.array(write, { minLength: 1, maxLength: 2 }),
  second: fc.array(write, { maxLength: 2 }),
  fromSub: cloneable,
});

type Program = {
  base: Record<string, unknown>;
  first: [string, unknown][];
  second: [string, unknown][];
  fromSub: unknown;
};

async function run(p: Program) {
  const inner = flowChart(
    'Inner',
    (scope: any) => {
      scope.$setValue('out', p.fromSub);
    },
    'inner',
  ).build();
  const chart = flowChart(
    'First',
    (scope: any) => {
      for (const [k, v] of p.first) scope.$setValue(k, v);
    },
    'first',
  )
    .addFunction(
      'Second',
      (scope: any) => {
        for (const [k, v] of p.second) scope.$setValue(k, v);
      },
      'second',
    )
    .addSubFlowChartNext('sub', inner, 'Sub', {
      inputMapper: () => ({}),
      outputMapper: (out: any) => ({ e: out.out }),
    })
    .build();
  const executor = new FlowChartExecutor(chart, { initialContext: structuredClone(p.base) });
  await executor.run();
  return executor;
}

/** Every answer the record gives, as objects a reader holds. */
function answersOf(snap: ReturnType<FlowChartExecutor['getSnapshot']>) {
  const log = snap.commitLog as CommitBundle[];
  const sub = getSubtreeSnapshot(snap, 'sub');
  const cursor = timeTravel(snap);
  return {
    log,
    base: snap.initialState,
    states: log.map((_, i) => stateAt(snap, i).state),
    values: ['a', 'b', 'c', 'd', 'e'].map((k) => log.map((_, i) => commitValueAt(log, i, k))),
    cursor: cursor.stateAt(cursor.stops[cursor.stops.length - 1]).state,
    sub: sub && [sub.history, sub.initialState],
  };
}

/**
 * Every answer keyed by VALUE, as the record law compares them (test/helpers/valueKinds.ts · recordKey),
 * never by `v8.serialize` bytes: those also encode how V8 happens to store a number — a small integer and
 * a heap number holding the same 0 serialize differently — and vandalizing one object can change that for
 * every later object of its shape (a hidden class's field generalized from double to tagged). CI hit
 * exactly that: equal answers, different bytes.
 */
const valueKey = (answers: unknown) => recordKey(answers, 'kind');

describe('property — no reachable mutation of a served record changes a later answer', () => {
  it('vandalized answers, then vandalized records: every later answer is the first', async () => {
    await fc.assert(
      fc.asyncProperty(program, async (p) => {
        const executor = await run(p as Program);
        const snap = executor.getSnapshot();
        const first = answersOf(snap);
        const expected = valueKey(first);

        // 1. the answers are the reader's own: editing them changes nothing asked again
        vandalize([first.states, first.values, first.cursor]);
        expect(valueKey(answersOf(snap))).toBe(expected);

        // 2. the commit log a snapshot serves: editing it changes nothing a fresh snapshot serves
        vandalize(snap.commitLog);
        vandalize(snap.initialState);
        expect(valueKey(answersOf(executor.getSnapshot()))).toBe(expected);
      }),
      { numRuns: 30 },
    );
  });
});
