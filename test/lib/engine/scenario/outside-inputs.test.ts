import { createHash } from 'node:crypto';

import {
  causalChain,
  formatCausalChain,
  isCommitBundle,
  keysReadFromExecutionTree,
  sliceForKey,
  sliceToJSON,
} from 'foottrace';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeSnapshot } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { stableJSON } from './redaction-no-policy-fixture.js';

type Encoding = 'full' | 'delta';

interface QuoteState {
  config: number;
  history: string[];
  quote: number;
  decision: boolean;
  privateValue?: string;
}

interface PrivateData {
  payload: string;
  error: string;
  reference: string;
  idempotencyKey: string;
  privateValue: string;
}

function quoteChart(sources: readonly string[] = [], privateData?: PrivateData) {
  const builder = flowChart<QuoteState>(
    'Seed',
    (scope) => {
      scope.config = 4;
      scope.history = ['started'];
    },
    'seed',
  ).addFunction(
    'Quote',
    async (scope) => {
      const config = scope.config;
      let amount = 1;
      if (privateData) {
        const answer = await scope.$call(
          'quote.service',
          () => ({ amount: 1, payload: privateData.payload }),
          undefined,
          {
            touches: 'quotes',
            idempotencyKey: privateData.idempotencyKey,
            evidence: { observe: () => ({ outputRefs: [privateData.reference] }) },
          },
        );
        amount = answer.amount;
        await scope.$call('quote.service', () => 2);
        try {
          await scope.$call('risk.service', () => {
            throw new Error(privateData.error);
          });
        } catch {
          // The engine recorded the failure. The stage kept its fallback quote.
        }
        scope.privateValue = privateData.privateValue;
      }
      scope.quote = config + amount;
      scope.history = ['started', 'quoted'];
    },
    'quote',
  );
  if (sources.length > 0) builder.outside(...sources);
  return builder
    .addFunction(
      'Decide',
      (scope) => {
        scope.decision = scope.quote === 5;
      },
      'decide',
    )
    .build();
}

async function record(chart: ReturnType<typeof quoteChart>, commitValues: Encoding, redact = false) {
  const executor = new FlowChartExecutor(chart, { commitValues, writeProvenance: 'reads-prefix' });
  if (redact) executor.setRedactionPolicy({ keys: ['privateValue'] });
  await executor.run();
  return executor.getSnapshot(redact ? { redact: true } : undefined);
}

function saved(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return JSON.parse(JSON.stringify(snapshot));
}

function backward(snapshot: RuntimeSnapshot) {
  const reads = keysReadFromExecutionTree(snapshot.executionTree);
  const walk = causalChain(snapshot.commitLog, 'decide#2', reads.lookup)!;
  const slice = sliceToJSON(sliceForKey(snapshot.commitLog, 'decision', reads));
  return { walk, slice, text: formatCausalChain(walk) };
}

// This projection skips only volatile run metadata, as the declared-tags byte fixture does.
function defaultBytes(chart: ReturnType<typeof quoteChart>, snapshot: RuntimeSnapshot): string {
  return stableJSON({
    spec: chart.buildTimeStructure,
    commitLog: snapshot.commitLog,
    executionTree: snapshot.executionTree,
    sharedState: snapshot.sharedState,
    backward: backward(snapshot),
  });
}

// From engine 2b5e919a2c8e with its lockfile Foottrace 2.2.0.
const defaultHashes = {
  full: '0075ee5e5d5a02fe9d9274ddf8ec8a432e62bc43fddc4db38dac9a247c8ea617',
  delta: '091c4980e4b1f058583b9e2a1e7334d75c94938369761eb77934130d7c303cd4',
};

