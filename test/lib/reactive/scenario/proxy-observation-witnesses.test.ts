/**
 * Executable witnesses for docs/design/2026-11-proxy-observations.md.
 *
 * These describe existing observations and their limits. They do not implement
 * typed presence/shape events, field-level source capture or semantic derivation.
 */
import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/lib/builder';
import type { TypedScope } from '../../../../src/lib/reactive/types';
import { FlowChartExecutor } from '../../../../src/lib/runner';
import type { ScopeRecorder } from '../../../../src/lib/scope/types';

interface State {
  count?: number;
  empty?: number;
  customer?: { address: { postcode: string } };
  items?: string[];
  present?: boolean;
  emptyPresent?: boolean;
  missingPresent?: boolean;
  copied?: number;
  listed?: string[];
  postcode?: string;
}

async function observe(operation: (scope: TypedScope<State>) => void) {
  const reads: Array<{ stageId: string; key: string | undefined }> = [];
  const writes: Array<{ stageId: string; key: string; operation: string }> = [];
  const recorder: ScopeRecorder = {
    id: 'observation-witness',
    onRead: ({ stageId, key }) => reads.push({ stageId, key }),
    onWrite: ({ stageId, key, operation: kind }) => writes.push({ stageId, key, operation: kind }),
  };
  const chart = flowChart<State>(
    'Seed',
    (scope) => {
      scope.count = 5;
      scope.empty = undefined;
      scope.customer = { address: { postcode: 'initial' } };
      scope.items = ['first', 'second'];
    },
    'seed',
  )
    .addFunction('Observe', operation, 'observe')
    .build();
  const executor = new FlowChartExecutor(chart, { writeProvenance: 'reads-prefix' });
  executor.attachScopeRecorder(recorder);
  await executor.run();
  const snapshot = executor.getSnapshot();
  const commit = snapshot.commitLog.find((bundle) => bundle.stageId === 'observe');
  expect(commit).toBeDefined();
  return {
    state: snapshot.sharedState as State,
    commit: commit!,
    reads: reads.filter((event) => event.stageId === 'observe'),
    writes: writes.filter((event) => event.stageId === 'observe'),
  };
}

describe('proxy observation design witnesses', () => {
  it('membership answers do not dispatch value-read events but enter the native read prefix', async () => {
    const result = await observe((scope) => {
      // Reflect.has exercises the same proxy membership trap as the `in` operator.
      scope.present = Reflect.has(scope, 'count');
      scope.emptyPresent = Reflect.has(scope, 'empty');
      scope.missingPresent = Reflect.has(scope, 'notSet');
      scope.copied = scope.count;
    });

    expect(result.state.present).toBe(true);
    // This is the current TypedScope contract, not JavaScript own-property proof:
    // hasKey returns false for both an undefined value and a never-set key.
    expect(result.state.emptyPresent).toBe(false);
    expect(result.state.missingPresent).toBe(false);
    expect(result.reads).toEqual([{ stageId: 'observe', key: 'count' }]);
    expect(result.commit.trace.find((entry) => entry.path === 'present')?.readKeys).toEqual(['count']);
    expect(result.commit.trace.find((entry) => entry.path === 'copied')?.readKeys).toEqual([
      'count',
      'empty',
      'notSet',
    ]);
  });

  it('listing keys does not dispatch value-read events although listed names enter read bookkeeping', async () => {
    const result = await observe((scope) => {
      scope.listed = Object.keys(scope);
    });

    expect(result.state.listed).toContain('count');
    expect(result.state.listed).not.toContain('$getValue');
    expect(result.reads).toEqual([]);
    expect(result.commit.trace.find((entry) => entry.path === 'listed')?.readKeys).toContain('count');
  });

  it('a nested field read records its root without claiming a separate field read', async () => {
    const result = await observe((scope) => {
      scope.postcode = scope.customer!.address.postcode;
    });

    expect(result.state.postcode).toBe('initial');
    expect(result.reads).toEqual([{ stageId: 'observe', key: 'customer' }]);
    expect(result.commit.trace.find((entry) => entry.path === 'postcode')?.readKeys).toEqual(['customer']);
  });

  it('a held nested handle reads its changed view without a new field-source observation', async () => {
    const result = await observe((scope) => {
      const address = scope.customer!.address;
      address.postcode = 'changed';
      scope.postcode = address.postcode;
    });

    expect(result.state.customer?.address.postcode).toBe('changed');
    expect(result.state.postcode).toBe('changed');
    expect(result.reads).toEqual([{ stageId: 'observe', key: 'customer' }]);
    expect(result.commit.trace.find((entry) => entry.path === 'postcode')?.readKeys).toEqual(['customer']);
  });

  it('array mutation methods use the root write funnel and retain the resulting array', async () => {
    const result = await observe((scope) => {
      const items = scope.items!;
      items.push('third');
      items.splice(0, 1);
      scope.copied = items.length;
    });

    expect(result.state.items).toEqual(['second', 'third']);
    expect(result.state.copied).toBe(2);
    expect(result.reads).toEqual([{ stageId: 'observe', key: 'items' }]);
    expect(result.writes.filter((event) => event.key === 'items')).toEqual([
      { stageId: 'observe', key: 'items', operation: 'set' },
      { stageId: 'observe', key: 'items', operation: 'set' },
    ]);
    expect(result.commit.trace.some((entry) => entry.path === 'items' && entry.verb === 'set')).toBe(true);
  });

  it('reserved runtime probes do not become tracked business reads', async () => {
    const result = await observe((scope) => {
      const runtimeView = scope as unknown as Record<string, unknown>;
      expect(runtimeView.then).toBeUndefined();
      expect(runtimeView.asymmetricMatch).toBeUndefined();
      expect(runtimeView.toJSON).toBeUndefined();
      scope.copied = 1;
    });

    expect(result.reads).toEqual([]);
    expect(result.commit.trace.find((entry) => entry.path === 'copied')?.readKeys).toEqual([]);
  });
});
