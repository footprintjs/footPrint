/**
 * The real adapter's retries (RULE.md 1.3, F4), with the SDK's own error
 * classes thrown by a stand-in client; nothing is sent anywhere.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';

import { runAgent } from '../harness/agent.mjs';
import { anthropicModel, ModelError, RATE_LIMIT_RETRIES } from '../harness/model.mjs';
import { loadFault } from '../faults/apply.mjs';
import { createWorkdir, removeWorkdir } from '../harness/workdir.mjs';

const status = (code, message = `status ${code}`) => Anthropic.APIError.generate(code, { type: 'error', error: { type: 'x', message } }, message, new Headers());
const PASSING = {
  'rate limit 429': () => status(429),
  'server error 500': () => status(500),
  'overloaded 529': () => status(529),
  'request timeout 408': () => status(408),
  'dropped connection': () => new Anthropic.APIConnectionError({ message: 'socket hang up' }),
  'client timeout': () => new Anthropic.APIConnectionTimeoutError({ message: 'timed out' }),
};
const ok = { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } };

/** A stand-in client that fails `failures` times with `make()`, then answers. */
function client(make, failures) {
  let calls = 0;
  return {
    calls: () => calls,
    messages: {
      create: async () => {
        calls++;
        if (calls <= failures) throw make();
        return ok;
      },
      countTokens: async () => ({ input_tokens: 1 }),
    },
  };
}

for (const [name, make] of Object.entries(PASSING)) {
  test(`${name} is retried, bounded and logged`, async () => {
    const fake = client(make, RATE_LIMIT_RETRIES);
    const waits = [];
    const retries = [];
    const model = await anthropicModel({ client: fake, sleep: async (ms) => waits.push(ms) });
    assert.deepEqual(await model.nextMessage({ system: 's', messages: [], tools: [] }, { onRetry: (i) => retries.push(i) }), ok);
    assert.equal(fake.calls(), RATE_LIMIT_RETRIES + 1);
    assert.equal(retries.length, RATE_LIMIT_RETRIES);
    assert.equal(waits.length, RATE_LIMIT_RETRIES);
    const tooMany = client(make, RATE_LIMIT_RETRIES + 1);
    const model2 = await anthropicModel({ client: tooMany, sleep: async () => {} });
    await assert.rejects(model2.nextMessage({ system: 's', messages: [], tools: [] }), ModelError);
    assert.equal(tooMany.calls(), RATE_LIMIT_RETRIES + 1);
  });
}

test('a request the API refuses for good is not retried', async () => {
  for (const code of [400, 401, 403, 404]) {
    const fake = client(() => status(code), 1);
    const model = await anthropicModel({ client: fake, sleep: async () => assert.fail('no wait') });
    await assert.rejects(model.nextMessage({ system: 's', messages: [], tools: [] }), new RegExp(`\\(${code}\\)`));
    assert.equal(fake.calls(), 1);
  }
});

test('every retry is a line of the run\'s transcript', async () => {
  const fault = loadFault('wrong-key-read');
  const work = await createWorkdir(fault);
  try {
    let calls = 0;
    const fake = {
      messages: {
        countTokens: async () => ({ input_tokens: 1 }),
        create: async () => {
          calls++;
          if (calls <= 2) throw status(529);
          return { content: [{ type: 'tool_use', id: 'd', name: 'done', input: { summary: 'x' } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 1 } };
        },
      },
    };
    const model = await anthropicModel({ client: fake, sleep: async () => {} });
    const events = [];
    const counts = await runAgent({ model, setup: 1, fault, workdir: work.dir, log: (e) => events.push(e) });
    assert.equal(counts.stopReason, 'done');
    assert.equal(counts.requests, 1);
    assert.deepEqual(events.filter((e) => e.type === 'retry').map((e) => e.reason), ['server error (529)', 'server error (529)']);
  } finally {
    removeWorkdir(work.dir);
  }
});
