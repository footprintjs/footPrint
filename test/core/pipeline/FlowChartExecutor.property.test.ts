/**
 * FlowChartExecutor.property.test.ts
 *
 * Property-based tests for FlowChartExecutor using fast-check.
 * These tests validate correctness properties defined in the design document.
 *
 * **Feature: flowchart-executor-rename**
 */

import * as fc from 'fast-check';
import { FlowChartExecutor, FlowChart } from '../../../src/core/pipeline/FlowChartExecutor';
import { Pipeline, StageNode } from '../../../src/core/pipeline/Pipeline';
import { FlowChartBuilder, flowChart } from '../../../src/builder/FlowChartBuilder';
import { StageContext } from '../../../src/core/context/StageContext';
import { ScopeFactory } from '../../../src/core/context/types';
import { PipelineStageFunction } from '../../../src/core/pipeline/types';

// Simple scope factory for testing
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

describe('FlowChartExecutor Property-Based Tests', () => {
  /**
   * **Feature: flowchart-executor-rename, Property 1: FlowChart Extraction Correctness**
   * ------------------------------------------------------------------
   * For any valid FlowChart object passed to FlowChartExecutor, the executor
   * SHALL correctly extract and use the `root`, `stageMap`, and `extractor`
   * properties, producing identical execution behavior to the old Pipeline
   * constructor that accepted these as separate parameters.
   *
   * **Validates: Requirements 3.1, 3.4**
   */
  describe('Property 1: FlowChart Extraction Correctness', () => {
    it('executor extracts root, stageMap, and extractor correctly from FlowChart', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random stage names (1-5 stages)
          fc.array(
            fc.string({ minLength: 3, maxLength: 15 }).filter(s => /^[a-z][a-zA-Z0-9]*$/.test(s)),
            { minLength: 1, maxLength: 5 }
          ),
          async (stageNames) => {
            // Ensure unique stage names
            const uniqueNames = [...new Set(stageNames)];
            if (uniqueNames.length === 0) return; // Skip if no valid names

            // Track execution order
            const executorOrder: string[] = [];
            const pipelineOrder: string[] = [];

            // Build two identical flowcharts - one for executor, one for pipeline
            const buildFlowChart = (orderTracker: string[]): FlowChart => {
              let builder = new FlowChartBuilder();
              builder = builder.start(uniqueNames[0], () => {
                orderTracker.push(uniqueNames[0]);
                return `output-${uniqueNames[0]}`;
              });

              for (let i = 1; i < uniqueNames.length; i++) {
                const name = uniqueNames[i];
                builder = builder.addFunction(name, () => {
                  orderTracker.push(name);
                  return `output-${name}`;
                });
              }

              return builder.build();
            };

            const executorChart = buildFlowChart(executorOrder);
            const pipelineChart = buildFlowChart(pipelineOrder);

            // Execute with FlowChartExecutor
            const executor = new FlowChartExecutor(executorChart, testScopeFactory);
            await executor.run();

            // Execute with Pipeline directly
            const pipeline = new Pipeline(
              pipelineChart.root,
              pipelineChart.stageMap,
              testScopeFactory,
            );
            await pipeline.execute();

            // PROPERTY: Execution order should be identical
            expect(executorOrder).toEqual(pipelineOrder);

            // PROPERTY: Both should have executed all stages
            expect(executorOrder.length).toBe(uniqueNames.length);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('executor correctly uses extractor from FlowChart', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 3, maxLength: 15 }).filter(s => /^[a-z][a-zA-Z0-9]*$/.test(s)),
          async (stageName) => {
            // Track extractor calls
            const executorExtractions: string[] = [];
            const pipelineExtractions: string[] = [];

            // Build flowchart with extractor for executor
            const executorChart = new FlowChartBuilder()
              .start(stageName, () => `output-${stageName}`)
              .addTraversalExtractor((snapshot) => {
                executorExtractions.push(snapshot.node.name);
                return { extracted: snapshot.node.name };
              })
              .build();

            // Build flowchart with extractor for pipeline
            const pipelineChart = new FlowChartBuilder()
              .start(stageName, () => `output-${stageName}`)
              .addTraversalExtractor((snapshot) => {
                pipelineExtractions.push(snapshot.node.name);
                return { extracted: snapshot.node.name };
              })
              .build();

            // Execute with FlowChartExecutor
            const executor = new FlowChartExecutor(executorChart, testScopeFactory);
            await executor.run();

            // Execute with Pipeline directly
            const pipeline = new Pipeline(
              pipelineChart.root,
              pipelineChart.stageMap,
              testScopeFactory,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              pipelineChart.extractor,
            );
            await pipeline.execute();

            // PROPERTY: Extractor should be called the same number of times
            expect(executorExtractions.length).toBe(pipelineExtractions.length);

            // PROPERTY: Extractor should receive the same stage names
            expect(executorExtractions).toEqual(pipelineExtractions);

            // PROPERTY: Extracted results should be accessible
            const executorResults = executor.getExtractedResults();
            const pipelineResults = pipeline.getExtractedResults();
            expect(executorResults.size).toBe(pipelineResults.size);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: flowchart-executor-rename, Property 2: Execution Semantics Preservation**
   * ------------------------------------------------------------------
   * For any flowchart definition, calling `executor.run()` SHALL produce
   * identical results to what `pipeline.execute()` would have produced
   * with the same flowchart and configuration.
   *
   * **Validates: Requirements 4.2, 5.3**
   */
  describe('Property 2: Execution Semantics Preservation', () => {
    it('run() produces identical results to Pipeline.execute()', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random output values
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.integer({ min: 1, max: 100 }),
          async (stringOutput, numericOutput) => {
            // Build identical flowcharts
            const buildChart = (): FlowChart => {
              return new FlowChartBuilder()
                .start('entry', (scope: StageContext) => {
                  scope.setObject([], 'stringValue', stringOutput);
                  return stringOutput;
                })
                .addFunction('process', (scope: StageContext) => {
                  scope.setObject([], 'numericValue', numericOutput);
                  return numericOutput;
                })
                .build();
            };

            const executorChart = buildChart();
            const pipelineChart = buildChart();

            // Execute with FlowChartExecutor
            const executor = new FlowChartExecutor(executorChart, testScopeFactory);
            const executorResult = await executor.run();

            // Execute with Pipeline directly
            const pipeline = new Pipeline(
              pipelineChart.root,
              pipelineChart.stageMap,
              testScopeFactory,
            );
            const pipelineResult = await pipeline.execute();

            // PROPERTY: Results should have same structure
            expect(executorResult.success).toBe(pipelineResult.success);

            // PROPERTY: Context trees should have same global values
            const executorTree = executor.getContextTree();
            const pipelineTree = pipeline.getContextTree();

            const executorGlobal = executorTree.globalContext as Record<string, unknown>;
            const pipelineGlobal = pipelineTree.globalContext as Record<string, unknown>;

            expect(executorGlobal.stringValue).toBe(pipelineGlobal.stringValue);
            expect(executorGlobal.numericValue).toBe(pipelineGlobal.numericValue);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('run() and execute() produce identical results on same executor', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          async (output) => {
            // Build two identical flowcharts
            const buildChart = (): FlowChart => {
              return new FlowChartBuilder()
                .start('entry', () => output)
                .build();
            };

            const chart1 = buildChart();
            const chart2 = buildChart();

            // Execute with run()
            const executor1 = new FlowChartExecutor(chart1, testScopeFactory);
            const runResult = await executor1.run();

            // Execute with execute() (deprecated alias)
            const executor2 = new FlowChartExecutor(chart2, testScopeFactory);
            const executeResult = await executor2.execute();

            // PROPERTY: Both methods should produce identical results
            expect(runResult.success).toBe(executeResult.success);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('preserves execution semantics for fork patterns', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          async (numChildren) => {
            const executorOutputs: string[] = [];
            const pipelineOutputs: string[] = [];

            // Build flowchart with fork pattern
            const buildChart = (outputTracker: string[]): FlowChart => {
              const children = Array.from({ length: numChildren }, (_, i) => ({
                id: `child${i}`,
                name: `child${i}`,
                fn: () => {
                  outputTracker.push(`child${i}`);
                  return `output-${i}`;
                },
              }));

              return new FlowChartBuilder()
                .start('entry', () => 'entry-output')
                .addListOfFunction(children)
                .build();
            };

            const executorChart = buildChart(executorOutputs);
            const pipelineChart = buildChart(pipelineOutputs);

            // Execute with FlowChartExecutor
            const executor = new FlowChartExecutor(executorChart, testScopeFactory);
            await executor.run();

            // Execute with Pipeline directly
            const pipeline = new Pipeline(
              pipelineChart.root,
              pipelineChart.stageMap,
              testScopeFactory,
            );
            await pipeline.execute();

            // PROPERTY: Same number of children executed
            expect(executorOutputs.length).toBe(pipelineOutputs.length);
            expect(executorOutputs.length).toBe(numChildren);

            // PROPERTY: Same children executed (order may vary due to parallel execution)
            expect(executorOutputs.sort()).toEqual(pipelineOutputs.sort());
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  /**
   * **Feature: flowchart-executor-rename, Property 3: Factory Function Equivalence**
   * ------------------------------------------------------------------
   * For any valid parameters `(name, fn?, id?, displayName?)`, calling
   * `flowChart(name, fn, id, displayName).build()` SHALL produce an equivalent
   * FlowChart to `new FlowChartBuilder().start(name, fn, id, displayName).build()`.
   *
   * **Validates: Requirements 7.2, 7.3**
   */
  describe('Property 3: Factory Function Equivalence', () => {
    it('flowChart() produces equivalent FlowChart to new FlowChartBuilder().start()', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate random stage name
          fc.string({ minLength: 3, maxLength: 15 }).filter(s => /^[a-z][a-zA-Z0-9]*$/.test(s)),
          // Generate optional id
          fc.option(fc.string({ minLength: 3, maxLength: 15 }).filter(s => /^[a-z][a-zA-Z0-9]*$/.test(s))),
          // Generate optional displayName
          fc.option(fc.string({ minLength: 1, maxLength: 30 })),
          async (name, id, displayName) => {
            const fn: PipelineStageFunction = () => `output-${name}`;

            // Build with factory function
            const factoryChart = flowChart(name, fn, id ?? undefined, displayName ?? undefined).build();

            // Build with constructor + start()
            const constructorChart = new FlowChartBuilder()
              .start(name, fn, id ?? undefined, displayName ?? undefined)
              .build();

            // PROPERTY: Root node names should match
            expect(factoryChart.root.name).toBe(constructorChart.root.name);

            // PROPERTY: Root node ids should match
            expect(factoryChart.root.id).toBe(constructorChart.root.id);

            // PROPERTY: Stage maps should have same size
            expect(factoryChart.stageMap.size).toBe(constructorChart.stageMap.size);

            // PROPERTY: Stage maps should have same keys
            const factoryKeys = [...factoryChart.stageMap.keys()].sort();
            const constructorKeys = [...constructorChart.stageMap.keys()].sort();
            expect(factoryKeys).toEqual(constructorKeys);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('flowChart() chains produce equivalent results to FlowChartBuilder chains', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate 2-4 stage names
          fc.array(
            fc.string({ minLength: 3, maxLength: 15 }).filter(s => /^[a-z][a-zA-Z0-9]*$/.test(s)),
            { minLength: 2, maxLength: 4 }
          ),
          async (stageNames) => {
            // Ensure unique names
            const uniqueNames = [...new Set(stageNames)];
            if (uniqueNames.length < 2) return;

            const factoryOutputs: string[] = [];
            const constructorOutputs: string[] = [];

            // Build with factory function
            let factoryBuilder = flowChart(uniqueNames[0], () => {
              factoryOutputs.push(uniqueNames[0]);
              return `output-${uniqueNames[0]}`;
            });
            for (let i = 1; i < uniqueNames.length; i++) {
              const name = uniqueNames[i];
              factoryBuilder = factoryBuilder.addFunction(name, () => {
                factoryOutputs.push(name);
                return `output-${name}`;
              });
            }
            const factoryChart = factoryBuilder.build();

            // Build with constructor + start()
            let constructorBuilder = new FlowChartBuilder().start(uniqueNames[0], () => {
              constructorOutputs.push(uniqueNames[0]);
              return `output-${uniqueNames[0]}`;
            });
            for (let i = 1; i < uniqueNames.length; i++) {
              const name = uniqueNames[i];
              constructorBuilder = constructorBuilder.addFunction(name, () => {
                constructorOutputs.push(name);
                return `output-${name}`;
              });
            }
            const constructorChart = constructorBuilder.build();

            // Execute both
            const factoryExecutor = new FlowChartExecutor(factoryChart, testScopeFactory);
            await factoryExecutor.run();

            const constructorExecutor = new FlowChartExecutor(constructorChart, testScopeFactory);
            await constructorExecutor.run();

            // PROPERTY: Execution order should be identical
            expect(factoryOutputs).toEqual(constructorOutputs);

            // PROPERTY: All stages should execute
            expect(factoryOutputs.length).toBe(uniqueNames.length);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('flowChart() without fn parameter produces valid builder', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 3, maxLength: 15 }).filter(s => /^[a-z][a-zA-Z0-9]*$/.test(s)),
          async (name) => {
            // Build with factory function (no fn parameter)
            const factoryChart = flowChart(name).build();

            // Build with constructor + start() (no fn parameter)
            const constructorChart = new FlowChartBuilder().start(name).build();

            // PROPERTY: Both should produce valid flowcharts
            expect(factoryChart.root).toBeDefined();
            expect(constructorChart.root).toBeDefined();

            // PROPERTY: Root names should match
            expect(factoryChart.root.name).toBe(constructorChart.root.name);
            expect(factoryChart.root.name).toBe(name);

            // PROPERTY: Stage maps should be empty (no fn provided)
            expect(factoryChart.stageMap.size).toBe(0);
            expect(constructorChart.stageMap.size).toBe(0);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
