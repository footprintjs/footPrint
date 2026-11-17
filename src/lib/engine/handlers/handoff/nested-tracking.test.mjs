import { normaliseStateKey } from 'foottrace/paths';
import { describe, expect, it } from 'vitest';
import { flowChart, FlowChartExecutor, interrupt } from '../../../../index.ts';
import { subflowCapture } from '../../../../subflow-capture.ts';
import { derivePolicy } from '../../../memory/runPolicy.ts';

function chart() {
  const child = flowChart(
    'Child',
    (scope) => {
      scope.answer = scope.seed * 2;
    },
    'child',
  ).build();
  const branch = flowChart(
    'Item',
    (scope) => {
      scope.answer = scope.item * 2;
    },
    'item',
  ).build();
  return flowChart(
    'Seed',
    (scope) => {
      scope.source = { value: 7 };
      scope.items = [3, 1];
    },
    'seed',
  )
    .addFunction(
      'Read nested',
      (scope) => {
        scope.amount = scope.source.value;
      },
      'read',
    )
    .addSubFlowChartNext('mount', child, 'Mount', { inputMapper: (parent) => ({ seed: parent.amount }) })
    .addParallelForEach('Fan', 'fan', {
      items: (scope) => scope.items,
      branch: () => branch,
      into: 'answers',
      maxBranches: 3,
    })
    .build();
}

describe('nested read tracking and optional capture compose', () => {
  for (const nestedReadTracking of [false, true]) {
    it(`preserves both real native records with nestedReadTracking=${nestedReadTracking}`, async () => {
      const executor = new FlowChartExecutor(chart(), {
        nestedReadTracking,
        writeProvenance: 'reads-prefix',
        ...subflowCapture({ input: true, fanout: true }),
      });
      await executor.run();
      const snapshot = executor.getSnapshot();
      expect(snapshot.nestedReadTracking).toBe(nestedReadTracking || undefined);
      expect(snapshot.sharedState.amount).toBe(7);
      expect(snapshot.subflowResults.mount.treeContext.globalContext.answer).toBe(14);
      expect(snapshot.subflowResults.mount.inputHandoff.writes).toEqual([{ path: 'seed', reads: ['amount'] }]);
      expect(snapshot.sharedState.answers.map((item) => item.answer)).toEqual([6, 2]);
      expect(snapshot.fanoutCollections.collections).toHaveLength(1);
      expect(snapshot.fanoutCollections.collections[0].slots.map((slot) => slot.index)).toEqual([0, 1]);
      const read = snapshot.commitLog
        .find((bundle) => bundle.stageId === 'read')
        .trace.find((row) => row.path === 'amount');
      expect(read.readKeys).toEqual(
        nestedReadTracking ? ['source', normaliseStateKey(['source', 'value'])] : ['source'],
      );
    });
  }

  for (const offered of [{}, subflowCapture({ input: false, fanout: false })]) {
    it(`does not infer capture authority from nested tracking (${
      Object.keys(offered).length
    } offered fields)`, async () => {
      const executor = new FlowChartExecutor(chart(), { nestedReadTracking: true, ...offered });
      await executor.run();
      const snapshot = executor.getSnapshot();
      expect(snapshot.nestedReadTracking).toBe(true);
      expect(snapshot.sharedState.answers.map((item) => item.answer)).toEqual([6, 2]);
      expect(snapshot.subflowResults.mount).not.toHaveProperty('inputHandoff');
      expect(snapshot).not.toHaveProperty('fanoutCollections');
      expect(snapshot).not.toHaveProperty('subflowCapture');
    });
  }

  for (const redact of [false, true]) {
    it(`keeps private capture authority across derived policies and privacy=${redact}`, async () => {
      const built = chart();
      const original = built.scopeFactory;
      const executor = new FlowChartExecutor(built, {
        nestedReadTracking: true,
        ...subflowCapture({ input: true, fanout: true }),
        scopeFactory(context, ...args) {
          context.usePolicy(derivePolicy(context.getPolicy(), { readTracking: 'off' }));
          const rule = context.getPolicy().redaction;
          if (rule) context.useRedactionRule(rule);
          return original(context, ...args);
        },
      });
      if (redact) executor.setRedactionPolicy({ keys: ['amount'] });
      await executor.run();
      const snapshot = executor.getSnapshot();
      expect(snapshot.nestedReadTracking).toBe(true);
      expect(snapshot.fanoutCollections).toBeDefined();
      const handoff = snapshot.subflowResults.mount.inputHandoff;
      expect(handoff).toBeDefined();
      expect(handoff.writes[0].reads).toEqual(redact ? [] : ['amount']);
      if (redact) expect(handoff.limitations).toContain('privacy-active');
      expect(snapshot.subflowResults.mount.treeContext.globalContext.answer).toBe(14);
      const safe = executor.getSnapshot({ redact: true });
      expect(safe.nestedReadTracking).toBe(true);
      expect(safe.fanoutCollections.collections[0].slots).toEqual([]);
      expect(safe.fanoutCollections.collections[0].limitations).toContain('privacy-active');
    });
  }

  it('keeps the nested encoding while resetting capture on same-executor resume', async () => {
    const branch = flowChart(
      'Item',
      (scope) => {
        scope.answer = scope.item;
      },
      'item',
    ).build();
    const built = flowChart(
      'Seed',
      (scope) => {
        scope.items = [1];
      },
      'seed',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (scope) => scope.items,
        branch: () => branch,
        into: 'answers',
        maxBranches: 2,
      })
      .addFunction('Pause', (scope) => interrupt(scope, { question: 'continue' }), 'pause')
      .build();
    const options = subflowCapture({ input: true, fanout: true });
    const executor = new FlowChartExecutor(built, { nestedReadTracking: true, ...options });
    await executor.run();
    const held = executor.getSnapshot();
    expect(held.nestedReadTracking).toBe(true);
    expect(held.fanoutCollections.collections).toHaveLength(1);
    const checkpoint = executor.getCheckpoint();
    expect(checkpoint).toBeDefined();
    expect(JSON.stringify(checkpoint)).not.toContain('subflowCapture');
    await executor.resume(checkpoint, { answer: 'yes' });
    expect(executor.getSnapshot().nestedReadTracking).toBe(true);
    expect(executor.getSnapshot()).not.toHaveProperty('fanoutCollections');
    expect(held.fanoutCollections.collections).toHaveLength(1);
    expect(executor.getCheckpoint()).toBeUndefined();
  });

  it('refuses forged capture before setup even when nested tracking is enabled', () => {
    let touched = 0;
    expect(
      () =>
        new FlowChartExecutor(chart(), {
          nestedReadTracking: true,
          captureInputHandoff: true,
          captureFanoutHandoff: true,
          subflowCapture: {},
          get initialContext() {
            touched++;
            return {};
          },
        }),
    ).toThrow(/Invalid subflow capture configuration/);
    expect(touched).toBe(0);
  });
});
