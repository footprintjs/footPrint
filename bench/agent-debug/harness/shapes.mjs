/**
 * The answer shapes of the understanding questions (RULE-2.md, "The tasks"),
 * and the ONE comparison rule for each: no judge, no partial credit.
 *
 * | Shape | The agent gives | Right when |
 * |---|---|---|
 * | `number` | a JSON number | equal to the expected number after both are rounded to the cent |
 * | `enum` | one member of the printed list | the same member |
 * | `set` | members of the printed list, each once | the same members, in any order |
 * | `list` | members of the printed list, each once | the same members in the same order |
 * | `boolean` | `true` (yes) or `false` (no) | the same value |
 * | `object` | an object with exactly the shape's fields | every field right by its own shape |
 *
 * A malformed answer (a string where a number belongs, a member not in the
 * list, a member twice, a missing or extra field) is wrong, and the reason
 * is kept. Rounding to the cent: `Math.round(x × 100)` after the product is
 * read to 12 significant digits, so a product that floating point leaves at
 * 100.49999999999999 counts as 100.5 (`1.005` and `1.0050000001` round
 * alike). So 49.999 against 50 is right (both are 50.00 to the cent) and
 * 49.994 against 50 is wrong.
 * Options are listed in sorted order (`checkShape` refuses any other), an
 * order that cannot know which member is right.
 * Example: `compareAnswer({ type: 'set', options: ['a', 'b', 'c'] }, ['a', 'c'], ['c', 'a'])` → `{ right: true, problem: null }`.
 */

const LISTED = new Set(['enum', 'set', 'list']);
const FIELD_TYPES = new Set(['number', 'enum', 'set', 'list', 'boolean']);

/** Whole cents of a number, robust to floating-point products such as 100.49999999999999. */
export function cents(x) {
  return Math.round(Number((x * 100).toPrecision(12)));
}

/** A number rounded to the cent, as the generator stores expected numbers. */
export function toCent(x) {
  return cents(x) / 100;
}

/**
 * Refuses a shape that is not one of the table's, or whose options are not
 * distinct, non-empty and sorted.
 * @param {any} shape @param {boolean} [inObject]
 */
export function checkShape(shape, inObject = false) {
  if (!shape || typeof shape !== 'object') throw new Error('a shape must be an object');
  if (inObject ? !FIELD_TYPES.has(shape.type) : !FIELD_TYPES.has(shape.type) && shape.type !== 'object') {
    throw new Error(`unknown shape type ${JSON.stringify(shape.type)}${inObject ? ' inside an object' : ''}`);
  }
  if (LISTED.has(shape.type)) {
    const { options } = shape;
    if (!Array.isArray(options) || options.length < 2) throw new Error('a listed shape needs at least two options');
    if (options.some((o) => typeof o !== 'string' || o.trim() === '')) throw new Error('every option is a non-empty string');
    if (new Set(options).size !== options.length) throw new Error('options must be distinct');
    if (JSON.stringify([...options].sort()) !== JSON.stringify(options)) throw new Error(`options must be listed in sorted order: ${JSON.stringify(options)}`);
  }
  if (shape.type === 'object') {
    const names = Object.keys(shape.fields ?? {});
    if (names.length === 0) throw new Error('an object shape needs fields');
    for (const name of names) {
      if (!/^[a-z][A-Za-z]*$/.test(name)) throw new Error(`field name ${name} must be one word`);
      checkShape(shape.fields[name], true);
    }
  }
  return shape;
}

/**
 * The JSON schema of an answer of this shape: the `answer` field of the
 * `answer` tool's input (tools/answer.mjs).
 * @param {any} shape @returns {object}
 */
