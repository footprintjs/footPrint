/**
 * One run: the model works on one faulty working copy until it calls
 * `done` or a limit of RULE.md stops it. Every request, response and tool
 * call is handed to `log` as it happens, so a stopped batch loses nothing.
 *
 * Stop reasons handled (the SDK's `stop_reason`):
 * - `tool_use`: every tool call of the message runs, and ALL results go back
 *   in ONE user message; a `done` call ends the run after its message.
 * - `end_turn` without `done`: one reminder, then the run ends unsolved.
 * - `pause_turn`: the turn is sent back to be continued.
 * - `max_tokens`, `refusal`, `stop_sequence`, `model_context_window_exceeded`
 *   and anything unknown: the run ends with that reason (a cut message's
 *   tool calls are never run).
 * Example: `await runAgent({ model, setup: 3, fault, workdir, log })` →
 * `{ stopReason: 'done', requests: 7, inputTokens: 51234, … }`.
 */
import { ESTIMATE_CHARS_PER_TOKEN, EXACT_COUNT_FROM, LIMITS } from './budget.mjs';
import { ModelError } from './model.mjs';
import { REMINDER, SYSTEM_PROMPT, taskText } from './prompt.mjs';
import { callTool, toolsFor } from '../tools/index.mjs';

/**
 * @typedef {object} RunCounts
 * @property {string} stopReason
 * @property {string | null} error
 * @property {string | null} doneSummary
 * @property {number} requests
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} thinkingTokens output tokens spent thinking, when the API reports them (part of outputTokens)
 * @property {number} largestRequestTokens
 * @property {number} finalContextTokens the last request's input tokens plus its output tokens (RULE.md 1.2)
 * @property {Record<string, number>} toolCalls
 * @property {number} toolErrors
 * @property {number} readFileChars characters returned by read_file
 * @property {number} edits successful edit_file calls
 * @property {number} wallMs
 */

/**
 * @param {{ model: import('./model.mjs').ModelPort, setup: number, fault: import('../faults/apply.mjs').Fault,
 *   workdir: string, log?: (event: object) => void, limits?: typeof LIMITS }} options
 * @returns {Promise<RunCounts>}
 */
export async function runAgent({ model, setup, fault, workdir, log = () => {}, limits = LIMITS }) {
  const started = Date.now();
  const tools = toolsFor(setup);
  const system = SYSTEM_PROMPT;
  const definitions = tools.map((t) => t.definition);
  /** @type {any[]} */
  const messages = [{ role: 'user', content: taskText(fault) }];
  /** @type {RunCounts} */
  const counts = {
    stopReason: 'unknown', error: null, doneSummary: null, requests: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0,
    largestRequestTokens: 0, finalContextTokens: 0, toolCalls: {}, toolErrors: 0, readFileChars: 0, edits: 0, wallMs: 0,
  };
  log({ type: 'start', setup, fault: fault.id, system, tools: definitions, task: messages[0].content });
  const hooks = { onRetry: (/** @type {object} */ info) => log({ type: 'retry', ...info }) };
  let reminded = false;
  let lastInput = 0;
  let lastOutput = 0;
  let newChars = JSON.stringify(messages).length + system.length + JSON.stringify(definitions).length;
  const end = (/** @type {string} */ reason, /** @type {string|null} */ error = null) => {
    counts.stopReason = reason;
    counts.error = error;
    counts.wallMs = Date.now() - started;
    log({ type: 'end', ...counts });
    return counts;
  };

  for (;;) {
    if (counts.requests >= limits.maxRequests) return end('max_requests');
    const request = { system, messages, tools: definitions };
    let estimate = lastInput + lastOutput + Math.ceil(newChars / ESTIMATE_CHARS_PER_TOKEN);
    if (estimate > EXACT_COUNT_FROM) {
      try {
        estimate = await model.countTokens(request, hooks);
        log({ type: 'count', tokens: estimate });
      } catch (error) {
        return end('error', error instanceof ModelError ? error.reason : String(error));
      }
    }
    if (estimate > limits.maxInputTokensPerRequest) return end('request_too_large');

    let message;
    try {
      log({ type: 'request', n: counts.requests + 1 });
      message = await model.nextMessage(request, hooks);
    } catch (error) {
      return end('error', error instanceof ModelError ? error.reason : String(error));
    }
    counts.requests++;
    const input = message.usage?.input_tokens ?? 0;
    const output = message.usage?.output_tokens ?? 0;
    counts.inputTokens += input;
    counts.outputTokens += output;
    counts.thinkingTokens += message.usage?.output_tokens_details?.thinking_tokens ?? 0;
    counts.largestRequestTokens = Math.max(counts.largestRequestTokens, input);
    lastInput = input;
    lastOutput = output;
    counts.finalContextTokens = input + output;
    newChars = 0;
    log({ type: 'response', stop_reason: message.stop_reason, usage: message.usage, content: message.content });
    messages.push({ role: 'assistant', content: message.content });

    if (message.stop_reason === 'tool_use') {
      const calls = message.content.filter((/** @type {any} */ b) => b.type === 'tool_use');
      const results = [];
      let doneCalled = false;
      for (const block of calls) {
        counts.toolCalls[block.name] = (counts.toolCalls[block.name] ?? 0) + 1;
        const answer = await callTool(tools, block.name, block.input, { workdir });
        if (answer.is_error) counts.toolErrors++;
        if (block.name === 'read_file' && !answer.is_error) counts.readFileChars += answer.content.length;
        if (block.name === 'edit_file' && !answer.is_error) counts.edits++;
        if (block.name === 'done' && !answer.is_error) {
          doneCalled = true;
          counts.doneSummary = String(block.input?.summary ?? '');
        }
        log({ type: 'tool', name: block.name, input: block.input, is_error: answer.is_error ?? false, content: answer.content });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: answer.content, ...(answer.is_error ? { is_error: true } : {}) });
      }
      if (doneCalled) return end('done');
      messages.push({ role: 'user', content: results });
      newChars = JSON.stringify(results).length;
    } else if (message.stop_reason === 'end_turn') {
      if (reminded) return end('end_turn_without_done');
      reminded = true;
      messages.push({ role: 'user', content: REMINDER });
      newChars = REMINDER.length;
      log({ type: 'reminder' });
    } else if (message.stop_reason === 'pause_turn') {
      continue;
    } else {
      return end(String(message.stop_reason ?? 'no_stop_reason'));
    }
    if (counts.inputTokens >= limits.maxInputTokensPerRun) return end('run_input_tokens');
  }
}
