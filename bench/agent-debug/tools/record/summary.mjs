/**
 * Short, bounded summaries of recorded values, so a record tool never pours
 * a whole object into the model's context.
 *
 * Example: `summarize({ creditLimit: 5000, orderLimit: 3000 })`
 * → `{creditLimit: 5000, orderLimit: 3000}`; a long array → `(12 items)`.
 */

const MAX = 120;

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function summarize(value, max = MAX) {
  const text = render(value, 2);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** @param {unknown} value @param {number} depth @returns {string} */
function render(value, depth) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value.length > 60 ? `${value.slice(0, 59)}…` : value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth <= 0 || value.length > 4) return `(${value.length} items)`;
    return `[${value.map((v) => render(v, depth - 1)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    if (depth <= 0) return `{${keys.join(', ')}}`;
    return `{${keys.map((k) => `${k}: ${render(/** @type {any} */ (value)[k], depth - 1)}`).join(', ')}}`;
  }
  return typeof value;
}
