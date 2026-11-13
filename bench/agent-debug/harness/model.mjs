/**
 * The model port: `nextMessage({ system, messages, tools }) → message`, and
 * `countTokens({ system, messages, tools }) → number`, with two adapters.
 *
 * - `anthropicModel()`: the official SDK. `client.messages.create` with model
 *   `claude-haiku-5-5`, `max_tokens: 8000`, no `thinking` (the model's
 *   default), no sampling parameter, no cache control (RULE.md). The SDK's
 *   own retries are off (`maxRetries: 0`) so every retry is this module's,
 *   bounded and logged (`withRetries`): a passing failure (rate limit, 5xx
 *   and 529, a dropped connection, a timeout) waits (the `retry-after`
 *   header, else a doubling wait) and is retried at most
 *   `RATE_LIMIT_RETRIES` times, each retry a line in the transcript; anything
 *   else ends the run as `error` with the reason kept.
 * - `scriptedModel(script)`: the rehearsal's stand-in. It answers from a
 *   script, spends nothing and counts tokens as characters / 4.
 * Example: `await model.nextMessage({ system, messages, tools })` →
 * `{ content: [...], stop_reason: 'tool_use', usage: { input_tokens, output_tokens } }`.
 */

import { MAX_OUTPUT_TOKENS } from './budget.mjs';

export const MODEL_ID = 'claude-haiku-5-5';
export const MAX_TOKENS = MAX_OUTPUT_TOKENS;
export const RATE_LIMIT_RETRIES = 4;

/** An error that ends the run as `error`, with its reason kept. */
export class ModelError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * @typedef {object} ModelPort
 * @property {(request: { system: string, messages: any[], tools: any[] }, hooks?: { onRetry?: (info: object) => void }) => Promise<any>} nextMessage
 * @property {(request: { system: string, messages: any[], tools: any[] }, hooks?: { onRetry?: (info: object) => void }) => Promise<number>} countTokens
 * @property {string} name
 */

/**
 * Sends a request, retrying it when it fails for a passing reason, at most
 * `RATE_LIMIT_RETRIES` times, with a wait, every retry reported through
 * `onRetry` (RULE.md 1.3, "The model and the budget"). Passing reasons: a
 * rate limit (429), an overloaded or failing server (any 5xx, 529 included),
 * a request timeout (408), a dropped connection or a client timeout. Anything
 * else, or a passing failure after the last retry, throws `ModelError` and
 * ends the run as `error`.
 * @param {() => Promise<any>} send
 * @param {{ Anthropic: any, sleep: (ms: number) => Promise<void>, onRetry?: (info: object) => void }} options
 */
export async function withRetries(send, { Anthropic, sleep, onRetry = () => {} }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      const passing = passingReason(error, Anthropic);
      if (passing) {
        if (attempt >= RATE_LIMIT_RETRIES) throw new ModelError(`${passing} after ${attempt} retries: ${error.message}`);
        const header = Number(error.headers?.get?.('retry-after'));
        const waitMs = Number.isFinite(header) && header > 0 ? header * 1000 : 2000 * 2 ** attempt;
        onRetry({ attempt: attempt + 1, of: RATE_LIMIT_RETRIES, reason: passing, waitMs, message: error.message });
        await sleep(waitMs);
        continue;
      }
      if (error instanceof Anthropic.BadRequestError) throw new ModelError(`bad request (400): ${error.message}`);
      if (error instanceof Anthropic.AuthenticationError) throw new ModelError(`authentication failed (401): ${error.message}`);
      if (error instanceof Anthropic.PermissionDeniedError) throw new ModelError(`permission denied (403): ${error.message}`);
      if (error instanceof Anthropic.NotFoundError) throw new ModelError(`not found (404): ${error.message}`);
      if (error instanceof Anthropic.APIError) throw new ModelError(`API error ${error.status}: ${error.message}`);
      throw new ModelError(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * The retry reasons after which the server may have done (and billed) the
 * work although no answer came back: a client timeout, a dropped
 * connection, a request timeout (408), a gateway timeout (504: a proxy
 * gave up while the server may still have finished). A refused attempt
 * (429, 529, or a 5xx other than 504) is taken as not billed: an
 * assumption, not something measured here
 * (RULE-2.md, "Changed after the fairness readings"). Part 2's second
 * reading prices the first kind at its cap (readings.mjs · boundTokensOf).
 */
export const MAYBE_PAID_REASONS = Object.freeze(['client timeout', 'connection failed', 'request timeout (408)', 'gateway timeout (504)']);
const [CLIENT_TIMEOUT, CONNECTION_FAILED, REQUEST_TIMEOUT, GATEWAY_TIMEOUT] = MAYBE_PAID_REASONS;

/** Whether a retried attempt with this reason may have been paid. @param {string} reason */
export function retryMayHaveBeenPaid(reason) {
  return MAYBE_PAID_REASONS.includes(reason);
}

/** The passing reason of an SDK error, most specific class first, or undefined. */
function passingReason(error, Anthropic) {
  if (error instanceof Anthropic.RateLimitError) return 'rate limited (429)';
  if (error instanceof Anthropic.InternalServerError) return error.status === 504 ? GATEWAY_TIMEOUT : `server error (${error.status})`;
  if (error instanceof Anthropic.APIConnectionTimeoutError) return CLIENT_TIMEOUT;
  if (error instanceof Anthropic.APIConnectionError) return CONNECTION_FAILED;
  if (error instanceof Anthropic.RequestTimeoutError) return REQUEST_TIMEOUT;
  return undefined;
}

/**
 * The real adapter. Reads its credential the SDK's way (the environment);
 * this module never looks for a key itself. `options.client` replaces the
 * SDK client in tests (it is never set by the harness).
 * @param {{ sleep?: (ms: number) => Promise<void>, client?: any }} [options]
 * @returns {Promise<ModelPort>}
 */
export async function anthropicModel(options = {}) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = options.client ?? new Anthropic({ maxRetries: 0 });
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return {
    name: MODEL_ID,
    nextMessage: (request, hooks = {}) =>
      withRetries(
        () => client.messages.create({ model: MODEL_ID, max_tokens: MAX_TOKENS, system: request.system, messages: request.messages, tools: request.tools }),
        { Anthropic, sleep, onRetry: hooks.onRetry },
      ),
    countTokens: async (request, hooks = {}) =>
      (await withRetries(() => client.messages.countTokens({ model: MODEL_ID, system: request.system, messages: request.messages, tools: request.tools }), { Anthropic, sleep, onRetry: hooks.onRetry })).input_tokens,
  };
}

/** Characters of a request, the scripted model's stand-in for tokens. */
export function requestChars(request) {
  return JSON.stringify(request.system).length + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length;
}

/**
 * The rehearsal adapter. `script` is called with the conversation so far and
 * returns the next assistant message's content blocks and stop reason.
 * @param {(state: { messages: any[], turn: number }) => { content: any[], stop_reason: string }} script
 * @returns {ModelPort}
 */
export function scriptedModel(script) {
  let turn = 0;
  return {
    name: 'scripted',
    nextMessage: async (request) => {
      const reply = script({ messages: request.messages, turn: turn++ });
      return {
        id: `scripted-${turn}`,
        type: 'message',
        role: 'assistant',
        model: 'scripted',
        content: reply.content,
        stop_reason: reply.stop_reason,
        usage: { input_tokens: Math.ceil(requestChars(request) / 4), output_tokens: Math.ceil(JSON.stringify(reply.content).length / 4) },
      };
    },
    countTokens: async (request) => Math.ceil(requestChars(request) / 4),
  };
}
