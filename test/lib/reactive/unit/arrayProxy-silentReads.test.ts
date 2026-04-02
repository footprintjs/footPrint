/**
 * Tests for array proxy silent reads — verifies that internal array operations
 * (length, iteration, has, spread) do NOT fire additional onRead events.
 *
 * The fix: array proxy's getCurrent() uses getValueSilent() instead of getValue(),
 * so only the initial property access fires one tracked onRead.
 *
 * Coverage: unit, boundary, scenario, property, security.
 */
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import type { TypedScope } from '../../../../src/lib/reactive/types';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import type { ReadEvent, Recorder } from '../../../../src/lib/scope/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function createReadCounter(id = 'test-counter'): Recorder & { reads: ReadEvent[] } {
  const reads: ReadEvent[] = [];
  return {
    id,
    reads,
    onRead(event: ReadEvent) {
      if (event.key) reads.push(event);
    },
  };
}

interface ArrayState {
  items: string[];
  numbers: number[];
  nested: { tags: string[] };
  result?: string;
  count?: number;
}

// ── Unit: single property access fires exactly 1 onRead ─────────────────────

describe('array proxy silent reads — unit', () => {
  it('scope.items.length fires exactly 1 onRead', async () => {
    const counter = createReadCounter();
    const chart = flowChart<ArrayState>(
      'Seed',
      (scope) => {
        scope.items = ['a', 'b', 'c'];
      },
      'seed',
    )
      .addFunction(
        'ReadLength',
        (scope) => {
          const len = scope.items.length;
          scope.count = len;
        },
        'read-length',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(counter);
    await executor.run();

    // ReadLength stage should fire exactly 1 onRead for 'items'
    const readLengthReads = counter.reads.filter((r) => r.stageName === 'ReadLength' && r.key === 'items');
    expect(readLengthReads).toHaveLength(1);
  });

  it('scope.items[0] fires exactly 1 onRead for items', async () => {
    const counter = createReadCounter();
    const chart = flowChart<ArrayState>(
      'Seed',
      (scope) => {
        scope.items = ['hello'];
      },
      'seed',
    )
      .addFunction(
        'ReadIndex',
        (scope) => {
          scope.result = scope.items[0];
        },
        'read-index',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(counter);
    await executor.run();

    const reads = counter.reads.filter((r) => r.stageName === 'ReadIndex' && r.key === 'items');
    expect(reads).toHaveLength(1);
  });
});

// ── Boundary: empty array, single-element, after mutation ───────────────────

describe('array proxy silent reads — boundary', () => {
  it('empty array: .length fires 1 onRead', async () => {
    const counter = createReadCounter();
    const chart = flowChart<ArrayState>(
      'Seed',
      (scope) => {
        scope.items = [];
      },
      'seed',
    )
      .addFunction(
        'ReadEmpty',
        (scope) => {
          scope.count = scope.items.length;
        },
        'read-empty',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(counter);
    await executor.run();

    const reads = counter.reads.filter((r) => r.stageName === 'ReadEmpty' && r.key === 'items');
    expect(reads).toHaveLength(1);
    expect(executor.getSnapshot().sharedState.count).toBe(0);
  });

  it('single-element array: iteration fires 1 onRead', async () => {
    const counter = createReadCounter();
    const chart = flowChart<ArrayState>(
      'Seed',
      (scope) => {
        scope.items = ['only'];
      },
      'seed',
    )
      .addFunction(
        'Iterate',
        (scope) => {
          const results: string[] = [];
          for (const item of scope.items) {
            results.push(item);
          }
          scope.result = results.join(',');
        },
        'iterate',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(counter);
    await executor.run();

    const reads = counter.reads.filter((r) => r.stageName === 'Iterate' && r.key === 'items');
    expect(reads).toHaveLength(1);
    expect(executor.getSnapshot().sharedState.result).toBe('only');
  });

  it('nested array (scope.nested.tags): iteration fires 1 onRead for parent key', async () => {
    const counter = createReadCounter();
    const chart = flowChart<ArrayState>(
      'Seed',
      (scope) => {
        scope.nested = { tags: ['a', 'b', 'c'] };
      },
      'seed',
    )
      .addFunction(
        'ReadNested',
        (scope) => {
          // scope.nested fires 1 onRead for 'nested'
          // .tags returns nested array proxy via createNestedProxy path
          // .map() uses getCurrent() which should be silent
          scope.result = scope.nested.tags.map((t) => t.toUpperCase()).join(',');
        },
        'read-nested',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(counter);
    await executor.run();

    // Only 1 onRead for 'nested' — the .tags access and .map() are silent
    const reads = counter.reads.filter((r) => r.stageName === 'ReadNested' && r.key === 'nested');
    expect(reads).toHaveLength(1);
    expect(executor.getSnapshot().sharedState.result).toBe('A,B,C');
  });

  it('after push mutation: re-access fires 1 onRead', async () => {
    const counter = createReadCounter();
    const chart = flowChart<ArrayState>(
      'Seed',
      (scope) => {
        scope.items = ['a'];
      },
      'seed',
    )
      .addFunction(
        'MutateThenRead',
        (scope) => {
          scope.items.push('b'); // mutation triggers setValue internally
          // After mutation, cache is invalidated. Next access creates new proxy.
          scope.count = scope.items.length;
        },
        'mutate-then-read',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(counter);
    await executor.run();

    // Two accesses to scope.items: one for .push(), one for .length after mutation
    // Each access to scope.items fires 1 onRead
    const reads = counter.reads.filter((r) => r.stageName === 'MutateThenRead' && r.key === 'items');
    expect(reads).toHaveLength(2);
    expect(executor.getSnapshot().sharedState.count).toBe(2);
  });
});

// ── Scenario: complex operations = still 1 onRead ──────────────────────────

describe('array proxy silent reads — scenario', () => {
  it('read + iterate + length + spread = 1 onRead', async () => {
    const counter = createReadCounter();
    const chart = flowChart<ArrayState>(
      'Seed',
      (scope) => {
        scope.items = ['x', 'y', 'z'];
      },
      'seed',
    )
      .addFunction(
        'ComplexRead',
        (scope) => {
          const arr = scope.items; // 1 onRead for 'items'
          const len = arr.length; // silent (getCurrent uses getValueSilent)
          const mapped = arr.map((x) => x.toUpperCase()); // silent
          const spread = [...arr]; // silent
          scope.result = `${len}:${mapped.join(',')}:${spread.length}`;
        },
        'complex-read',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(counter);
    await executor.run();

    const reads = counter.reads.filter((r) => r.stageName === 'ComplexRead' && r.key === 'items');
    expect(reads).toHaveLength(1);
    expect(executor.getSnapshot().sharedState.result).toBe('3:X,Y,Z:3');
  });

  it('truthiness check on array does not fire extra reads', async () => {
    const counter = createReadCounter();
    const chart = flowChart<ArrayState>(
      'Seed',
      (scope) => {
        scope.items = ['a'];
      },
      'seed',
    )
      .addFunction(
        'TruthinessCheck',
        (scope) => {
          const prepared = scope.items; // 1 onRead
          if (prepared) {
            // truthiness check on proxy — should NOT fire onRead
            scope.result = 'truthy';
          }
        },
        'truthiness',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(counter);
    await executor.run();

    const reads = counter.reads.filter((r) => r.stageName === 'TruthinessCheck' && r.key === 'items');
    expect(reads).toHaveLength(1);
  });
});

// ── Scenario (supplement): snapshot stageReads not inflated by array internals ──

describe('array proxy silent reads — snapshot', () => {
  it('map() over array does not inflate stageReads in snapshot', async () => {
    const chart = flowChart<ArrayState>(
      'Seed',
      (scope) => {
        scope.items = ['a', 'b', 'c'];
      },
      'seed',
    )
      .addFunction(
        'Process',
        (scope) => {
          // Access items (1 tracked read), then map (silent internals)
          const mapped = scope.items.map((x) => x.toUpperCase());
          const len = scope.items.length; // second access = second tracked read
          scope.result = `${len}:${mapped.join(',')}`;
        },
        'process',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    await executor.run();

    const snapshot = executor.getSnapshot();
    const processStage = snapshot.executionTree.next;
    expect(processStage?.name).toBe('Process');

    // stageReads should only have 'items' (one key), not inflated with
    // internal array ops from .map()/.length etc.
    if (processStage?.stageReads) {
      const readKeys = Object.keys(processStage.stageReads);
      expect(readKeys).toEqual(['items']);
    }
  });
});

// ── Property: for any array, map() fires exactly 1 onRead ──────────────────

describe('array proxy silent reads — property', () => {
  it('for any array of length N, map() fires 1 onRead', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer(), { minLength: 0, maxLength: 50 }), async (arr) => {
        let readCount = 0;
        const counter: Recorder = {
          id: 'prop-counter',
          onRead(event: ReadEvent) {
            if (event.key === 'numbers') readCount++;
          },
        };

        const chart = flowChart<ArrayState>(
          'Seed',
          (scope) => {
            scope.numbers = arr;
          },
          'seed',
        )
          .addFunction(
            'MapAll',
            (scope) => {
              scope.numbers.map((x) => x * 2);
            },
            'map-all',
          )
          .build();

        const executor = new FlowChartExecutor(chart);
        executor.attachRecorder(counter);
        await executor.run();

        // Exactly 1: Seed does scope.numbers = arr (write, no onRead).
        // MapAll does scope.numbers.map(...) (1 onRead). map() internals are silent.
        return readCount === 1;
      }),
      { numRuns: 20 },
    );
  });
});

// ── Security: recorder dispatch still shows [REDACTED] for redacted keys ─────

describe('array proxy silent reads — security', () => {
  it('redacted array key: recorder sees [REDACTED], not raw values', async () => {
    const counter = createReadCounter();

    const chart = flowChart<{ secrets: string[]; result?: string }>(
      'Seed',
      (scope) => {
        scope.$setValue('secrets', ['password123'], true); // mark as redacted
      },
      'seed',
    )
      .addFunction(
        'ReadSecrets',
        (scope) => {
          // Access the array — onRead should show [REDACTED]
          const items = scope.secrets;
          scope.result = items ? 'accessed' : 'not found';
        },
        'read-secrets',
      )
      .build();

    const executor = new FlowChartExecutor(chart);
    executor.attachRecorder(counter);
    await executor.run();

    // The tracked onRead should show [REDACTED] for the redacted key
    const secretReads = counter.reads.filter((r) => r.stageName === 'ReadSecrets' && r.key === 'secrets');
    expect(secretReads).toHaveLength(1);
    expect(secretReads[0].redacted).toBe(true);
    expect(secretReads[0].value).toBe('[REDACTED]');
  });
});
