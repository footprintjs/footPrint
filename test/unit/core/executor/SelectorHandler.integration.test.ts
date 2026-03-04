/**
 * SelectorHandler.integration.test.ts
 *
 * Integration tests for addSelectorFunction — tests the full pipeline execution
 * from builder through Pipeline execution with SelectorHandler.
 */

import { FlowChartBuilder } from '../../../../src/core/builder/FlowChartBuilder';
import { BaseState } from '../../../../src/scope/BaseState';
import { StageContext } from '../../../../src/core/memory/StageContext';

// Standard scope factory (same pattern used in demo/)
const scopeFactory = (ctx: StageContext, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

describe('addSelectorFunction — integration', () => {
  test('full pipeline: selector reads from scope and runs selected children', async () => {
    const executionOrder: string[] = [];

    const result = await new FlowChartBuilder<any, BaseState>()
      .start('AnalyzePrefs', async (scope) => {
        executionOrder.push('AnalyzePrefs');
        scope.setValue('prefs', { email: true, sms: true, push: false });
      })
      .addSelectorFunction('PickChannels', async (scope) => {
        executionOrder.push('PickChannels');
        const prefs = scope.getValue('prefs') as Record<string, boolean>;
        const channels: string[] = [];
        if (prefs.email) channels.push('email');
        if (prefs.sms) channels.push('sms');
        if (prefs.push) channels.push('push');
        return channels;
      }, 'pick-channels')
        .addFunctionBranch('email', 'SendEmail', async (scope) => {
          executionOrder.push('SendEmail');
          scope.setValue('emailSent', true);
        })
        .addFunctionBranch('sms', 'SendSMS', async (scope) => {
          executionOrder.push('SendSMS');
          scope.setValue('smsSent', true);
        })
        .addFunctionBranch('push', 'SendPush', async (scope) => {
          executionOrder.push('SendPush');
          scope.setValue('pushSent', true);
        })
      .end()
      .addFunction('Confirm', async (scope) => {
        executionOrder.push('Confirm');
        return {
          emailSent: scope.getValue('emailSent'),
          smsSent: scope.getValue('smsSent'),
          pushSent: scope.getValue('pushSent'),
        };
      })
      .execute(scopeFactory);

    // AnalyzePrefs → PickChannels → [SendEmail, SendSMS] (parallel) → Confirm
    expect(executionOrder).toContain('AnalyzePrefs');
    expect(executionOrder).toContain('PickChannels');
    expect(executionOrder).toContain('SendEmail');
    expect(executionOrder).toContain('SendSMS');
    expect(executionOrder).not.toContain('SendPush');
    expect(executionOrder).toContain('Confirm');

    // AnalyzePrefs and PickChannels must run before children
    expect(executionOrder.indexOf('AnalyzePrefs')).toBeLessThan(executionOrder.indexOf('PickChannels'));
    expect(executionOrder.indexOf('PickChannels')).toBeLessThan(executionOrder.indexOf('SendEmail'));
    expect(executionOrder.indexOf('PickChannels')).toBeLessThan(executionOrder.indexOf('SendSMS'));
  });

  test('selector returning single string (not array) works', async () => {
    const executionOrder: string[] = [];

    await new FlowChartBuilder<any, BaseState>()
      .start('Start', async (scope) => {
        scope.setValue('choice', 'branchA');
      })
      .addSelectorFunction('SingleSelect', async (scope) => {
        return scope.getValue('choice') as string; // Returns single string
      })
        .addFunctionBranch('branchA', 'A', async () => { executionOrder.push('A'); })
        .addFunctionBranch('branchB', 'B', async () => { executionOrder.push('B'); })
      .end()
      .execute(scopeFactory);

    expect(executionOrder).toEqual(['A']);
  });

  test('selector returning empty array skips all children', async () => {
    const executionOrder: string[] = [];

    await new FlowChartBuilder<any, BaseState>()
      .start('Start', async () => {
        executionOrder.push('Start');
      })
      .addSelectorFunction('EmptySelector', async () => {
        executionOrder.push('EmptySelector');
        return []; // No children selected
      })
        .addFunctionBranch('a', 'A', async () => { executionOrder.push('A'); })
      .end()
      .addFunction('After', async () => {
        executionOrder.push('After');
      })
      .execute(scopeFactory);

    expect(executionOrder).toEqual(['Start', 'EmptySelector', 'After']);
  });

  test('selector with all children selected runs all in parallel', async () => {
    const executionOrder: string[] = [];

    await new FlowChartBuilder<any, BaseState>()
      .start('Start', async () => {})
      .addSelectorFunction('SelectAll', async () => ['a', 'b', 'c'])
        .addFunctionBranch('a', 'A', async () => { executionOrder.push('A'); })
        .addFunctionBranch('b', 'B', async () => { executionOrder.push('B'); })
        .addFunctionBranch('c', 'C', async () => { executionOrder.push('C'); })
      .end()
      .execute(scopeFactory);

    // All three should have executed
    expect(executionOrder).toContain('A');
    expect(executionOrder).toContain('B');
    expect(executionOrder).toContain('C');
  });

  test('selector throws on unknown branch ID', async () => {
    await expect(
      new FlowChartBuilder<any, BaseState>()
        .start('Start', async () => {})
        .addSelectorFunction('BadSelector', async () => ['nonexistent'])
          .addFunctionBranch('a', 'A', async () => {})
        .end()
        .execute(scopeFactory),
    ).rejects.toThrow(/unknown child IDs: nonexistent/);
  });

  test('selector stage error propagates', async () => {
    await expect(
      new FlowChartBuilder<any, BaseState>()
        .start('Start', async () => {})
        .addSelectorFunction('FailingSelector', async () => {
          throw new Error('selector boom');
        })
          .addFunctionBranch('a', 'A', async () => {})
        .end()
        .execute(scopeFactory),
    ).rejects.toThrow('selector boom');
  });

  test('selector stage can write to scope and downstream reads it', async () => {
    let readValue: unknown;

    await new FlowChartBuilder<any, BaseState>()
      .start('Start', async () => {})
      .addSelectorFunction('Select', async (scope) => {
        scope.setValue('selectorWrote', 'from-selector');
        return ['a'];
      })
        .addFunctionBranch('a', 'A', async () => {})
      .end()
      .addFunction('Reader', async (scope) => {
        readValue = scope.getValue('selectorWrote');
      })
      .execute(scopeFactory);

    expect(readValue).toBe('from-selector');
  });
});
