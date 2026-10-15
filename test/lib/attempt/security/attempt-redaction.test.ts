/**
 * The attempt record under the redaction law (design §6): an attempt's error is a VALUE, retained through
 * `RedactionRule.retainStageError` like every other report of a stage failure; the record keeps only the served
 * error's named fields, never `raw`, never an extra own key; the decision evidence carries no error at all.
 *
 * Test types: Security (a diagnostic policy on the error text: tree, hook, narrative, redacted snapshot; a state
 * key carried by the thrown value; the evidence) · Boundary (no policy: the record still never holds the thrown
 * value — only the live hook does, as `onStageRetry` always has).
 */
import { describe, expect, it } from 'vitest';

import type { StageSnapshot } from '../../../../src/advanced.js';
import type { FlowAttemptEvent } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, unknown>;
const SECRET = 'card-4111-1111';

function chartThrowing(make: (n: number) => unknown) {
  let calls = 0;
  return flowChart<S>('Seed', () => undefined, 'seed')
    .addFunction(
      'Charge',
      () => {
        calls += 1;
        if (calls < 3) throw make(calls);
      },
      'charge',
    )
    .retry({ attempts: 3 })
    .build();
}

async function run(
  chart: ReturnType<typeof chartThrowing>,
  policy?: Parameters<FlowChartExecutor['setRedactionPolicy']>[0],
) {
  const executor = new FlowChartExecutor(chart);
  if (policy) executor.setRedactionPolicy(policy);
  executor.enableNarrative();
  const events: FlowAttemptEvent[] = [];
  executor.attachFlowRecorder({ id: 'attempts', onAttempt: (e) => events.push(e) });
  await executor.run();
  let charge: StageSnapshot | undefined = executor.getSnapshot().executionTree as StageSnapshot;
  while (charge && charge.id !== 'charge') charge = charge.next;
  return { executor, events, records: charge!.attempts! };
}

describe('a diagnostic policy on the error text reaches every attempt surface', () => {
  it('the tree, the hook, the narrative line and the redacted snapshot never see the text', async () => {
    const { executor, events, records } = await run(
      chartThrowing((n) => new Error(`charge ${n} failed for ${SECRET}`)),
      { diagnostics: { keys: ['errors.stageExecutionError'] } },
    );
    expect(records.slice(0, 2).every((r) => typeof r.error?.message === 'string')).toBe(true);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    for (const event of events.slice(0, 2)) {
      expect(event.structuredError?.message).not.toContain(SECRET);
      expect(event.structuredError?.raw).toBeUndefined();
    }
    const lines = executor.getNarrativeEntries().filter((e) => e.type === 'attempt');
    expect(lines).toHaveLength(3);
    expect(lines.map((e) => e.text).join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(executor.getSnapshot({ redact: true }).executionTree)).not.toContain(SECRET);
  });
});

describe('the record keeps only what it names', () => {
  it('a selected state key carried by the thrown value never reaches the record or the hook', async () => {
    const { events, records } = await run(
      chartThrowing((n) => Object.assign(new Error(`lookup ${n} failed`), { ssn: SECRET })),
      { keys: ['ssn'] },
    );
    expect(records[0].error).toEqual({ message: 'lookup 1 failed', name: 'Error' });
    expect(JSON.stringify(records)).not.toContain(SECRET);
    // The served form of a value that carries a selected key is masked: no raw thrown value on the hook either.
    expect(events[0].structuredError?.raw).toBeUndefined();
  });

  it('without a policy the record still never holds the thrown value — only the live hook does', async () => {
    const thrown = (n: number) => Object.assign(new Error(`boom ${n}`), { token: SECRET, retry: () => 1 });
    const { events, records } = await run(chartThrowing(thrown));
    expect(records[0].error).toEqual({ message: 'boom 1', name: 'Error' });
    expect(Object.hasOwn(records[0].error!, 'raw')).toBe(false);
    expect(JSON.stringify(records)).not.toContain(SECRET);
    expect(structuredClone(records)).toEqual(records); // the function on the error never reached the record
    expect((events[0].structuredError?.raw as { token: string }).token).toBe(SECRET);
  });

  it('the decision evidence carries no error at all — only names, numbers and flags', async () => {
    const { records } = await run(chartThrowing((n) => new Error(`charge ${n} failed for ${SECRET}`)));
    for (const record of records) {
      expect(JSON.stringify(record.decision)).not.toContain(SECRET);
      expect(JSON.stringify(record.decision)).not.toContain('failed for');
    }
  });
});
