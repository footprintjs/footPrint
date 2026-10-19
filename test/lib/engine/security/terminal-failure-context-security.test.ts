import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FlowRunFailedEvent, TerminalFailureContext } from '../../../../src/index.js';
import { flowChart, FlowChartExecutor, InputValidationError } from '../../../../src/index.js';
import type { ILogger } from '../../../../src/lib/engine/types.js';
import { StageContext } from '../../../../src/lib/memory/StageContext.js';

const silent: ILogger = { info() {}, log() {}, debug() {}, error() {}, warn() {} };

afterEach(() => vi.restoreAllMocks());

describe('terminal failure context is a payload-free served boundary', () => {
  it('preserves native final category after the error is served scrubbed', async () => {
    const secret = 'SYNTHETIC_TERMINAL_PRIVATE';
    const original = Object.assign(new Error(secret, { cause: { secret } }), {
      status: 503,
      code: 'SYNTHETIC_PRIVATE_CODE',
      request: { secret },
    });
    const executor = new FlowChartExecutor(
      flowChart(
        'Private failure',
        () => {
          throw original;
        },
        'private-failure',
      )
        .retry({ attempts: 1, timeoutMs: 1000 })
        .setLogger(silent)
        .build(),
    );
    executor.setRedactionPolicy({ diagnostics: { keys: ['errors.stageExecutionError'] }, keys: ['secret'] });
    const events: FlowRunFailedEvent[] = [];
    executor.attachFlowRecorder({ id: 'served-terminal-context', onRunFailed: (event) => events.push(event) });
    await expect(executor.run()).rejects.toBe(original);
    expect(events[0].structuredError.message).toBe('[REDACTED]');
    expect(events[0].structuredError.raw).toBeUndefined();
    const context = executor.getFailureContext()!;
    expect(context).toEqual({
      category: 'server',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'private-failure#0' },
    });
    expect(Object.keys(context).sort()).toEqual(['category', 'stage']);
    expect(Object.keys(context.stage!).sort()).toEqual(['runId', 'runtimeStageId']);
    expect(JSON.parse(JSON.stringify(context))).toEqual(context);
    expect(structuredClone(context)).toEqual(context);
    for (const forbidden of [secret, 'SYNTHETIC_PRIVATE_CODE', 'request', 'cause', 'stack', 'message', 'raw']) {
      expect(JSON.stringify(context)).not.toContain(forbidden);
    }
  });

  it('does not reclassify the final attempt from an observer-mutated raw error', async () => {
    const original = Object.assign(new Error('synthetic originally server'), { status: 503 });
    const executor = new FlowChartExecutor(
      flowChart(
        'Attempt',
        () => {
          throw original;
        },
        'attempt',
      )
        .retry({ attempts: 1, timeoutMs: 1000 })
        .setLogger(silent)
        .build(),
    );
    executor.attachFlowRecorder({
      id: 'change-served-raw',
      onAttempt: (event) => {
        if (event.record.kind === 'stage' && event.record.next === 'stop') original.status = 401;
      },
    });
    await expect(executor.run()).rejects.toBe(original);
    expect(original.status).toBe(401);
    expect(executor.getFailureContext()!.category).toBe('server');
  });

  it('classifies an ordinary stage before diagnostic retention can mutate its thrown value', async () => {
    const original = Object.assign(new Error('synthetic diagnostic mutation'), { status: 503 });
    const add = StageContext.prototype.addDiagnostic;
    let mutations = 0;
    vi.spyOn(StageContext.prototype, 'addDiagnostic').mockImplementation(function (
      this: StageContext,
      channel,
      key,
      value,
      path,
    ) {
      if (channel === 'errors' && key === 'stageExecutionError') {
        mutations++;
        original.status = 401;
      }
      return add.call(this, channel, key, value, path);
    });
    const executor = new FlowChartExecutor(
      flowChart(
        'Fail',
        () => {
          throw original;
        },
        'fail',
      )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(mutations).toBe(1);
    expect(original.status).toBe(401);
    expect(executor.getFailureContext()).toEqual({
      category: 'server',
      stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'fail#0' },
    });
  });

  it('recorder and accessor consumers cannot mutate the retained context or the next recorder view', async () => {
    const original = Object.assign(new Error('synthetic immutable context'), { status: 503 });
    const executor = new FlowChartExecutor(
      flowChart(
        'Fail',
        () => {
          throw original;
        },
        'fail',
      )
        .setLogger(silent)
        .build(),
    );
    const observed: TerminalFailureContext[] = [];
    const replacements: boolean[] = [];
    executor.attachFlowRecorder({
      id: 'mutator',
      onRunFailed: (event) => {
        replacements.push(
          Reflect.set(event, 'failure', {
            category: 'auth',
            stage: { runId: 'forged-run', runtimeStageId: 'forged#999' },
          }),
        );
        if (event.failure) {
          Reflect.set(event.failure, 'category', 'auth');
          if (event.failure.stage) Reflect.set(event.failure.stage, 'runtimeStageId', 'forged#999');
        }
      },
    });
    executor.attachFlowRecorder({
      id: 'observer',
      onRunFailed: (event) => {
        if (event.failure) observed.push(event.failure);
      },
    });
    await expect(executor.run()).rejects.toBe(original);
    const expected = { category: 'server', stage: { runId: executor.getSnapshot().runId, runtimeStageId: 'fail#0' } };
    expect(replacements).toEqual([false]);
    expect(observed).toEqual([expected]);
    const firstRead = executor.getFailureContext()!;
    Reflect.set(firstRead, 'category', 'network');
    Reflect.set(firstRead.stage!, 'runId', 'forged-run');
    expect(executor.getFailureContext()).toEqual(expected);
  });

  it('validation details never become terminal failure metadata', async () => {
    const privateText = 'SYNTHETIC_VALIDATION_PRIVATE';
    const original = new InputValidationError(privateText, [
      { path: [privateText], message: privateText, code: privateText },
    ]);
    const executor = new FlowChartExecutor(
      flowChart(
        'Validate',
        () => {
          throw original;
        },
        'validate',
      )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(executor.getFailureContext()!.category).toBe('permanent');
    expect(JSON.stringify(executor.getFailureContext())).not.toContain(privateText);
    expect(JSON.stringify(executor.getFailureContext())).not.toContain('issues');
  });

  it('run admission failure clears an earlier stage identity instead of reusing it', async () => {
    const original = Object.assign(new Error('synthetic prior error'), { status: 503 });
    const executor = new FlowChartExecutor(
      flowChart(
        'Fail',
        () => {
          throw original;
        },
        'fail',
      )
        .setLogger(silent)
        .build(),
    );
    await expect(executor.run()).rejects.toBe(original);
    expect(executor.getFailureContext()!.stage).toBeDefined();
    await expect(executor.run({ env: { traceparent: 'invalid-synthetic-header' } })).rejects.toThrow();
    expect(executor.getFailureContext()).toEqual({ category: 'unknown' });
  });

  it('retained result serialization failure has no stage, even after a contained branch error', async () => {
    const serialization = new Error('synthetic result serialization');
    const output = Object.defineProperty({}, 'nested', {
      enumerable: true,
      get() {
        throw serialization;
      },
    });
    const executor = new FlowChartExecutor(
      flowChart('Seed', () => {}, 'seed')
        .addListOfFunction([
          {
            id: 'contained',
            name: 'Contained',
            fn: () => {
              throw Object.assign(new Error('synthetic contained'), { status: 503 });
            },
          },
        ])
        .addFunction('Return', () => output, 'return')
        .setLogger(silent)
        .build(),
    );
    executor.setRedactionPolicy({ keys: ['synthetic-private-field'] });
    const events: FlowRunFailedEvent[] = [];
    executor.attachFlowRecorder({ id: 'serialization-context', onRunFailed: (event) => events.push(event) });
    await expect(executor.run()).rejects.toBe(serialization);
    expect(executor.getFailureContext()).toEqual({ category: 'unknown' });
    expect(events).toHaveLength(1);
    expect(events[0].failure).toEqual({ category: 'unknown' });
  });
});
