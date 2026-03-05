/**
 * Demo 6: Subflow with TraversalExtractor
 *
 * Shows how TraversalExtractor works with subflows:
 * - stepNumber generation for subflow stages
 * - Accessing subflow execution data
 * - Structure comes from build time, execution from runtime
 */

import { FlowChartBuilder, BaseState, TraversalExtractor } from 'footprint';

// Simple scope factory
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// Define extracted data shape
interface StageMetadata {
  stageName: string;
  stepNumber: number;
  isSubflow: boolean;
}

// Extractor that captures execution metadata
const metadataExtractor: TraversalExtractor<StageMetadata> = (snapshot) => {
  const { node, stepNumber, structureMetadata } = snapshot;
  return {
    stageName: node.name,
    stepNumber,
    isSubflow: Boolean(structureMetadata.isSubflowRoot),
  };
};

// Main flow stages
const prepareRequest = async (scope: BaseState) => {
  console.log('  [Main] Preparing request...');
  scope.setValue('request', { query: 'Hello, world!' });
};

const aggregateResults = async (scope: BaseState) => {
  console.log('  [Main] Aggregating results...');
  const llmResponse = scope.getValue('llmResponse');
  console.log(`      LLM said: ${llmResponse}`);
};

// Subflow stages (LLM Core)
const callLLM = async (scope: BaseState) => {
  console.log('  [Subflow] Calling LLM...');
  const response = 'Hello! How can I help you today?';
  scope.setValue('llmResponse', response);
};

const processResponse = async (scope: BaseState) => {
  console.log('  [Subflow] Processing response...');
  const response = scope.getValue('llmResponse');
  console.log(`      Processed: ${response}`);
};

// Build the subflow (LLM Core)
function buildLLMCoreSubflow() {
  return new FlowChartBuilder()
    .start('callLLM', callLLM)
    .addFunction('processResponse', processResponse)
    .build();
}

// Build the main flow with subflow
export function buildMainFlowWithSubflow() {
  const llmCore = buildLLMCoreSubflow();

  return new FlowChartBuilder()
    .start('prepareRequest', prepareRequest)
    .addSubFlowChart('llm-core', llmCore, 'LLM Core')
    .addFunction('aggregateResults', aggregateResults)
    .addTraversalExtractor(metadataExtractor)
    .build();
}

// Execute the demo
async function main() {
  console.log('\n=== Subflow with TraversalExtractor Demo ===\n');

  const { root, stageMap, extractor, subflows } = buildMainFlowWithSubflow();

  // Import Pipeline to access extracted results
  const { Pipeline } = await import('footprint');

  const pipeline = new Pipeline(
    root,
    stageMap,
    scopeFactory,
    undefined, // defaultValuesForContext
    undefined, // initialContext
    undefined, // readOnlyContext
    undefined, // throttlingErrorChecker
    undefined, // streamHandlers
    extractor,
    'error',   // scopeProtectionMode
    subflows,
  );

  console.log('Executing pipeline...\n');
  const result = await pipeline.execute();

  console.log('\n--- Extracted Results ---');
  const extractedResults = pipeline.getExtractedResults<StageMetadata>();
  
  // Display results in execution order (by stepNumber)
  const sortedResults = Array.from(extractedResults.entries())
    .sort((a, b) => a[1].stepNumber - b[1].stepNumber);

  for (const [path, metadata] of sortedResults) {
    console.log(`  Step ${metadata.stepNumber}: ${path}`);
    console.log(`    - isSubflow: ${metadata.isSubflow}`);
  }

  console.log('\n--- Subflow Results ---');
  const subflowResults = pipeline.getSubflowResults();
  for (const [id, subflowResult] of subflowResults) {
    console.log(`  Subflow: ${id} (${subflowResult.subflowName})`);
    console.log(`    - Parent Stage: ${subflowResult.parentStageId}`);
  }

  console.log('\n--- Key Insight ---');
  console.log('  Structure = Build time (from toSpec() or subflows dictionary)');
  console.log('  Execution = Runtime (from TraversalExtractor with stepNumber)');

  console.log('\n✓ Subflow with extractor demo complete!');
}

main().catch(console.error);