describe.each(['full', 'delta'] as const)('engine outside-input evidence with %s commit values', (encoding) => {
  it('preserves engine and reader bytes for a chart with no outside inputs', async () => {
    const chart = quoteChart();
    const live = await record(chart, encoding);
    const original = defaultBytes(chart, live);
    expect(original).not.toContain('"outsideInputs"');
    expect(createHash('sha256').update(original).digest('hex')).toBe(defaultHashes[encoding]);
    expect(defaultBytes(chart, saved(live))).toBe(original);
  });

  it('carries declared names from the spec to the live and saved backward walk', async () => {
    const chart = quoteChart(['clock', 'calendar']);
    expect(chart.buildTimeStructure.next?.outsideInputs).toEqual(['clock', 'calendar']);
    const live = await record(chart, encoding);
    const [seed, quote, decide] = live.commitLog;
    expect(quote.outsideInputs).toEqual({ declared: ['clock', 'calendar'] });
    expect(quote.trace.find(({ path }) => path === 'history')?.verb).toBe(encoding === 'full' ? 'set' : 'append');
    expect([seed, decide].every((bundle) => !Object.hasOwn(bundle, 'outsideInputs'))).toBe(true);
    expect(live.sharedState.decision).toBe(true);

    const evidence = backward(live);
    expect(evidence.walk.parents[0]).toMatchObject({
      runtimeStageId: 'quote#1',
      outsideInputs: { declared: ['clock', 'calendar'] },
      parentEdges: [{ kind: 'data', key: 'config', parent: { runtimeStageId: 'seed#0' } }],
    });
    expect(evidence.slice.nodes?.['quote#1']?.outsideInputs).toEqual({ declared: ['clock', 'calendar'] });
    expect(evidence.text).toMatch(/outside: clock[^\n]*incomplete/i);
    expect(JSON.stringify(backward(saved(live)))).toBe(JSON.stringify(evidence));
  });

  it('records distinct admitted call targets for repeat successes and a caught failure without serving private data', async () => {
    const runPrivate = (variant: string) => {
      const privateData = {
        payload: `private-answer-${variant}`,
        error: `private-error-${variant}`,
        reference: `private-ref-${variant}`,
        idempotencyKey: `private-key-${variant}`,
        privateValue: `private-value-${variant}`,
      };
      return record(quoteChart(['clock'], privateData), encoding, true);
    };
    const [left, right] = await Promise.all([runPrivate('left'), runPrivate('right')]);
    const [quote] = left.commitLog.filter(({ stageId }) => stageId === 'quote');
    const callFacts = left.executionTree?.next?.attempts?.map(({ kind, target, outcome }) => [kind, target, outcome]);
    expect(callFacts).toEqual([
      ['call', 'quote.service', 'ok'],
      ['call', 'quote.service', 'ok'],
      ['call', 'risk.service', 'failed'],
    ]);
    const outsideInputs = { declared: ['clock'], call: { targets: ['quote.service', 'risk.service'] } };
    expect(quote.outsideInputs).toEqual(outsideInputs);
    expect(quote.redactedPaths).toContain('privateValue');
    expect(quote.trace.find(({ path }) => path === 'quote')?.readAttempts).toEqual(['quote#1@1.1@1', 'quote#1@1.2@1']);
    expect(left.sharedState.decision).toBe(true);
    const leftView = backward(left);
    expect(leftView.slice.nodes?.['quote#1']?.outsideInputs).toEqual(outsideInputs);
    expect(leftView.text.match(/quote\.service/g)).toHaveLength(1);
    expect(leftView.text).toContain('risk.service');
    const leftBytes = JSON.stringify(leftView);
    for (const snapshot of [saved(left), right, saved(right)])
      expect(JSON.stringify(backward(snapshot))).toBe(leftBytes);
    expect(leftBytes).not.toMatch(/private-(?:answer|error|ref|key|value)-/);
  });
});

it('an SDK report and a native call refused before invocation do not mark a commit', async () => {
  const refused = vi.fn(() => 1);
  const chart = flowChart<QuoteState>(
    'Quote',
    async (scope) => {
      scope.$attempt().observed({ target: 'sdk.service', outcome: 'ok', durationMs: 1 });
      try {
        await scope.$call('refused\nservice', refused);
      } catch {
        // Invalid public target. The native callback did not start.
      }
      scope.quote = 5;
    },
    'quote',
  ).build();
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  const snapshot = executor.getSnapshot();
  expect(refused).not.toHaveBeenCalled();
  expect(snapshot.executionTree?.attempts).toMatchObject([{ kind: 'observed', target: 'sdk.service' }]);
  expect(snapshot.commitLog[0]).not.toHaveProperty('outsideInputs');
  expect(snapshot.sharedState.quote).toBe(5);
});

