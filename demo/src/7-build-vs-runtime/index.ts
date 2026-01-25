/**
 * Demo 7: Build-Time vs Runtime Extraction
 *
 * Shows the difference between:
 * - Build-time extraction (toSpec) - Static structure for FE→BE transport
 * - Runtime extraction (TraversalExtractor) - Execution metadata with stepNumber
 */

import { 
  FlowChartBuilder, 
  BaseState, 
  TraversalExtractor, 
  BuildTimeExtractor,
  StageSnapshot,
  BuildTimeNodeMetadata,
} from 'footprint';

// Simple scope factory
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// ============================================================
// BUILD-TIME EXTRACTOR
// Called during toSpec() - transforms static structure
// ============================================================

interface ServicePipelineNode {
  id: string;
  name: string;
  type: 'stage' | 'decider' | 'fork' | 'streaming';
  next?: ServicePipelineNode;
  children?: ServicePipelineNode[];
}

const buildTimeExtractor: BuildTimeExtractor<ServicePipelineNode> = (
  metadata: BuildTimeNodeMetadata
): ServicePipelineNode => {
  // Compute node type from properties
  let type: 'stage' | 'decider' | 'fork' | 'streaming' = 'stage';
  if (metadata.hasDecider || metadata.hasSelector) {
    type = 'decider';
  } else if (metadata.children && metadata.children.length > 0) {
    type = 'fork';
  } else if (metadata.isStreaming) {
    type = 'streaming';
  }

  return {
    id: metadata.id ?? metadata.name,
    name: metadata.name,
    type,
    next: metadata.next as ServicePipelineNode | undefined,
    children: metadata.children as ServicePipelineNode[] | undefined,
  };
};

// ============================================================
// RUNTIME EXTRACTOR
// Called during execution - captures execution metadata
// ============================================================

interface RuntimeStageData {
  stageName: string;
  stepNumber: number;
  executedAt: number;
  output?: unknown;
}

const runtimeExtractor: TraversalExtractor<RuntimeStageData> = (
  snapshot: StageSnapshot
): RuntimeStageData => {
  const { node, context, stepNumber } = snapshot;
  return {
    stageName: node.name,
    stepNumber,
    executedAt: Date.now(),
    output: context.getScope()?.output,
  };
};

// ============================================================
// STAGE FUNCTIONS
// ============================================================

const entry = async (scope: BaseState) => {
  console.log('  [Stage] entry');
  scope.setObject(['pipeline'], 'started', true);
  return { stage: 'entry' };
};

const process = async (scope: BaseState) => {
  console.log('  [Stage] process');
  return { stage: 'process' };
};

const childA = async (scope: BaseState) => {
  console.log('  [Stage] childA');
  return { stage: 'childA' };
};

const childB = async (scope: BaseState) => {
  console.log('  [Stage] childB');
  return { stage: 'childB' };
};

const aggregate = async (scope: BaseState) => {
  console.log('  [Stage] aggregate');
  return { stage: 'aggregate' };
};

// ============================================================
// DEMO
// ============================================================

async function main() {
  console.log('\n=== Build-Time vs Runtime Extraction Demo ===\n');

  // Build the flow with both extractors
  const builder = new FlowChartBuilder()
    .start('entry', entry)
    .addFunction('process', process)
    .addFork()
      .addFunctionBranch('a', 'childA', childA)
      .addFunctionBranch('b', 'childB', childB)
      .end()
    .addFunction('aggregate', aggregate)
    .addBuildTimeExtractor(buildTimeExtractor)
    .addTraversalExtractor(runtimeExtractor);

  // ============================================================
  // BUILD-TIME: Get static structure
  // ============================================================
  console.log('--- BUILD-TIME (toSpec) ---');
  console.log('Static structure for FE→BE transport:\n');
  
  const spec = builder.toSpec<ServicePipelineNode>();
  printNode(spec, 0);

  // ============================================================
  // RUNTIME: Execute and get execution metadata
  // ============================================================
  console.log('\n--- RUNTIME (TraversalExtractor) ---');
  console.log('Execution metadata with stepNumber:\n');

  const { root, stageMap, extractor } = builder.build();
  const { Pipeline } = await import('footprint');

  const pipeline = new Pipeline(
    root,
    stageMap,
    scopeFactory,
    undefined, undefined, undefined, undefined, undefined,
    extractor,
  );

  await pipeline.execute();

  const extractedResults = pipeline.getExtractedResults<RuntimeStageData>();
  const sortedResults = Array.from(extractedResults.entries())
    .sort((a, b) => a[1].stepNumber - b[1].stepNumber);

  for (const [path, data] of sortedResults) {
    console.log(`  Step ${data.stepNumber}: ${path}`);
  }

  // ============================================================
  // KEY DIFFERENCES
  // ============================================================
  console.log('\n--- KEY DIFFERENCES ---');
  console.log('');
  console.log('  BUILD-TIME (toSpec):');
  console.log('    - Called once when building the flow');
  console.log('    - Returns static structure (nodes, edges)');
  console.log('    - Used for FE→BE transport, visualization');
  console.log('    - No execution data (no stepNumber, no scope)');
  console.log('');
  console.log('  RUNTIME (TraversalExtractor):');
  console.log('    - Called after each stage executes');
  console.log('    - Returns execution metadata');
  console.log('    - Includes stepNumber for time traveler sync');
  console.log('    - Has access to scope and context');

  console.log('\n✓ Build-time vs runtime demo complete!');
}

// Helper to print node structure
function printNode(node: ServicePipelineNode, indent: number) {
  const prefix = '  '.repeat(indent);
  console.log(`${prefix}${node.name} (type: ${node.type})`);
  
  if (node.children) {
    for (const child of node.children) {
      printNode(child, indent + 1);
    }
  }
  
  if (node.next) {
    printNode(node.next, indent);
  }
}

main().catch(console.error);
