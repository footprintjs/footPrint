/**
 * How a question prints the members of a list, so that the text and the
 * `answer` tool's schema can never disagree: both come from the same sorted
 * `options` array of the shape.
 * Example: `choose(['no', 'yes'])` → `Choose from: "no", "yes".`
 */

/** @param {readonly string[]} options */
export function choose(options) {
  return `Choose from: ${options.map((o) => `"${o}"`).join(', ')}.`;
}

/** The sorted copy of a list of options (shapes must list options sorted). @param {string[]} options */
export function sorted(options) {
  return Object.freeze([...options].sort());
}
