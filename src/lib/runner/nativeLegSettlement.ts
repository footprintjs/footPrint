import type { ExecutorResult } from '../engine/types.js';
import type { RunFrame } from '../memory/RunFrame.js';

/** Per-entry terminal data; no additional promise boundary or execution policy. */
export interface NativeLegSettlement {
  frame?: RunFrame;
  completed: boolean;
  escaped?: { readonly reason: unknown };
  cleanupFailure?: { readonly reason: unknown };
}

export function nativeLegResult(terminal: NativeLegSettlement, result: ExecutorResult): ExecutorResult {
  if (terminal.escaped) throw terminal.escaped.reason;
  if (terminal.cleanupFailure) throw terminal.cleanupFailure.reason;
  return result;
}
