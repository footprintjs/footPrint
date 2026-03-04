/**
 * Demo 5: Composed Application (The Power Move)
 *
 * Shows how entire applications can be mounted as subtrees in a larger workflow.
 * This is the killer feature - apps become building blocks!
 */

import { FlowChartBuilder, BaseState, Pipeline, FlowChart } from 'footprint';

// Simple scope factory
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// ============================================================================
// MINI APPS (simplified versions of demos 1-4 for composition)
// ============================================================================

function buildPaymentApp(): FlowChart {
  const validateCart = async () => {
    console.log('    [Payment] Validating cart...');
  };

  const processPayment = async () => {
    console.log('    [Payment] Processing payment...');
  };

  return new FlowChartBuilder()
    .start('ValidateCart', validateCart)
    .addFunction('ProcessPayment', processPayment)
    .build();
}

function buildLLMApp(): FlowChart {
  const callLLM = async () => {
    console.log('    [LLM] Calling LLM...');
  };

  const formatResponse = async () => {
    console.log('    [LLM] Formatting response...');
  };

  return new FlowChartBuilder()
    .start('CallLLM', callLLM)
    .addFunction('FormatResponse', formatResponse)
    .build();
}

function buildParallelApp(): FlowChart {
  const fetchA = async () => {
    console.log('    [Parallel] Fetching A...');
    return { source: 'A', data: 'Data from A' }; // Parallel children return into result bundle
  };

  const fetchB = async () => {
    console.log('    [Parallel] Fetching B...');
    return { source: 'B', data: 'Data from B' }; // Parallel children return into result bundle
  };

  return new FlowChartBuilder()
    .start('ParallelEntry', async () => {
      console.log('    [Parallel] Starting...');
    })
    .addListOfFunction([
      { id: 'fetchA', name: 'FetchA', fn: fetchA },
      { id: 'fetchB', name: 'FetchB', fn: fetchB },
    ])
    .build();
}

function buildSelectorApp(): FlowChart {
  // Stage before selector MUST return data — selector reads the output
  const analyze = async () => {
    console.log('    [Selector] Analyzing...');
    return { channels: ['email', 'push'] };
  };

  const sendEmail = async () => {
    console.log('    [Selector] Sending email...');
  };

  const sendPush = async () => {
    console.log('    [Selector] Sending push...');
  };

  const selector = (output: any) => output?.channels || ['email'];

  return new FlowChartBuilder()
    .start('AnalyzeSelector', analyze)
    .addSelector(selector)
      .addFunctionBranch('email', 'SendEmailSelector', sendEmail)
      .addFunctionBranch('push', 'SendPushSelector', sendPush)
      .end()
    .build();
}

// ============================================================================
// MEGA ORCHESTRATOR APP
// ============================================================================

function buildMegaApp(): FlowChart {
  // Build all sub-apps
  const paymentApp = buildPaymentApp();
  const llmApp = buildLLMApp();
  const parallelApp = buildParallelApp();
  const selectorApp = buildSelectorApp();

  // Orchestrator entry point
  const orchestrate = async () => {
    console.log('\n  [Orchestrator] Starting mega workflow...');
    console.log('  [Orchestrator] Launching 4 sub-applications in parallel!\n');
  };

  // Final aggregation
  const aggregate = async () => {
    console.log('\n  [Aggregate] Collecting results from all apps...');
  };

  // THE POWER MOVE: Compose all apps as subtrees!
  return new FlowChartBuilder()
    .start('Orchestrator', orchestrate)
    .addSubFlowChart('payment', paymentApp, 'PaymentApp')
    .addSubFlowChart('llm', llmApp, 'LLMApp')
    .addSubFlowChart('parallel', parallelApp, 'ParallelApp')
    .addSubFlowChart('selector', selectorApp, 'SelectorApp')
    .addFunction('Aggregate', aggregate)
    .build();
}

// ============================================================================
// EXECUTE
// ============================================================================

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('  COMPOSED APPLICATION DEMO (The Power Move)');
  console.log('='.repeat(60));
  console.log('\n  4 complete applications running as nodes in 1 mega-app!\n');

  const { root, stageMap } = buildMegaApp();

  console.log(`  StageMap contains ${stageMap.size} functions from all apps:`);
  for (const name of stageMap.keys()) {
    console.log(`    - ${name}`);
  }

  console.log('\n' + '-'.repeat(60));
  console.log('  EXECUTION');
  console.log('-'.repeat(60));

  const start = Date.now();

  // Execute using Pipeline directly
  const pipeline = new Pipeline(root, stageMap, scopeFactory);
  const result = await pipeline.execute();

  const elapsed = Date.now() - start;

  console.log('\n' + '-'.repeat(60));
  console.log('  RESULTS');
  console.log('-'.repeat(60));
  console.log(`\n  Execution time: ${elapsed}ms`);
  console.log('  Final result:', JSON.stringify(result, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('  ✓ MEGA APP COMPLETE!');
  console.log('='.repeat(60));
  console.log('\n  Key insight: Each "app" (Payment, LLM, Parallel, Selector)');
  console.log('  is a complete workflow that can be developed, tested, and');
  console.log('  deployed independently - then composed into larger systems.\n');
}

main().catch(console.error);
