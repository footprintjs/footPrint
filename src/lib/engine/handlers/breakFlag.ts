import type { BreakFlag } from './types.js';

/** Cooperative stop: finish the stage and keep the first explicit reason. */
export function createBreakHandler(flag: BreakFlag): (reason?: string) => void {
  return (reason?: string) => {
    flag.shouldBreak = true;
    if (reason !== undefined && flag.reason === undefined) flag.reason = reason;
  };
}
