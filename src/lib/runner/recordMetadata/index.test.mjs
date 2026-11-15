import { expect, it } from 'vitest';

import { invalidateFailureReceipt, publishFailureReceipt } from '../../errors/failureRetention/index.js';
import { NativeFailureState } from '../../errors/terminalFailure.js';
import { RedactionRule } from '../../memory/redaction.js';
import { closingError, openingMeta } from './index.js';

it('reads the budget before the current run identity and preserves optional field order', () => {
  const order = [];
  let runId = 'before';
  const args = {
    flowChart: {
      buildTimeStructure: {
        get budgetMs() {
          order.push('budget');
          runId = 'after';
          return 40;
        },
      },
    },
  };
  const root = {
    get id() {
      order.push('id');
      return 'root';
    },
    get name() {
      order.push('name');
      return 'Root';
    },
  };
  const result = openingMeta(
    args,
    () => {
      order.push('run');
      return runId;
    },
    root,
    { traceId: 't' },
    20,
    'prior',
  );
  expect(order).toEqual(['budget', 'run', 'id', 'name']);
  expect(result.runId).toBe('after');
  expect(Object.keys(result)).toEqual(['runId', 'chart', 'correlation', 'deadline', 'budgetMs', 'resumedFrom']);
  const missing = openingMeta({ flowChart: {} }, () => 'run', { id: 'root', name: 'Root' }, undefined, undefined);
  expect(missing).toEqual({ runId: 'run', chart: { id: 'root', name: 'Root' } });
});

it('uses the current token, preserves structured fields and refuses a stale invocation after commit', () => {
  const rule = new RedactionRule({ keys: ['unrelated'] });
  const state = new NativeFailureState();
  const stage = { runId: 'run', runtimeStageId: 'child#2' };
  const error = Object.assign(new Error('public child'), { code: 'PUBLIC_CODE' });
  expect(closingError(error, rule)).toEqual({ message: '[REDACTED]' });
  state.capture(error, 'unknown', stage);
  publishFailureReceipt(
    state,
    error,
    stage,
    {
      message: 'Error: public child',
      structuredError: { name: 'Error', message: error.message, code: error.code, raw: error },
    },
    'clear',
  );
  const metadata = closingError(error, rule, state);
  expect(metadata).toEqual({ name: 'Error', message: 'public child', code: 'PUBLIC_CODE' });
  expect(Object.keys(metadata)).toEqual(['name', 'message', 'code']);
  invalidateFailureReceipt(state);
  expect(closingError(error, rule, state)).toEqual({ message: '[REDACTED]' });
  state.finish(error);
  expect(closingError(error, rule, state)).toEqual({ message: '[REDACTED]' });
  expect(closingError(error, new RedactionRule())).toEqual({
    name: 'Error',
    message: 'public child',
    code: 'PUBLIC_CODE',
  });
  expect(error.message).toBe('public child');
  expect(error.code).toBe('PUBLIC_CODE');
});

it('serves an error once and keeps the original name/message/code getter order without raw data', () => {
  const order = [];
  const raw = { secret: 'not retained' };
  const rule = {
    servedError(value) {
      expect(value).toBe(raw);
      order.push('serve');
      return {
        get name() {
          order.push('name');
          return 'Error';
        },
        get message() {
          order.push('message');
          return 'retained';
        },
        get code() {
          order.push('code');
          return 'fixed';
        },
        raw,
      };
    },
  };
  expect(closingError(raw, rule)).toEqual({ name: 'Error', message: 'retained', code: 'fixed' });
  expect(order).toEqual(['serve', 'name', 'name', 'message', 'code', 'code']);
});
