/**
 * Flowchart: Structural-Only Dynamic Subflow (Pre-Executed Subflow)
 *
 * Sometimes an inner flow has already executed before the parent flow runs.
 * For example, in HTTP request tracing, the route handler executes business
 * logic (an inner flowchart), and the request wrapper flow runs afterward
 * to capture the trace. The inner flow is done -- we just need its structure
 * attached for visualization.
 *
 * The HANDLER stage returns a StageNode with:
 *   - isSubflowRoot: true
 *   - subflowDef.buildTimeStructure (the inner flow's shape)
 *   - NO subflowDef.root (no execution -- the flow already ran)
 *
 * The engine's Phase 4 detects this and annotates the runtime structure
 * without invoking SubflowExecutor. Zero scope leakage, zero execution.
 *
 *   Parent:  REQUEST_START -> HANDLER [structural: Validate-Input -> Create-Grade] -> RESPONSE
 *   Inner:   (already executed -- only the structure is attached)
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';

(async () => {

// -- Simulate an inner flow that already executed -------------------------

const innerFlowResult = {
  flowId: 'create-grade',
  description: 'Grade creation pipeline (pre-executed in route handler)',
  result: { gradeId: 'G-42', status: 'created' },
  buildTimeStructure: {
    name: 'Validate-Input',
    id: 'validate-input',
    type: 'stage' as const,
    next: {
      name: 'Create-Grade',
      id: 'create-grade',
      type: 'stage' as const,
    },
  },
};

// -- Parent flow ----------------------------------------------------------

interface RequestState {
  method: string;
  path: string;
  requestId: string;
  handlerResult: unknown;
  statusCode: number;
  outcome: string;
}

const chart = flowChart<RequestState>(
  'REQUEST_START',
  async (scope) => {
    scope.method = 'POST';
    scope.path = '/v2/grades';
    scope.requestId = 'req-' + Date.now();
  },
  'request-start',
  undefined,
  'Capture request metadata and assign correlation ID',
)

  .addFunction(
    'HANDLER',
    async (scope) => {
      scope.handlerResult = innerFlowResult.result;
      scope.statusCode = 201;

      return {
        name: 'HANDLER',
        id: 'handler',
        isSubflowRoot: true,
        subflowId: innerFlowResult.flowId,
        subflowName: innerFlowResult.flowId,
        description: innerFlowResult.description,
        subflowDef: {
          buildTimeStructure: innerFlowResult.buildTimeStructure,
        },
      } as any;
    },
    'handler',
    'Execute the route handler',
  )
  .addFunction(
    'RESPONSE',
    async (scope) => {
      scope.outcome = scope.statusCode < 400 ? 'success' : 'error';
    },
    'response',
    'Classify and finalize the HTTP response.',
  )
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run();

console.log('=== Structural-Only Dynamic Subflow ===\n');
executor.getNarrative().forEach((line) => console.log(`  ${line}`));

const snapshot = executor.getSnapshot();
console.log('\nState:', JSON.stringify(snapshot.sharedState, null, 2));

})().catch(console.error);