export function schemaOf(shape) {
  switch (shape.type) {
    case 'number':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean', description: 'true for yes, false for no' };
    case 'enum':
      return { type: 'string', enum: [...shape.options] };
    case 'set':
      return { type: 'array', items: { type: 'string', enum: [...shape.options] }, uniqueItems: true, description: 'every member that applies, each once, in any order' };
    case 'list':
      return { type: 'array', items: { type: 'string', enum: [...shape.options] }, uniqueItems: true, description: 'the members in the order the question asks for, each once' };
    case 'object':
      return {
        type: 'object',
        properties: Object.fromEntries(Object.entries(shape.fields).map(([k, v]) => [k, schemaOf(v)])),
        required: Object.keys(shape.fields),
        additionalProperties: false,
      };
    default:
      throw new Error(`unknown shape type ${shape.type}`);
  }
}

/** Why `value` is not a well-formed answer of `shape`, or null when it is. @returns {string | null} */
export function malformed(shape, value) {
  switch (shape.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'not a finite JSON number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'not true or false';
    case 'enum':
      return typeof value === 'string' && shape.options.includes(value) ? null : 'not one of the listed options';
    case 'set':
    case 'list': {
      if (!Array.isArray(value)) return 'not a list';
      if (value.some((v) => typeof v !== 'string' || !shape.options.includes(v))) return 'a member that is not one of the listed options';
      if (new Set(value).size !== value.length) return 'a member given twice';
      return null;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object';
      const names = Object.keys(shape.fields);
      const extra = Object.keys(value).filter((k) => !names.includes(k));
      if (extra.length) return `fields that are not asked for: ${extra.join(', ')}`;
      for (const name of names) {
        if (!Object.hasOwn(value, name)) return `the field ${name} is missing`;
        const inner = malformed(shape.fields[name], value[name]);
        if (inner) return `${name}: ${inner}`;
      }
      return null;
    }
    default:
      return `unknown shape type ${shape.type}`;
  }
}

/** Whether two WELL-FORMED values of a shape are equal by the shape's rule. */
function equal(shape, expected, given) {
  switch (shape.type) {
    case 'number':
      return cents(expected) === cents(given);
    case 'boolean':
    case 'enum':
      return expected === given;
    case 'set':
      return expected.length === given.length && expected.every((m) => given.includes(m));
    case 'list':
      return expected.length === given.length && expected.every((m, i) => given[i] === m);
    case 'object':
      return Object.keys(shape.fields).every((name) => equal(shape.fields[name], expected[name], given[name]));
    default:
      return false;
  }
}

/**
 * Scores one answer. A malformed answer is wrong, with its reason.
 * @param {any} shape @param {unknown} expected @param {unknown} given
 * @returns {{ right: boolean, problem: string | null }}
 */
export function compareAnswer(shape, expected, given) {
  const bad = malformed(shape, expected);
  if (bad) throw new Error(`the expected answer itself is malformed (${bad}); the question is broken`);
  const problem = given === undefined ? 'no answer was given' : malformed(shape, given);
  if (problem) return { right: false, problem };
  return { right: equal(shape, expected, given), problem: null };
}

/**
 * A well-formed WRONG answer of the shape, for the rehearsal's scripted
 * agent that answers wrong (harness/scripts.mjs). Deterministic.
 * @param {any} shape @param {any} expected
 */
export function wrongOf(shape, expected) {
  switch (shape.type) {
    case 'number':
      return toCent(expected + 1);
    case 'boolean':
      return !expected;
    case 'enum':
      return shape.options.find((o) => o !== expected);
    case 'set': {
      const first = shape.options[0];
      return expected.includes(first) ? expected.filter((m) => m !== first) : [...expected, first];
    }
    case 'list':
      return expected.length > 1 ? [...expected].reverse() : shape.options.filter((o) => !expected.includes(o)).slice(0, 1);
    case 'object': {
      const [name] = Object.keys(shape.fields);
      return { ...expected, [name]: wrongOf(shape.fields[name], expected[name]) };
    }
    default:
      throw new Error(`unknown shape type ${shape.type}`);
  }
}
