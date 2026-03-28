/**
 * validateInput — Thin adapter between FlowChartExecutor and the schema library.
 *
 * Delegates all detection and validation to `schema/` — the single source of truth.
 * This file exists to keep FlowChartExecutor's import clean and to cast the result type.
 */

import { validateOrThrow } from '../schema/index.js';

/**
 * Validates `input` against `schema`. Throws InputValidationError on failure.
 * Returns the (possibly transformed) input on success.
 */
export function validateInput(schema: unknown, input: unknown): unknown {
  return validateOrThrow(schema, input);
}
