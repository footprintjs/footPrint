/** Wiring only. Audit control runs the fixed, installed baseline, never the candidate under test. */
import { flowChart, FlowChartExecutor } from 'footprintjs-baseline';
import { admitStage, routeStage, refuseStage } from './plan/stage.mjs';
import { packStage } from './pack/index.mjs';
import { auditStage } from './audit/index.mjs';

export async function runCohort(input, ports) {
  const chart = flowChart('Admit immutable source cohort', admitStage, 'admit')
    .addDeciderFunction('Choose operation', routeStage, 'operation')
    .addFunctionBranch('pack', 'Build selected artifacts', packStage, 'pack')
    .addFunctionBranch('audit', 'Check original consumers', auditStage, 'audit')
    .addFunctionBranch('refuse', 'Refuse unsupported operation', refuseStage, 'refuse')
    .end()
    .build();
  const executor = new FlowChartExecutor(chart);
  await executor.run({ env: { input, ports } });
  return executor.getSnapshot().sharedState;
}
