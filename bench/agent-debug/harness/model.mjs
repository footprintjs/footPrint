/**
 * The model port: `nextMessage({ system, messages, tools }) → message`, and
 * `countTokens({ system, messages, tools }) → number`, with two adapters.
 *
 * - `anthropicModel()`: the official SDK. `client.messages.create` with model
 *   `claude-haiku-5-5`, `max_tokens: 8000`, no `thinking` (the model's
 *   default), no sampling parameter, no cache control (RULE.md). The SDK's
 *   own retries are off (`maxRetries: 0`) so every retry is this module's,
 *   bounded and logged. Errors are caught most specific first: a rate limit
 *   waits (the `retry-after` header, else a doubling wait) and retries at
 *   most `RATE_LIMIT_RETRIES` times; anything else ends the run as `error`
 *   with the reason kept.
 * - `scriptedModel(script)`: the rehearsal's stand-in. It answers from a
 *   script, spends nothing and counts tokens as characters / 4.
 * Example: `await model.nextMessage({ system, messages, tools })` →
 * `{ content: [...], stop_reason: 'tool_use', usage: { input_tokens, output_tokens } }`.
 */

export const MODEL_ID = 'claude-haiku-5-5';
export const MAX_TOKENS = 8000;
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
 * @property {(request: { system: string, messages: any[], tools: any[] }) => Promise<any>} nextMessage
 * @property {(request: { system: string, messages: any[], tools: any[] }) => Promise<number>} countTokens
 * @property {string} name
 */

/**
 * The real adapter. Reads its credential the SDK's way (the environment);
 * this module never looks for a key itself.
 * @param {{ sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<ModelPort>}
 */
export async function anthropicModel(options = {}) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ maxRetries: 0 });
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const call = async (/** @type {() => Promise<any>} */ send) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send();
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError) {
          if (attempt >= RATE_LIMIT_RETRIES) throw new ModelError(`rate limited ${attempt + 1} times: ${error.message}`);
          const header = Number(error.headers?.get?.('retry-after'));
          await sleep(Number.isFinite(header) && header > 0 ? header * 1000 : 2000 * 2 ** attempt);
          continue;
        }
        if (error instanceof Anthropic.BadRequestError) throw new ModelError(`bad request (400): ${error.message}`);
        if (error instanceof Anthropic.AuthenticationError) throw new ModelError(`authentication failed (401): ${error.message}`);
        if (error instanceof Anthropic.PermissionDeniedError) throw new ModelError(`permission denied (403): ${error.message}`);
        if (error instanceof Anthropic.NotFoundError) throw new ModelError(`not found (404): ${error.message}`);
        if (error instanceof Anthropic.InternalServerError) throw new ModelError(`server error (${error.status}): ${error.message}`);
        if (error instanceof Anthropic.APIConnectionError) throw new ModelError(`connection failed: ${error.message}`);
        if (error instanceof Anthropic.APIError) throw new ModelError(`API error ${error.status}: ${error.message}`);
        throw new ModelError(`unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  return {
    name: MODEL_ID,
    nextMessage: ({ system, messages, tools }) =>
      call(() => client.messages.create({ model: MODEL_ID, max_tokens: MAX_TOKENS, system, messages, tools })),
    countTokens: async ({ system, messages, tools }) =>
      (await call(() => client.messages.countTokens({ model: MODEL_ID, system, messages, tools }))).input_tokens,
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
