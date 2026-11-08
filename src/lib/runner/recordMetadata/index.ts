import type { Meta } from 'foottrace';

import type { RunCorrelation } from '../../attempt/types.js';
import type { StageNode } from '../../engine/types.js';
import type { RedactionRule } from '../../memory/redaction.js';
import type { ExecutorArgs } from '../options.js';

/**
 * What a new root log opens with: names and numbers the run already serves — the run, the chart, the correlation,
 * the deadline, the declared budget, and the run a fresh-executor resume continues. Served by the record.
 */
export function openingMeta<TOut, TScope>(
  args: ExecutorArgs<TOut, TScope>,
  readRunId: () => string,
  root: StageNode<TOut, TScope>,
  correlation: RunCorrelation | undefined,
  deadline: number | undefined,
  resumedFrom?: string,
): Meta {
  const budgetMs = args.flowChart.buildTimeStructure?.budgetMs;
  return {
    runId: readRunId(),
    chart: { id: root.id, name: root.name },
    ...(correlation && { correlation }),
    ...(deadline !== undefined && { deadline }),
    ...(budgetMs !== undefined && { budgetMs }),
    ...(resumedFrom !== undefined && { resumedFrom }),
  };
}

/** The closing entry's error: the run's SERVED form of it, its name, message and code only (never `raw`). */
export function closingError(error: unknown, rule: RedactionRule): Meta {
  const info = rule.servedError(error);
  return {
    ...(info.name !== undefined && { name: info.name }),
    message: info.message,
    ...(info.code !== undefined && { code: info.code }),
  };
}