it('keeps lazy subflow, mount, and mount-exit evidence at their own log positions', async () => {
  const child = flowChart<QuoteState>(
    'Inner quote',
    async (scope) => {
      scope.quote = await scope.$call('quote.service', () => 5);
    },
    'inner-quote',
  )
    .outside('child-clock')
    .build();
  const chart = flowChart<QuoteState>('Seed', () => undefined, 'seed')
    .addLazySubFlowChartNext('mount', () => child, 'Mount', {
      outsideInputs: ['mount-configuration'],
      outputMapper: (output: QuoteState) => ({ quote: output.quote }),
    })
    .addFunction(
      'Decide',
      (scope) => {
        scope.decision = scope.quote === 5;
      },
      'decide',
    )
    .build();
  const executor = new FlowChartExecutor(chart);
  await executor.run();
  const snapshot = executor.getSnapshot();
  const mounts = snapshot.commitLog.filter(({ stageId }) => stageId === 'mount');
  expect(mounts.map(({ phase, outsideInputs }) => [phase, outsideInputs])).toEqual([
    [undefined, { declared: ['mount-configuration'] }],
    ['exit', undefined],
  ]);
  expect(mounts[1]).not.toHaveProperty('outsideInputs');
  expect(mounts[1].runtimeStageId).toBe(mounts[0].runtimeStageId);
  const childLog = executor.getSubflowResults().get('mount')?.treeContext.history;
  expect(childLog?.filter(isCommitBundle).filter(({ outsideInputs }) => outsideInputs !== undefined)).toMatchObject([
    {
      stageId: 'mount/inner-quote',
      outsideInputs: { declared: ['child-clock'], call: { targets: ['quote.service'] } },
    },
  ]);
  const stored = saved(snapshot);
  const parent = sliceToJSON(
    sliceForKey(stored.commitLog, 'decision', keysReadFromExecutionTree(stored.executionTree)),
  );
  expect(parent.nodes?.[mounts[0].runtimeStageId]?.outsideInputs).toEqual({ declared: ['mount-configuration'] });
  expect(JSON.stringify(parent)).not.toMatch(/child-clock|quote\.service/);
});

it('records outside inputs separately for pause and a JSON checkpoint resumed on a fresh executor', async () => {
  const chart = flowChart<QuoteState>('Seed', () => undefined, 'seed')
    .addPausableFunction(
      'Gate',
      {
        execute: () => ({ question: 'Approve?' }),
        resume: async (scope, input) => {
          scope.decision = await scope.$call('review.service', () => input === true);
        },
      },
      'gate',
    )
    .outside('calendar')
    .build();
  const before = new FlowChartExecutor(chart);
  await before.run();
  const checkpoint = JSON.stringify(before.getCheckpoint());
  expect(checkpoint).not.toContain('"outsideInputs"');
  const paused = before.getSnapshot().commitLog.find(({ stageId }) => stageId === 'gate')!;
  expect(paused.outsideInputs).toEqual({ declared: ['calendar'] });
  expect(paused.trace).toEqual([]);

  const after = new FlowChartExecutor(chart);
  await after.resume(JSON.parse(checkpoint), true);
  const resumed = saved(after.getSnapshot());
  const { root } = sliceForKey(resumed.commitLog, 'decision', keysReadFromExecutionTree(resumed.executionTree));
  expect(resumed.sharedState.decision).toBe(true);
  expect(root?.runtimeStageId).not.toBe(paused.runtimeStageId);
  expect(root?.outsideInputs).toEqual({ declared: ['calendar'], call: { targets: ['review.service'] } });
});
