/**
 * Pins the historical comparison's exception independently of production:
 * only the named metadata slot disappears; payload lookalikes and every other
 * byte survive, malformed metadata refuses, and real new metadata is present.
 */
import { describe, expect, it } from 'vitest';

import { type TypedScope, flowChart, FlowChartExecutor } from '../../../../src/index.js';
import type { EmitEvent } from '../../../../src/recorders.js';
import { withoutSubflowLogAddresses } from './source-position-byte-view.js';

const address = { logRunId: 'leg-1', drillPath: ['sub#1'] };

describe('historical source-position byte view', () => {
  it('removes only direct subflow treeContext metadata without changing payload bytes or the source', () => {
    const payload = {
      logAddress: address,
      sourcePosition: { ...address, runId: 'leg-1', committedThroughIdx: 0 },
      subflowResults: { fake: { treeContext: { logAddress: address } } },
    };
    const tree = {
      globalContext: payload,
      initialState: payload,
      history: [{ overwrite: payload }],
      logAddress: address,
    };
    const input = { sub: { output: payload, treeContext: tree }, 'sub#1': { output: payload, treeContext: tree } };
    const before = JSON.stringify(input);
    const expected = {
      sub: {
        output: payload,
        treeContext: { globalContext: payload, initialState: payload, history: [{ overwrite: payload }] },
      },
      'sub#1': {
        output: payload,
        treeContext: { globalContext: payload, initialState: payload, history: [{ overwrite: payload }] },
      },
    };
    expect(JSON.stringify(withoutSubflowLogAddresses(input))).toBe(JSON.stringify(expected));
    expect(JSON.stringify(input)).toBe(before);
    expect(JSON.stringify(withoutSubflowLogAddresses(expected))).toBe(JSON.stringify(expected));
  });

  it('handles the same named slot in lean checkpoint results without adding history or optional keys', () => {
    const lean = { sub: { treeContext: { globalContext: { amount: 4 }, logAddress: address } } };
    expect(JSON.stringify(withoutSubflowLogAddresses(lean))).toBe(
      '{"sub":{"treeContext":{"globalContext":{"amount":4}}}}',
    );
    expect(withoutSubflowLogAddresses(undefined)).toBeUndefined();
    expect(withoutSubflowLogAddresses(null)).toBeNull();
    expect(withoutSubflowLogAddresses({})).toEqual({});
  });

  it.each([
    undefined,
    null,
    {},
    { ...address, logRunId: '' },
    { ...address, logRunId: 1 },
    { ...address, drillPath: 'sub#1' },
    { ...address, drillPath: ['sub'] },
    { ...address, drillPath: [1] },
    { ...address, extra: true },
  ])('refuses malformed or widened metadata rather than hiding it: %j', (logAddress) => {
    expect(() => withoutSubflowLogAddresses({ sub: { treeContext: { logAddress } } })).toThrow(
      'Historical byte view: malformed or changed logAddress',
    );
  });

  it('keeps a metadata-named field outside treeContext even when it has the new shape', () => {
    const input = { sub: { logAddress: address, sourcePosition: address, treeContext: { value: 1 } } };
    expect(JSON.stringify(withoutSubflowLogAddresses(input))).toBe(JSON.stringify(input));
  });

  it('pins actual root, nested and emitted metadata separately from the historical projection', async () => {
    const events: EmitEvent[] = [];
    const inner = flowChart(
      'Inner',
      (scope: TypedScope<{ value: number }>) => {
        scope.$emit('inner.observed', { value: scope.value });
      },
      'inner',
    ).build();
    const chart = flowChart('Seed', () => undefined, 'seed')
      .addSubFlowChart('sub', inner, 'Sub', { inputMapper: () => ({ value: 4 }) })
      .build();
    const executor = new FlowChartExecutor(chart);
    executor.attachEmitRecorder({
      id: 'historical-position-witness',
      onEmit: (event) => {
        events.push(event);
      },
    });
    await executor.run();
    const snapshot = executor.getSnapshot();
    expect(snapshot.logAddress).toEqual({ logRunId: snapshot.runId, drillPath: [] });
    const nested = snapshot.subflowResults?.['sub#1'] as { treeContext: { logAddress: unknown } };
    expect(nested.treeContext.logAddress).toEqual({ logRunId: snapshot.runId, drillPath: ['sub#1'] });
    expect(events).toHaveLength(1);
    expect(events[0].sourcePosition).toEqual({
      runId: snapshot.runId,
      logRunId: snapshot.runId,
      drillPath: ['sub#1'],
      committedThroughIdx: 0,
    });
    expect(Object.isFrozen(events[0].sourcePosition)).toBe(true);
    const expected = structuredClone(snapshot.subflowResults) as Record<
      string,
      { treeContext: { logAddress?: unknown } }
    >;
    for (const result of Object.values(expected)) delete result.treeContext.logAddress;
    expect(JSON.stringify(withoutSubflowLogAddresses(snapshot.subflowResults))).toBe(JSON.stringify(expected));
    expect(nested.treeContext.logAddress).toBeDefined();
  });
});
