/**
 * Property-based tests for MetricRecorder
 *
 * These tests verify universal properties that should hold across all valid inputs.
 *
 * Feature: scope-recorder-pattern
 */

import * as fc from 'fast-check';
import { GlobalStore } from '../../src/core/memory/GlobalStore';
import { Scope } from '../../src/scope/Scope';
import { MetricRecorder } from '../../src/scope/recorders/MetricRecorder';

// ============================================================================
// Arbitraries (Generators)
// ============================================================================

/**
 * Reserved JavaScript property names that should not be used as keys.
 * These can cause issues when used as object property names.
 */
const RESERVED_PROPERTY_NAMES = new Set([
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', 'constructor',
  '__proto__', '__defineGetter__', '__defineSetter__',
  '__lookupGetter__', '__lookupSetter__',
  'caller', 'callee', 'arguments',
]);

/**
 * Arbitrary for valid path segments (non-empty strings without special chars).
 * Excludes reserved JavaScript property names to avoid prototype issues.
 */
const arbPathSegment = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
  .filter((s) => !RESERVED_PROPERTY_NAMES.has(s));

/**
 * Arbitrary for valid paths (arrays of path segments).
 */
const arbPath = fc.array(arbPathSegment, { minLength: 1, maxLength: 3 });

/**
 * Arbitrary for valid keys (non-empty strings).
 * Excludes reserved JavaScript property names to avoid prototype issues.
 */
const arbKey = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
  .filter((s) => !RESERVED_PROPERTY_NAMES.has(s));

/**
 * Arbitrary for pipeline IDs.
 */
const arbPipelineId = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

/**
 * Arbitrary for stage names.
 */
const arbStageName = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s));

/**
 * Arbitrary for JSON-serializable primitive values.
 */
const arbPrimitive = fc.oneof(
  fc.string({ maxLength: 50 }),
  fc.integer({ min: -10000, max: 10000 }),
  fc.boolean(),
  fc.constant(null)
);

/**
 * Operation types for generating sequences.
 */
type OperationType = 'read' | 'write' | 'commit';

/**
 * Arbitrary for a single operation.
 */
const arbOperation: fc.Arbitrary<OperationType> = fc.constantFrom('read', 'write', 'commit');

/**
 * Arbitrary for a sequence of operations.
 */
const arbOperationSequence = fc.array(arbOperation, { minLength: 1, maxLength: 50 });

// ============================================================================
// Property Tests
// ============================================================================

