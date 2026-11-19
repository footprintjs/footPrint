import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as fc from 'fast-check';
import { expect, it } from 'vitest';

import { type RuntimeSnapshot, flowChart, FlowChartExecutor, readKeysOf } from '../../../src/index.js';

const selectedValue = 'SYNTHETIC_READ_VALUE_E7BD4C';
const markerShapedValue = { undefinedReadKeys: ['never-written'] };
const generatedKeys = ['count', '2', '17', 'user.note', '箱[0]', 'items/ready', 'has space'] as const;
const key = fc.constantFrom(...generatedKeys);
const operation = fc.record({
  reads: fc.array(key, { maxLength: 10 }),
  writes: fc.array(fc.tuple(key, fc.option(fc.integer(), { nil: undefined })), { maxLength: 6 }),
});
const operations = fc.array(operation, { minLength: 1, maxLength: 8 });
const firstReads = ['never-written', 'x', 'undefinedReadKeys', 'another-missing', 'selected', 'selected-missing', 'x'];

type Stage = RuntimeSnapshot['executionTree'];

function stagesOf(snapshot: RuntimeSnapshot): Stage[] {
  const stages: Stage[] = [];
  for (let stage: Stage | undefined = snapshot.executionTree; stage; stage = stage.next) stages.push(stage);
  return stages;
}

function readLists(snapshot: RuntimeSnapshot) {
  return stagesOf(snapshot).map((stage) => [stage.id, readKeysOf(stage)] as const);
}

function uniqueKeys(keys: readonly string[]): string[] {
  return [...new Set(keys)].sort();
}

function reopenSnapshot(path: string, snapshot: RuntimeSnapshot): RuntimeSnapshot {
  writeFileSync(path, JSON.stringify(snapshot), 'utf8');
  return JSON.parse(readFileSync(path, 'utf8'));
}

it.each(['full', 'summary', 'off'] as const)(
  'lists the same read keys for every stage after save and clone (%s)',
  async (readTracking) => {
    const dir = mkdtempSync(join(tmpdir(), 'footprint-stage-reads-'));
    const path = join(dir, 'snapshot.json');
    try {
      await fc.assert(
        fc.asyncProperty(operations, async (steps) => {
          const builder = flowChart(
            'Seed',
            (scope) => {
              scope.$setValue('x', 1);
              scope.$setValue('selected', selectedValue);
              scope.$setValue('undefinedReadKeys', markerShapedValue);
            },
            'seed',
          ).addFunction(
            'Read known and unset keys',
            (scope) => {
              for (const name of firstReads) scope.$getValue(name);
            },
            'first-reads',
          );
          for (const [index, step] of steps.entries()) {
            const id = `step-${index}`;
            builder.addFunction(
              id,
              (scope) => {
                for (const [name, value] of step.writes) {
                  if (value === undefined) scope.$delete(name);
                  else scope.$setValue(name, value);
                }
                for (const name of step.reads) scope.$getValue(name);
              },
              id,
            );
          }
          const executor = new FlowChartExecutor(builder.build(), { readTracking });
          executor.setRedactionPolicy({ keys: ['selected', 'selected-missing'] });
          await executor.run();

          const readsByStage: readonly (readonly [string, readonly string[]])[] = [
            ['seed', []],
            ['first-reads', firstReads],
            ...steps.map((step, index) => [`step-${index}`, step.reads] as const),
          ];
          const expected = readsByStage.map(([id, reads]) => [id, readTracking === 'off' ? [] : uniqueKeys(reads)]);

          const raw = executor.getSnapshot();
          const redacted = executor.getSnapshot({ redact: true });
          expect(JSON.stringify(redacted)).not.toContain(selectedValue);

          for (const snapshot of [raw, redacted]) {
            const live = readLists(snapshot);
            expect(live.map(([id, reads]) => [id, [...reads].sort()])).toEqual(expected);
            expect(readLists(reopenSnapshot(path, snapshot))).toEqual(live);
            expect(readLists(structuredClone(snapshot))).toEqual(live);

            const firstStage = snapshot.executionTree.next;
            expect(snapshot.executionTree).not.toHaveProperty('undefinedReadKeys');
            if (readTracking === 'off') {
              expect(firstStage).not.toHaveProperty('undefinedReadKeys');
            } else {
              expect([...(firstStage?.undefinedReadKeys ?? [])].sort()).toEqual(['another-missing', 'never-written']);
              expect(firstStage?.stageReads?.selected).toBe('[REDACTED]');
              expect(firstStage?.stageReads?.['selected-missing']).toBe('[REDACTED]');
            }
            if (readTracking === 'full') expect(firstStage?.stageReads?.undefinedReadKeys).toEqual(markerShapedValue);
          }
        }),
        { seed: 118_314, numRuns: 60 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

function deferred() {
  let complete: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
}

it('preserves the read keys of a snapshot taken before a suspended stage reads an unset key', async () => {
  const entered = deferred();
  const hold = deferred();
  const executor = new FlowChartExecutor(
    flowChart(
      'Read before and after the hold',
      async (scope) => {
        scope.$getValue('x');
        entered.resolve();
        await hold.promise;
        scope.$getValue('y');
      },
      'read',
    ).build(),
    { initialContext: { x: 1 } },
  );
  const dir = mkdtempSync(join(tmpdir(), 'footprint-stage-reads-'));
  const running = executor.run();
  try {
    await Promise.race([entered.promise, running]);
    const earlier = executor.getSnapshot();
    expect(readKeysOf(earlier.executionTree)).toEqual(['x']);

    hold.resolve();
    await running;
    expect(readKeysOf(executor.getSnapshot().executionTree)).toEqual(['x', 'y']);
    expect(readKeysOf(earlier.executionTree)).toEqual(['x']);
    expect(readKeysOf(reopenSnapshot(join(dir, 'snapshot.json'), earlier).executionTree)).toEqual(['x']);
  } finally {
    hold.resolve();
    await Promise.allSettled([running]);
    rmSync(dir, { recursive: true, force: true });
  }
});
