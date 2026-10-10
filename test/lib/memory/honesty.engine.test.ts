/** Engine witness: the record and scope placeholders reach all five redacted surfaces. */
import type { CommitBundle } from 'foottrace';
import { LOG_PLACEHOLDER } from 'foottrace/write';
import { describe, expect, it } from 'vitest';

import { decide, flowChart, FlowChartExecutor } from '../../../src';
import { SCOPE_PLACEHOLDER } from '../../../src/lib/memory/redaction';

describe('the two placeholders — the five places that used to spell them still say the same strings', () => {
  it('are the strings stored recordings and every reader already match on', () => {
    expect(LOG_PLACEHOLDER).toBe('REDACTED');
    expect(SCOPE_PLACEHOLDER).toBe('[REDACTED]');
  });

  interface State {
    ssn: string;
    apiKey: string;
    seeded: string;
    picked: string;
  }

  /** The tree node for `stageId` — `next` and `children` are the only ways down. */
  function findStage(node: any, stageId: string): any {
    if (!node) return undefined;
    if (node.id === stageId) return node;
    for (const child of [node.next, ...(node.children ?? [])]) {
      const found = findStage(child, stageId);
      if (found) return found;
    }
    return undefined;
  }

  it('a redacted run: the log and the mirror say REDACTED; every scope-tier view says [REDACTED]', async () => {
    const emitted: Array<{ payload: unknown }> = [];
    const decisions: Array<{ evidence: { rules: any[] } }> = [];
    const chart = flowChart<State>(
      'Seed',
      (scope) => {
        scope.ssn = '123-45-6789';
        scope.apiKey = 'sk-secret';
        scope.$emit('app.auth.check', { token: 'tok' });
      },
      'seed',
    )
      .addDeciderFunction(
        'Route',
        (scope) =>
          decide(
            scope,
            [
              // a filter rule reads through the evaluator …
              { when: { ssn: { eq: 'nope' } }, then: 'a', label: 'by-ssn' },
              // … a function rule through the evidence collector
              { when: (s) => s.$getValue('apiKey') === 'zzz', then: 'b', label: 'by-fn' },
            ],
            'c',
          ),
        'route',
      )
      .addFunctionBranch('a', 'A', (scope) => {
        scope.picked = 'a';
      })
      .addFunctionBranch('b', 'B', (scope) => {
        scope.picked = 'b';
      })
      .addFunctionBranch('c', 'C', (scope) => {
        scope.picked = 'c';
      })
      .setDefault('c')
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, { initialContext: { seeded: 'seed-secret' } });
    executor.setRedactionPolicy({ keys: ['ssn', 'apiKey', 'seeded'], emitPatterns: [/\.auth\./] });
    executor.attachEmitRecorder({ id: 'emits', onEmit: (e) => emitted.push(e) });
    executor.attachFlowRecorder({ id: 'flow', onDecision: (e) => decisions.push(e as never) });
    await executor.run();

    const live = executor.getSnapshot();
    const safe = executor.getSnapshot({ redact: true });

    // LOG tier — memory/scrub.ts · scrubPatch (via recordCommit): what the commit log recorded
    const seedCommit = (live.commitLog as CommitBundle[]).find((b) => b.stageId === 'seed')!;
    expect(seedCommit.overwrite).toMatchObject({ ssn: 'REDACTED', apiKey: 'REDACTED' });
    // LOG tier — runner/ExecutionRuntime.ts: the mirror's seed is scrubbed with the log's string
    expect((safe.sharedState as Record<string, unknown>).seeded).toBe('REDACTED');
    expect((safe.sharedState as Record<string, unknown>).ssn).toBe('REDACTED');

    // SCOPE tier — scope/ScopeFacade.ts · emitEvent: a pattern-matched emit payload
    expect(emitted).toHaveLength(1);
    expect(emitted[0].payload).toBe('[REDACTED]');
    // SCOPE tier — decide/evaluator.ts: a filter rule's condition on a redacted key
    const [filterRule, functionRule] = decisions[0].evidence.rules;
    expect(filterRule.conditions[0]).toMatchObject({ key: 'ssn', actualSummary: '[REDACTED]', redacted: true });
    // SCOPE tier — decide/evidence.ts: a function rule's read of a redacted key
    expect(functionRule.inputs[0]).toMatchObject({ key: 'apiKey', valueSummary: '[REDACTED]', redacted: true });
    // SCOPE tier — memory/StageContext.ts · retainedForm: the retained reads of the deciding stage
    expect(findStage(live.executionTree, 'route').stageReads).toMatchObject({
      ssn: '[REDACTED]',
      apiKey: '[REDACTED]',
    });
  });
});