describe('MetricRecorder Property Tests', () => {
  describe('Property 13: MetricRecorder Operation Counting', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 13: MetricRecorder Operation Counting
     * **Validates: Requirements 5.2, 5.3, 5.4**
     *
     * For any MetricRecorder attached to a Scope, after N read operations,
     * M write operations, and K commit operations, the metrics SHALL report
     * readCount=N, writeCount=M, commitCount=K.
     */

    test('operation counts match exactly for arbitrary sequences', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbOperationSequence,
          arbPath,
          arbKey,
          arbPrimitive,
          (pipelineId, stageName, operations, path, key, value) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [metricRecorder],
            });

            // Set an initial value so reads return something
            scope.setValue(path, key, value);
            scope.commit();

            // Reset metrics after setup to get clean counts
            metricRecorder.reset();

            // Count expected operations
            let expectedReads = 0;
            let expectedWrites = 0;
            let expectedCommits = 0;

            // Act - execute the operation sequence
            for (const op of operations) {
              switch (op) {
                case 'read':
                  scope.getValue(path, key);
                  expectedReads++;
                  break;
                case 'write':
                  scope.setValue(path, key, value);
                  expectedWrites++;
                  break;
                case 'commit':
                  scope.commit();
                  expectedCommits++;
                  break;
              }
            }

            // Assert - counts should match exactly
            const metrics = metricRecorder.getMetrics();
            expect(metrics.totalReads).toBe(expectedReads);
            expect(metrics.totalWrites).toBe(expectedWrites);
            expect(metrics.totalCommits).toBe(expectedCommits);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('per-stage counts match exactly for single stage', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.nat({ max: 20 }), // N reads
          fc.nat({ max: 20 }), // M writes
          fc.nat({ max: 10 }), // K commits
          arbPath,
          arbKey,
          arbPrimitive,
          (pipelineId, stageName, numReads, numWrites, numCommits, path, key, value) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [metricRecorder],
            });

            // Set an initial value so reads return something
            scope.setValue(path, key, value);
            scope.commit();

            // Reset metrics after setup
            metricRecorder.reset();

            // Act - perform exactly N reads, M writes, K commits
            for (let i = 0; i < numReads; i++) {
              scope.getValue(path, key);
            }
            for (let i = 0; i < numWrites; i++) {
              scope.setValue(path, key, value);
            }
            for (let i = 0; i < numCommits; i++) {
              scope.commit();
            }

            // Assert - per-stage counts should match
            const stageMetrics = metricRecorder.getStageMetrics(stageName);
            expect(stageMetrics).toBeDefined();
            expect(stageMetrics?.readCount).toBe(numReads);
            expect(stageMetrics?.writeCount).toBe(numWrites);
            expect(stageMetrics?.commitCount).toBe(numCommits);

            // Assert - aggregated counts should also match
            const metrics = metricRecorder.getMetrics();
            expect(metrics.totalReads).toBe(numReads);
            expect(metrics.totalWrites).toBe(numWrites);
            expect(metrics.totalCommits).toBe(numCommits);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('per-stage counts are tracked independently across multiple stages', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 4 }),
          fc.array(fc.nat({ max: 10 }), { minLength: 2, maxLength: 4 }), // reads per stage
          fc.array(fc.nat({ max: 10 }), { minLength: 2, maxLength: 4 }), // writes per stage
          fc.array(fc.nat({ max: 5 }), { minLength: 2, maxLength: 4 }), // commits per stage
          arbPath,
          arbKey,
          arbPrimitive,
          (pipelineId, stageNames, readCounts, writeCounts, commitCounts, path, key, value) => {
            // Ensure we have matching arrays
            const numStages = Math.min(stageNames.length, readCounts.length, writeCounts.length, commitCounts.length);
            fc.pre(numStages >= 2);

            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName: stageNames[0],
              globalStore,
              recorders: [metricRecorder],
            });

            // Set an initial value
            scope.setValue(path, key, value);
            scope.commit();
            metricRecorder.reset();

            // Track expected totals
            let expectedTotalReads = 0;
            let expectedTotalWrites = 0;
            let expectedTotalCommits = 0;

            // Act - perform operations in each stage
            for (let s = 0; s < numStages; s++) {
              const stageName = stageNames[s];
              const numReads = readCounts[s];
              const numWrites = writeCounts[s];
              const numCommits = commitCounts[s];

              // Start the stage
              scope.startStage(stageName);

              // Perform operations
              for (let i = 0; i < numReads; i++) {
                scope.getValue(path, key);
              }
              for (let i = 0; i < numWrites; i++) {
                scope.setValue(path, key, value);
              }
              for (let i = 0; i < numCommits; i++) {
                scope.commit();
              }

              // End the stage
              scope.endStage();

              // Update expected totals
              expectedTotalReads += numReads;
              expectedTotalWrites += numWrites;
              expectedTotalCommits += numCommits;
            }

            // Assert - per-stage counts should match
            for (let s = 0; s < numStages; s++) {
              const stageName = stageNames[s];
              const stageMetrics = metricRecorder.getStageMetrics(stageName);

              // Only check if we performed any operations in this stage
              const expectedReads = readCounts[s];
              const expectedWrites = writeCounts[s];
              const expectedCommits = commitCounts[s];

              if (expectedReads > 0 || expectedWrites > 0 || expectedCommits > 0) {
                expect(stageMetrics).toBeDefined();
                expect(stageMetrics?.readCount).toBe(expectedReads);
                expect(stageMetrics?.writeCount).toBe(expectedWrites);
                expect(stageMetrics?.commitCount).toBe(expectedCommits);
              }
            }

            // Assert - aggregated counts should be sum of all stages
            const metrics = metricRecorder.getMetrics();
            expect(metrics.totalReads).toBe(expectedTotalReads);
            expect(metrics.totalWrites).toBe(expectedTotalWrites);
            expect(metrics.totalCommits).toBe(expectedTotalCommits);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('updateValue operations are counted as writes', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.nat({ max: 15 }), // setValues
          fc.nat({ max: 15 }), // updateValues
          arbPath,
          arbKey,
          arbPrimitive,
          (pipelineId, stageName, numSetValues, numUpdateValues, path, key, value) => {
            // Precondition: at least one operation must be performed to test counting
            fc.pre(numSetValues + numUpdateValues > 0);

            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [metricRecorder],
            });

            // Set an initial value
            scope.setValue(path, key, { initial: value });
            scope.commit();
            metricRecorder.reset();

            // Act - perform setValues and updateValues
            for (let i = 0; i < numSetValues; i++) {
              scope.setValue(path, key, value);
            }
            for (let i = 0; i < numUpdateValues; i++) {
              scope.updateValue(path, key, { updated: value });
            }

            // Assert - both setValue and updateValue should count as writes
            const expectedWrites = numSetValues + numUpdateValues;
            const metrics = metricRecorder.getMetrics();
            expect(metrics.totalWrites).toBe(expectedWrites);

            const stageMetrics = metricRecorder.getStageMetrics(stageName);
            expect(stageMetrics?.writeCount).toBe(expectedWrites);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('reads with different paths/keys are all counted', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.array(
            fc.tuple(arbPath, arbKey, arbPrimitive),
            { minLength: 1, maxLength: 20 }
          ),
          (pipelineId, stageName, pathKeyValues) => {
            // Filter out conflicting paths where a shorter path with a scalar/null
            // value would prevent a longer path from being set (e.g. setting b.y=null
            // then trying to set b.y.A=0 would fail since null has no properties).
            const fullPaths = pathKeyValues.map(([path, key]) => [...path, key].join('.'));
            const filtered = pathKeyValues.filter((_, i) => {
              const fp = fullPaths[i];
              return !fullPaths.some((other, j) => j !== i && fp.startsWith(other + '.'));
            });
            if (filtered.length === 0) return; // skip degenerate case

            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [metricRecorder],
            });

            // Set initial values for all paths
            for (const [path, key, value] of filtered) {
              scope.setValue(path, key, value);
            }
            scope.commit();
            metricRecorder.reset();

            // Act - read all paths
            for (const [path, key] of filtered) {
              scope.getValue(path, key);
            }

            // Assert - all reads should be counted
            const metrics = metricRecorder.getMetrics();
            expect(metrics.totalReads).toBe(filtered.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('writes with different paths/keys are all counted', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.array(
            fc.tuple(arbPath, arbKey, arbPrimitive),
            { minLength: 1, maxLength: 20 }
          ),
          (pipelineId, stageName, pathKeyValues) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [metricRecorder],
            });

            // Act - write all paths
            for (const [path, key, value] of pathKeyValues) {
              scope.setValue(path, key, value);
            }

            // Assert - all writes should be counted
            const metrics = metricRecorder.getMetrics();
            expect(metrics.totalWrites).toBe(pathKeyValues.length);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('empty commits are still counted', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.nat({ max: 20 }),
          (pipelineId, stageName, numCommits) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [metricRecorder],
            });

            // Act - perform commits without any writes
            for (let i = 0; i < numCommits; i++) {
              scope.commit();
            }

            // Assert - all commits should be counted even if empty
            const metrics = metricRecorder.getMetrics();
            expect(metrics.totalCommits).toBe(numCommits);
            expect(metrics.totalWrites).toBe(0);
            expect(metrics.totalReads).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('interleaved operations maintain accurate counts', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          // Generate a sequence of interleaved operations with their types
          fc.array(
            fc.tuple(
              arbOperation,
              arbPath,
              arbKey,
              arbPrimitive
            ),
            { minLength: 5, maxLength: 30 }
          ),
          (pipelineId, stageName, operationsWithData) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [metricRecorder],
            });

            // Set initial values for all paths used
            for (const [, path, key, value] of operationsWithData) {
              scope.setValue(path, key, value);
            }
            scope.commit();
            metricRecorder.reset();

            // Count expected operations
            let expectedReads = 0;
            let expectedWrites = 0;
            let expectedCommits = 0;

            // Act - execute interleaved operations
            for (const [op, path, key, value] of operationsWithData) {
              switch (op) {
                case 'read':
                  scope.getValue(path, key);
                  expectedReads++;
                  break;
                case 'write':
                  scope.setValue(path, key, value);
                  expectedWrites++;
                  break;
                case 'commit':
                  scope.commit();
                  expectedCommits++;
                  break;
              }
            }

            // Assert - counts should match exactly
            const metrics = metricRecorder.getMetrics();
            expect(metrics.totalReads).toBe(expectedReads);
            expect(metrics.totalWrites).toBe(expectedWrites);
            expect(metrics.totalCommits).toBe(expectedCommits);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 14: MetricRecorder Duration Tracking', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 14: MetricRecorder Duration Tracking
     * **Validates: Requirements 5.1**
     *
     * For any MetricRecorder attached to a Scope, after a stage completes,
     * the recorded duration SHALL be greater than or equal to zero and
     * represent the elapsed time between startStage and endStage.
     */

    test('stage duration is non-negative after stage completion', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          (pipelineId, stageName) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [metricRecorder],
            });

            // Act - start and end a stage
            scope.startStage(stageName);
            scope.endStage();

            // Assert - duration should be >= 0
            const stageMetrics = metricRecorder.getStageMetrics(stageName);
            expect(stageMetrics).toBeDefined();
            expect(stageMetrics!.totalDuration).toBeGreaterThanOrEqual(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('stage duration accumulates across multiple invocations of the same stage', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.integer({ min: 2, max: 10 }), // Number of invocations
          (pipelineId, stageName, numInvocations) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [metricRecorder],
            });

            // Act - invoke the same stage multiple times
            for (let i = 0; i < numInvocations; i++) {
              scope.startStage(stageName);
              scope.endStage();
            }

            // Assert - invocation count should match
            const stageMetrics = metricRecorder.getStageMetrics(stageName);
            expect(stageMetrics).toBeDefined();
            expect(stageMetrics!.invocationCount).toBe(numInvocations);
            // Duration should be non-negative (accumulated)
            expect(stageMetrics!.totalDuration).toBeGreaterThanOrEqual(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('total duration is the sum of all stage durations', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 5 }),
          (pipelineId, stageNames) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [metricRecorder],
            });

            // Act - execute each stage once
            for (const stageName of stageNames) {
              scope.startStage(stageName);
              scope.endStage();
            }

            // Assert - total duration should equal sum of all stage durations
            const metrics = metricRecorder.getMetrics();
            let sumOfStageDurations = 0;

            for (const stageName of stageNames) {
              const stageMetrics = metricRecorder.getStageMetrics(stageName);
              expect(stageMetrics).toBeDefined();
              sumOfStageDurations += stageMetrics!.totalDuration;
            }

            expect(metrics.totalDuration).toBe(sumOfStageDurations);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('duration reflects elapsed time between startStage and endStage', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.integer({ min: 1, max: 10 }), // Small delay in ms
          (pipelineId, stageName, delayMs) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [metricRecorder],
            });

            // Act - start stage, simulate work with a busy wait, then end
            scope.startStage(stageName);

            // Busy wait to simulate work (more reliable than setTimeout in tests)
            const startTime = Date.now();
            while (Date.now() - startTime < delayMs) {
              // Busy wait
            }

            scope.endStage();

            // Assert - duration should be at least the delay time
            const stageMetrics = metricRecorder.getStageMetrics(stageName);
            expect(stageMetrics).toBeDefined();
            expect(stageMetrics!.totalDuration).toBeGreaterThanOrEqual(delayMs);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('duration tracking works correctly with operations during stage', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbPath,
          arbKey,
          arbPrimitive,
          fc.nat({ max: 10 }), // Number of operations
          (pipelineId, stageName, path, key, value, numOps) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [metricRecorder],
            });

            // Act - start stage, perform operations, end stage
            scope.startStage(stageName);

            for (let i = 0; i < numOps; i++) {
              scope.setValue(path, key, value);
              scope.getValue(path, key);
            }
            if (numOps > 0) {
              scope.commit();
            }

            scope.endStage();

            // Assert - duration should be non-negative
            const stageMetrics = metricRecorder.getStageMetrics(stageName);
            expect(stageMetrics).toBeDefined();
            expect(stageMetrics!.totalDuration).toBeGreaterThanOrEqual(0);

            // Also verify operations were counted correctly
            expect(stageMetrics!.writeCount).toBe(numOps);
            expect(stageMetrics!.readCount).toBe(numOps);
            expect(stageMetrics!.commitCount).toBe(numOps > 0 ? 1 : 0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('duration accumulates correctly when same stage is invoked multiple times with work', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.integer({ min: 2, max: 5 }), // Number of invocations
          fc.integer({ min: 1, max: 5 }), // Delay per invocation in ms
          (pipelineId, stageName, numInvocations, delayPerInvocation) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [metricRecorder],
            });

            // Act - invoke the same stage multiple times with work
            for (let i = 0; i < numInvocations; i++) {
              scope.startStage(stageName);

              // Busy wait to simulate work
              const startTime = Date.now();
              while (Date.now() - startTime < delayPerInvocation) {
                // Busy wait
              }

              scope.endStage();
            }

            // Assert - total duration should be at least (numInvocations * delayPerInvocation)
            const stageMetrics = metricRecorder.getStageMetrics(stageName);
            expect(stageMetrics).toBeDefined();
            expect(stageMetrics!.totalDuration).toBeGreaterThanOrEqual(
              numInvocations * delayPerInvocation
            );
            expect(stageMetrics!.invocationCount).toBe(numInvocations);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('duration is tracked independently for different stages', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          fc.uniqueArray(arbStageName, { minLength: 2, maxLength: 4 }),
          (pipelineId, stageNames) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [metricRecorder],
            });

            // Act - execute each stage
            for (const stageName of stageNames) {
              scope.startStage(stageName);
              scope.endStage();
            }

            // Assert - each stage should have its own duration tracked
            for (const stageName of stageNames) {
              const stageMetrics = metricRecorder.getStageMetrics(stageName);
              expect(stageMetrics).toBeDefined();
              expect(stageMetrics!.stageName).toBe(stageName);
              expect(stageMetrics!.totalDuration).toBeGreaterThanOrEqual(0);
              expect(stageMetrics!.invocationCount).toBe(1);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('reset clears all duration tracking', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          fc.uniqueArray(arbStageName, { minLength: 1, maxLength: 3 }),
          (pipelineId, stageNames) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [metricRecorder],
            });

            // Act - execute stages
            for (const stageName of stageNames) {
              scope.startStage(stageName);
              scope.endStage();
            }

            // Verify metrics exist before reset
            const metricsBefore = metricRecorder.getMetrics();
            expect(metricsBefore.stageMetrics.size).toBe(stageNames.length);

            // Reset
            metricRecorder.reset();

            // Assert - all metrics should be cleared
            const metricsAfter = metricRecorder.getMetrics();
            expect(metricsAfter.totalDuration).toBe(0);
            expect(metricsAfter.stageMetrics.size).toBe(0);

            // Individual stage metrics should be undefined
            for (const stageName of stageNames) {
              expect(metricRecorder.getStageMetrics(stageName)).toBeUndefined();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('Property 15: MetricRecorder Reset', () => {
    /**
     * Feature: scope-recorder-pattern
     * Property 15: MetricRecorder Reset
     * **Validates: Requirements 5.6**
     *
     * For any MetricRecorder with recorded metrics, after calling reset(),
     * all counts SHALL be zero and stageMetrics SHALL be empty.
     */

    test('reset clears all metrics regardless of previous state', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbOperationSequence,
          arbPath,
          arbKey,
          arbPrimitive,
          (pipelineId, stageName, operations, path, key, value) => {
            // Arrange - create recorder and perform arbitrary operations
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [metricRecorder],
            });

            // Perform operations to accumulate metrics
            for (const op of operations) {
              switch (op) {
                case 'read':
                  scope.getValue(path, key);
                  break;
                case 'write':
                  scope.setValue(path, key, value);
                  break;
                case 'commit':
                  scope.commit();
                  break;
              }
            }

            // Verify we have some metrics before reset (if operations were performed)
            const metricsBefore = metricRecorder.getMetrics();
            const hadMetrics =
              metricsBefore.totalReads > 0 ||
              metricsBefore.totalWrites > 0 ||
              metricsBefore.totalCommits > 0;

            // Act - reset the recorder
            metricRecorder.reset();

            // Assert - all counts should be zero after reset
            const metricsAfter = metricRecorder.getMetrics();
            expect(metricsAfter.totalReads).toBe(0);
            expect(metricsAfter.totalWrites).toBe(0);
            expect(metricsAfter.totalCommits).toBe(0);
            expect(metricsAfter.totalDuration).toBe(0);
            expect(metricsAfter.stageMetrics.size).toBe(0);

            // If we had metrics before, this confirms reset actually cleared something
            if (hadMetrics) {
              expect(metricsBefore.totalReads + metricsBefore.totalWrites + metricsBefore.totalCommits).toBeGreaterThan(0);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    test('new metrics can be recorded after reset', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          arbOperationSequence,
          arbOperationSequence,
          arbPath,
          arbKey,
          arbPrimitive,
          (pipelineId, stageName, operationsBefore, operationsAfter, path, key, value) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [metricRecorder],
            });

            // Perform initial operations
            for (const op of operationsBefore) {
              switch (op) {
                case 'read':
                  scope.getValue(path, key);
                  break;
                case 'write':
                  scope.setValue(path, key, value);
                  break;
                case 'commit':
                  scope.commit();
                  break;
              }
            }

            // Reset the recorder
            metricRecorder.reset();

            // Count expected operations after reset
            let expectedReads = 0;
            let expectedWrites = 0;
            let expectedCommits = 0;

            // Perform new operations after reset
            for (const op of operationsAfter) {
              switch (op) {
                case 'read':
                  scope.getValue(path, key);
                  expectedReads++;
                  break;
                case 'write':
                  scope.setValue(path, key, value);
                  expectedWrites++;
                  break;
                case 'commit':
                  scope.commit();
                  expectedCommits++;
                  break;
              }
            }

            // Assert - metrics should only reflect operations after reset
            const metrics = metricRecorder.getMetrics();
            expect(metrics.totalReads).toBe(expectedReads);
            expect(metrics.totalWrites).toBe(expectedWrites);
            expect(metrics.totalCommits).toBe(expectedCommits);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('reset clears per-stage metrics', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          fc.uniqueArray(arbStageName, { minLength: 1, maxLength: 5 }),
          fc.array(fc.nat({ max: 10 }), { minLength: 1, maxLength: 5 }), // reads per stage
          fc.array(fc.nat({ max: 10 }), { minLength: 1, maxLength: 5 }), // writes per stage
          fc.array(fc.nat({ max: 5 }), { minLength: 1, maxLength: 5 }), // commits per stage
          arbPath,
          arbKey,
          arbPrimitive,
          (pipelineId, stageNames, readCounts, writeCounts, commitCounts, path, key, value) => {
            // Ensure we have matching arrays
            const numStages = Math.min(
              stageNames.length,
              readCounts.length,
              writeCounts.length,
              commitCounts.length
            );
            fc.pre(numStages >= 1);

            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [metricRecorder],
            });

            // Set an initial value
            scope.setValue(path, key, value);
            scope.commit();

            // Perform operations in each stage
            for (let s = 0; s < numStages; s++) {
              const stageName = stageNames[s];
              scope.startStage(stageName);

              for (let i = 0; i < readCounts[s]; i++) {
                scope.getValue(path, key);
              }
              for (let i = 0; i < writeCounts[s]; i++) {
                scope.setValue(path, key, value);
              }
              for (let i = 0; i < commitCounts[s]; i++) {
                scope.commit();
              }

              scope.endStage();
            }

            // Verify we have per-stage metrics before reset
            const metricsBefore = metricRecorder.getMetrics();
            expect(metricsBefore.stageMetrics.size).toBeGreaterThan(0);

            // Act - reset the recorder
            metricRecorder.reset();

            // Assert - all per-stage metrics should be cleared
            const metricsAfter = metricRecorder.getMetrics();
            expect(metricsAfter.stageMetrics.size).toBe(0);

            // Individual stage metrics should be undefined
            for (let s = 0; s < numStages; s++) {
              expect(metricRecorder.getStageMetrics(stageNames[s])).toBeUndefined();
            }

            // Aggregated metrics should also be zero
            expect(metricsAfter.totalReads).toBe(0);
            expect(metricsAfter.totalWrites).toBe(0);
            expect(metricsAfter.totalCommits).toBe(0);
            expect(metricsAfter.totalDuration).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('multiple resets are idempotent', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          arbStageName,
          fc.nat({ max: 10 }), // number of resets
          arbPath,
          arbKey,
          arbPrimitive,
          (pipelineId, stageName, numResets, path, key, value) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName,
              globalStore,
              recorders: [metricRecorder],
            });

            // Perform some operations
            scope.setValue(path, key, value);
            scope.getValue(path, key);
            scope.commit();

            // Act - reset multiple times
            for (let i = 0; i < numResets + 1; i++) {
              metricRecorder.reset();
            }

            // Assert - metrics should still be zero after multiple resets
            const metrics = metricRecorder.getMetrics();
            expect(metrics.totalReads).toBe(0);
            expect(metrics.totalWrites).toBe(0);
            expect(metrics.totalCommits).toBe(0);
            expect(metrics.totalDuration).toBe(0);
            expect(metrics.stageMetrics.size).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('reset on fresh recorder has no effect', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(s)),
          (recorderId) => {
            // Arrange - create a fresh recorder with no operations
            const metricRecorder = new MetricRecorder(recorderId);

            // Verify initial state is already zero
            const metricsBefore = metricRecorder.getMetrics();
            expect(metricsBefore.totalReads).toBe(0);
            expect(metricsBefore.totalWrites).toBe(0);
            expect(metricsBefore.totalCommits).toBe(0);
            expect(metricsBefore.totalDuration).toBe(0);
            expect(metricsBefore.stageMetrics.size).toBe(0);

            // Act - reset the fresh recorder
            metricRecorder.reset();

            // Assert - state should still be zero
            const metricsAfter = metricRecorder.getMetrics();
            expect(metricsAfter.totalReads).toBe(0);
            expect(metricsAfter.totalWrites).toBe(0);
            expect(metricsAfter.totalCommits).toBe(0);
            expect(metricsAfter.totalDuration).toBe(0);
            expect(metricsAfter.stageMetrics.size).toBe(0);
          }
        ),
        { numRuns: 100 }
      );
    });

    test('reset clears metrics from stages with only duration (no operations)', () => {
      fc.assert(
        fc.property(
          arbPipelineId,
          fc.uniqueArray(arbStageName, { minLength: 1, maxLength: 5 }),
          (pipelineId, stageNames) => {
            // Arrange
            const globalStore = new GlobalStore();
            const metricRecorder = new MetricRecorder('test-metrics');
            const scope = new Scope({
              pipelineId,
              stageName: 'initial',
              globalStore,
              recorders: [metricRecorder],
            });

            // Execute stages without any read/write/commit operations
            // (only duration tracking via startStage/endStage)
            for (const stageName of stageNames) {
              scope.startStage(stageName);
              scope.endStage();
            }

            // Verify we have stage metrics (with duration) before reset
            const metricsBefore = metricRecorder.getMetrics();
            expect(metricsBefore.stageMetrics.size).toBe(stageNames.length);

            // Act - reset the recorder
            metricRecorder.reset();

            // Assert - all stage metrics should be cleared
            const metricsAfter = metricRecorder.getMetrics();
            expect(metricsAfter.stageMetrics.size).toBe(0);
            expect(metricsAfter.totalDuration).toBe(0);

            // Individual stage metrics should be undefined
            for (const stageName of stageNames) {
              expect(metricRecorder.getStageMetrics(stageName)).toBeUndefined();
            }
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
