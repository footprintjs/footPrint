import { failureReceipt } from '../../errors/failureRetention/index.js';
import type { RedactionRule } from '../redaction.js';
import { unknownErrorSources } from './origins.js';
import { serveOwnedError } from './owned.js';

/** Consume the selected native failure, or explicitly retain unknown sources. */
export function escapingError(rule: Pick<RedactionRule, 'servedError'>, error: unknown, state?: object) {
  const projection = state && failureReceipt(state, error)?.projection;
  return projection ? { ...projection.structuredError } : serveOwnedError(rule, error, unknownErrorSources());
}
