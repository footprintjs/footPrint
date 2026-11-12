/**
 * How every tool answers: a bounded string, or an error the loop sends back
 * with `is_error: true`. A tool never throws into the loop.
 *
 * Why a fixed bound per tool: an answer goes into every later request of the
 * run, so one long answer is paid for many times. The bound is stated in the
 * tool's description, and a cut answer ends with a line that says so.
 * Example: `bounded('x'.repeat(10), 4)` → `xxxx\n[cut: the answer was 10 characters; only the first 4 are shown]`.
 */

/**
 * @typedef {{ content: string, is_error?: true }} ToolAnswer
 */

/** @param {string} text @param {number} limit @returns {string} */
export function bounded(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[cut: the answer was ${text.length} characters; only the first ${limit} are shown]`;
}

/** @param {string} message @param {number} limit @returns {ToolAnswer} */
export function failure(message, limit) {
  return { content: bounded(`error: ${message}`, limit), is_error: true };
}

/**
 * Wraps a tool body: its string becomes a bounded answer, anything it throws
 * becomes an error answer.
 * @param {number} limit
 * @param {(input: any, context: any) => Promise<string> | string} body
 * @returns {(input: any, context: any) => Promise<ToolAnswer>}
 */
export function tool(limit, body) {
  return async (input, context) => {
    try {
      return { content: bounded(await body(input, context), limit) };
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error), limit);
    }
  };
}

/** Refuses an input that is not a plain object with only the known keys of the right types. */
export function checkInput(input, shape) {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('the input must be an object');
  for (const key of Object.keys(input)) {
    if (!(key in shape)) throw new Error(`unknown input field "${key}"`);
  }
  for (const [key, { type, required }] of Object.entries(shape)) {
    if (input[key] === undefined) {
      if (required) throw new Error(`the input needs "${key}"`);
      continue;
    }
    if (type === 'integer' ? !Number.isInteger(input[key]) : typeof input[key] !== type) {
      throw new Error(`"${key}" must be ${type === 'integer' ? 'a whole number' : `a ${type}`}`);
    }
  }
}
