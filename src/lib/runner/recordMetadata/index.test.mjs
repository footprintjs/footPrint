import { expect, it } from 'vitest';

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
