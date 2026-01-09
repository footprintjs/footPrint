/**
 * Demo 5: Composed Application (The Power Move)
 *
 * Shows how entire applications can be mounted as subtrees in a larger workflow.
 * This is the killer feature - apps become building blocks!
 */

import { FlowChartBuilder, BaseState, Pipeline, BuiltFlow } from 'footprint';

// Simple scope factory
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// ============================================================================
// MINI APPS (simplified versions of demos 1-4 for composition)
// ============================================================================

function buildPaymentApp(): BuiltFlow {
  const validateCart = async () => {
    console.log('    [Payment] Validating cart...');
    return { valid: true, total: 79.98 };
  };

  const processPayment = async () => {
    console.log('    [Payment] Processing payment...');
    return { success: true, txId: `TX-${Date.now()}` };
  };

  return new FlowChartBuilder()
    .start('ValidateCart', validateCart)
    .addFunction('ProcessPayment', processPayment)
    .build();
}

function buildLLMApp(): BuiltFlow {
  const callLLM = async () => {
    console.log('    [LLM] Calling LLM...');
    return { type: 'response', content: 'Hello from LLM!' };
  };

  const formatResponse = async () => {
    console.log('    [LLM] Formatting response...');
    return { formatted: true, message: 'Hello from LLM!' };
  };

  return new FlowChartBuilder()
    .start('CallLLM', callLLM)
    .addFunction('FormatResponse', formatResponse)
    .build();
}

function buildParallelApp(): BuiltFlow {
  const fetchA = async () => {
    console.log('    [Parallel] Fetching A...');
    return { source: 'A', data: 'Data from A' };
  };

  const fetchB = async () => {
    console.log('    [Parallel] Fetching B...');
    return { source: 'B', data: 'Data from B' };
  };

  return new FlowChartBuilder()
    .start('ParallelEntry', async () => ({ started: true }))
    .addListOfFunction([
      { id: 'fetchA', name: 'FetchA', fn: fetchA },
      { id: 'fetchB', name: 'FetchB', fn: fetchB },
    ])
    .build();
}

function buildSelectorApp(): BuiltFlow {
  const analyze = async () => {
    console.log('    [Selector] Analyzing...');
    return { channels: ['email', 'push'] };
  };

  const sendEmail = async () => {
    console.log('    [Selector] Sending email...');
    return { channel: 'email', sent: true };
  };

  const sendPush = async () => {
    console.log('    [Selector] Sending push...');
    return { channel: 'push', sent: true };
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

function buildMegaApp(): BuiltFlow {
  // Build all sub-apps
  const paymentApp = buildPaymentApp();
  const llmApp = buildLLMApp();
  const parallelApp = buildParallelApp();
  const selectorApp = buildSelectorApp();

  // Orchestrator entry point
  const orchestrate = async () => {
    console.log('\n  [Orchestrator] Starting mega workflow...');
    console.log('  [Orchestrator] Launching 4 sub-applications in parallel!\n');
    return { orchestrated: true, timestamp: Date.now() };
  };

  // Final aggregation
  const aggregate = async () => {
    console.log('\n  [Aggregate] Collecting results from all apps...');
    return {
      completed: true,
      appsExecuted: ['payment', 'llm', 'parallel', 'selector'],
      timestamp: Date.now(),
    };
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
