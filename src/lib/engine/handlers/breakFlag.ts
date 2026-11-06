import type { StageContext } from '../../memory/StageContext.js';
import type { BreakFlag } from './types.js';

/**
 * Cooperative stop: finish the stage and keep the first explicit reason.
 *
 * The reason is text the stage's code made, so it is served here, as it is taken (`RedactionRule · retainStageText`:
 * by its name `logs.breakReason`, and by what the stage read and its args hold). The flag only ever holds the served
 * form, so every `onBreak` event — and a subflow's propagated one, read from the inner flag — carries one form.
 */
export function createBreakHandler(flag: BreakFlag, context: StageContext, input: unknown): (reason?: string) => void {
  return (reason?: string) => {
    flag.shouldBreak = true;
    if (reason === undefined || flag.reason !== undefined) return;
    const rule = context.getRedactionRule();
    flag.reason = rule
      ? rule.retainStageText(['logs', 'breakReason'], reason, { input, selectedReads: context.taintedReads })
      : reason;
  };
}
