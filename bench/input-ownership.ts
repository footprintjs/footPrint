/**
 * Input ownership cost, isolated from engine/recording work.
 * Run: npx tsx bench/input-ownership.ts
 * Measures the OLD in-place policy beside the current owned-container snapshot.
 * Each round starts with fresh input, outside the timer; the old policy freezes
 * its caller on first construction, making later scopes cheap at that cost.
 * No thresholds: these are measurements, not a timing-sensitive correctness test.
 */
import { deepFreeze } from '../src/lib/capture/freeze';
import { EventLog, SharedMemory, StageContext } from '../src/lib/memory';
import { createFrozenArgs } from '../src/lib/scope/protection/readonlyInput';
import { ScopeFacade } from '../src/lib/scope/ScopeFacade';
import { median } from './util';

const rows = (count: number) => Array.from({ length: count }, (_, id) => ({ id, amount: id * 3, label: `row-${id}` }));
const fixtures = [
  { name: 'small-10', make: () => ({ rows: rows(10) }) },
  { name: 'large-10000', make: () => ({ rows: rows(10_000) }) },
  {
    name: 'aliased-10000',
    make: () => {
      const shared = { amount: 1, label: 'same-node' };
      return { rows: Array.from({ length: 10_000 }, () => shared) };
    },
  },
  { name: 'borrowed-frozen-10000', make: () => ({ rows: Object.freeze(rows(10_000)) }) },
];
const policies = [
  { name: 'old-in-place', take: (input: object) => deepFreeze({ ...input }) },
  { name: 'owned-copy', take: createFrozenArgs },
];
let retained: unknown;

for (const fixture of fixtures) {
  for (const scopes of [1, 10, 100]) {
    for (const policy of policies) {
      const samples: number[] = [];
      for (let round = 0; round < 8; round++) {
        const input = fixture.make();
        const start = performance.now();
        for (let step = 0; step < scopes; step++) retained = policy.take(input);
        const elapsed = performance.now() - start;
        if (round >= 3) samples.push(elapsed);
      }
      console.log(`${fixture.name} / ${scopes} scopes / ${policy.name}: ${median(samples).toFixed(3)} ms`);
    }
  }
}

const ctx = new StageContext('bench', 'step', 'step', new SharedMemory(), '', new EventLog({}));
const scope = new ScopeFacade(ctx, 'step', { rows: rows(10_000) });
const cached = scope.getArgs();
const reads: number[] = [];
for (let round = 0; round < 8; round++) {
  const start = performance.now();
  for (let index = 0; index < 100_000; index++) retained = scope.getArgs();
  if (round >= 3) reads.push(performance.now() - start);
}
if (retained !== cached) throw new Error('getArgs lost its same-scope cache');
console.log(`100000 cached getArgs reads: ${median(reads).toFixed(3)} ms`);
