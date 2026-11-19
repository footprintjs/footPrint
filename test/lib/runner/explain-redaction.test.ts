import { normaliseStateKey } from 'foottrace/paths';
import { expect, it } from 'vitest';

import type { explain as Explain } from '../../../src/explain.js';
import { flowChart, FlowChartExecutor } from '../../../src/index.js';

const selected = 'EXPLAIN_PRIVATE_68C53DE2';
const nestedKey = normaliseStateKey(['profile', 'privateCode']);

interface ParentState {
  credential: string;
  profile: { privateCode: string };
  quantity: number;
  items: string[];
  ready?: boolean;
  receipt?: string;
  reviews?: unknown[];
}

interface PaymentState {
  token: string;
  childSecret?: string;
}

function protectedChart() {
  const payment = flowChart<PaymentState>(
    'Charge',
    (scope) => {
      scope.childSecret = scope.token;
    },
    'charge',
  ).build();
  const review = flowChart<{ item: string; selected?: boolean }>(
    'Review',
    (scope) => {
      scope.selected = scope.item === selected;
    },
    'review',
  ).build();

  return flowChart<ParentState>(
    'Seed',
    (scope) => {
      scope.credential = selected;
      scope.profile = { privateCode: selected };
      scope.quantity = 2;
      scope.items = [selected];
    },
    'seed',
  )
    .addFunction(
      'Read',
      (scope) => {
        const credential = scope.credential;
        const privateCode = scope.profile.privateCode;
        scope.ready = credential === selected && privateCode === selected && scope.quantity > 0;
      },
      'read',
    )
    .addSubFlowChartNext('payment', payment, 'Payment', {
      inputMapper: (parent) => ({ token: parent.credential }),
      outputMapper: (child: PaymentState) => ({ receipt: child.childSecret }),
    })
    .addParallelForEach('Run reviews', 'reviews', {
      items: (scope) => scope.items,
      branch: () => review,
      into: 'reviews',
      maxBranches: 1,
    })
    .build();
}

it('withholds selected data from explain evidence while still recording the redacted workflow', async () => {
  // Dynamic only so the identical gate can run on the release pin where the door does not exist.
  const modulePath = '../../../src/explain.ts';
  const { explain } = (await import(modulePath)) as { explain: typeof Explain };
  const executor = new FlowChartExecutor(protectedChart(), explain(true));
  executor.setRedactionPolicy({
    keys: ['credential', 'items', 'childSecret'],
    fields: { profile: ['privateCode'] },
  });
  await executor.run();

  const raw = executor.getSnapshot();
  const safe = executor.getSnapshot({ redact: true });
  expect(raw.sharedState).toMatchObject({ ready: true, receipt: selected });
  expect(safe.sharedState).toMatchObject({ ready: true, receipt: 'REDACTED' });
  expect(JSON.stringify(safe)).not.toContain(selected);

  for (const snapshot of [raw, safe]) {
    const retainedReads = snapshot.executionTree.next?.stageReads;
    expect(retainedReads).toMatchObject({ credential: '[REDACTED]', 'profile.privateCode': '[REDACTED]', quantity: 2 });
    const write = snapshot.commitLog
      .find((commit) => commit.stageId === 'read')
      ?.trace.find((row) => row.path === 'ready');
    expect(write?.readKeys).toEqual(expect.arrayContaining(['credential', nestedKey, 'quantity']));

    const payment = snapshot.subflowResults?.payment;
    expect(payment?.inputHandoff).toMatchObject({
      status: 'partial',
      limitations: expect.arrayContaining(['privacy-active']),
      writes: [{ path: 'token', reads: [] }],
    });
    expect(payment?.outputHandoff).toMatchObject({
      status: 'partial',
      limitations: expect.arrayContaining(['privacy-active']),
      writes: [{ path: 'receipt', reads: [] }],
    });
    const collections = snapshot.fanoutCollections?.collections;
    expect(collections).toHaveLength(1);
    expect(collections?.[0]).toMatchObject({
      status: 'partial',
      limitations: expect.arrayContaining(['privacy-active']),
      slots: [],
    });
    expect(snapshot.capture).toBeDefined();
    expect(
      JSON.stringify({
        retainedReads,
        prefix: write?.readKeys,
        rootSources: snapshot.readSources,
        childSources: payment?.treeContext.readSources,
        input: payment?.inputHandoff,
        output: payment?.outputHandoff,
        collections,
        capture: snapshot.capture,
      }),
    ).not.toContain(selected);
  }

  expect(raw.readSources?.limitations).toContain('privacy-active');
  expect(raw.readSources?.record?.occurrences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: 'quantity', source: expect.objectContaining({ kind: 'committed' }) }),
      expect.objectContaining({ key: 'credential', source: { kind: 'unavailable', reason: 'redacted' } }),
    ]),
  );
  expect(raw.subflowResults?.payment?.treeContext.readSources?.record?.occurrences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: 'token', source: { kind: 'unavailable', reason: 'redacted' } }),
    ]),
  );
  expect(safe.readSources?.limitations).toContain('redacted-source-export');
  expect(safe.readSources?.record).toBeUndefined();
  expect(safe.subflowResults?.payment?.treeContext.readSources?.record).toBeUndefined();
});

it('applies a mark made after a mount completed to each served child capture channel', async () => {
  const modulePath = '../../../src/explain.ts';
  const { captureWitnessOf, explain } = (await import(modulePath)) as typeof import('../../../src/explain.js');
  const child = flowChart<{ receipt: number }>(
    'Make receipt',
    (scope) => {
      scope.receipt = 5;
    },
    'receipt',
  ).build();
  const parent = flowChart<{ privateField?: string }>('Start', () => undefined, 'start')
    .addSubFlowChartNext('child', child, 'Child')
    .addFunction('Mark private', (scope) => scope.$setValue('privateField', 'marked later', true), 'mark')
    .build();
  const executor = new FlowChartExecutor(parent, explain(true));
  await executor.run();

  for (const snapshot of [executor.getSnapshot(), executor.getSnapshot({ redact: true })]) {
    const results = snapshot.subflowResults ?? {};
    const mount = results.child;
    expect(mount?.treeContext.capture).toBeDefined();
    expect(Object.values(results)).toEqual([mount, mount]);
    expect(Object.values(results)[1]).toBe(mount);
    expect(captureWitnessOf(mount?.treeContext)).toMatchObject({ boundary: 'completed' });
    for (const [key, channel] of Object.entries(mount?.treeContext.capture?.channels ?? {})) {
      expect(channel, key).toMatchObject({ status: 'unknown', reasons: expect.arrayContaining(['redacted']) });
    }
  }
});
