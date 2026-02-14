/**
 * Property-Based Tests: Narrative Enablement Round-Trip
 *
 * INVARIANTS TESTED:
 * These properties must hold for ALL valid inputs:
 * 6. Enabled narrative produces non-empty output for non-trivial pipelines
 * 7. Disabled narrative always produces empty output
 *
 * GENERATOR STRATEGY:
 * We generate random stage counts (1–10) and build linear pipelines with
 * that many stages. Each stage is a trivial no-op function. Linear pipelines
 * are sufficient to prove the enablement properties because the narrative
 * output depends on the enablement flag, not the pipeline shape.
 *
 * Feature: pipeline-narrative-generation
 */

import * as fc from 'fast-check';
import { FlowChartBuilder } from '../../src/core/builder/FlowChartBuilder';
import { FlowChartExecutor } from '../../src/core/executor/FlowChartExecutor';
import { StageContext } from '../../src/core/memory/StageContext';
import { ScopeFactory } from '../../src/core/memory/types';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simple scope factory — passes the StageContext through unchanged.
 * WHY: Property tests don't need custom scope logic; we only care about
 * narrative enablement behaviour.
 */
const testScopeFactory: ScopeFactory<StageContext> = (context: StageContext) => context;

/**
 * Builds a linear pipeline with the given number of stages.
 *
 * WHY: Linear pipelines are the simplest shape that exercises the narrative
 * generator (first-stage sentence + N-1 transition sentences). This is
 * sufficient to prove enablement properties without introducing complexity
 * from deciders, forks, or loops.
 *
 * @param stageCount - Number of stages (must be >= 1)
 * @returns A built FlowChart ready for execution
 */
function buildLinearPipeline(stageCount: number) {
  const builder = new FlowChartBuilder();

  // Start with the first stage
  builder.start(`stage_0`, () => `output_0`, undefined, `Stage 0`);

  // Chain additional stages
  for (let i = 1; i < stageCount; i++) {
    builder.addFunction(`stage_${i}`, () => `output_${i}`, undefined, `Stage ${i}`);
  }

  return builder.build();
}

/**
 * Generates a stage count between 1 and 10.
 * WHY: We need at least 1 stage for a non-trivial pipeline. 10 is enough
 * to exercise the property without making tests slow.
 */
const stageCountArb = fc.integer({ min: 1, max: 10 });

// ─────────────────────────────────────────────────────────────────────────────
// Property 6: Enabled narrative produces non-empty output
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 6: Enabled narrative produces non-empty output for non-trivial pipelines', () => {
  /**
   * PROPERTY: For any pipeline with at least one stage, when narrative is
   * enabled, getNarrative() SHALL return a non-empty array.
   *
   * Validates: Requirements 1.1, 1.3, 2.1
   *
   * COUNTEREXAMPLE MEANING: If this fails, it means enabling narrative does
   * not produce any output for a valid pipeline — the narrative feature is
   * broken and consumers get an empty story despite opting in.
   */
  it('getNarrative() returns a non-empty array when narrative is enabled', async () => {
    await fc.assert(
      fc.asyncProperty(stageCountArb, async (stageCount) => {
        const chart = buildLinearPipeline(stageCount);
        const executor = new FlowChartExecutor(chart, testScopeFactory);
        executor.enableNarrative();

        await executor.run();

        const narrative = executor.getNarrative();
        expect(narrative.length).toBeGreaterThan(0);
        // Every entry should be a non-empty string
        for (const sentence of narrative) {
          expect(typeof sentence).toBe('string');
          expect(sentence.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Property 7: Disabled narrative always produces empty output
// ─────────────────────────────────────────────────────────────────────────────

describe('Property 7: Disabled narrative always produces empty output', () => {
  /**
   * PROPERTY: For any pipeline execution without enableNarrative(),
   * getNarrative() SHALL return an empty array regardless of pipeline
   * complexity.
   *
   * Validates: Requirements 1.2, 2.3
   *
   * COUNTEREXAMPLE MEANING: If this fails, it means the NullNarrativeGenerator
   * is leaking sentences when narrative is disabled — production pipelines
   * would pay an unexpected cost and consumers would receive narrative output
   * they did not opt into.
   */
  it('getNarrative() returns an empty array when narrative is not enabled', async () => {
    await fc.assert(
      fc.asyncProperty(stageCountArb, async (stageCount) => {
        const chart = buildLinearPipeline(stageCount);
        const executor = new FlowChartExecutor(chart, testScopeFactory);
        // NOTE: enableNarrative() is intentionally NOT called

        await executor.run();

        const narrative = executor.getNarrative();
        expect(narrative).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
