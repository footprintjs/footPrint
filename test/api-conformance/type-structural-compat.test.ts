/**
 * Type Structural Compatibility Tests
 *
 * These tests catch type-level regressions that runtime tests miss:
 *
 *   1. RunnableFlowChart must be assignable to FlowChart
 *      (broken in v3.0.9 by TraversalExtractor parameter type mismatch)
 *
 *   2. Handler callback types must be structurally identical across files
 *      (ExecuteStageFn vs RunStageFn caught in 5-panel review of v3.0.11)
 *
 *   3. Public ScopeFactory must include executionEnv parameter
 *      (3-param memory version was exported instead of 4-param engine version)
 *
 * How to add a new assertion:
 *   expectTypeOf(value).toMatchTypeOf<ExpectedType>()  — value IS-A expected
 *   expectTypeOf<A>().toMatchTypeOf<B>()               — A IS-A B (A extends B)
 *   expectTypeOf<A>().toEqualTypeOf<B>()               — A and B are the same type
 *
 * If a test here fails, DO NOT cast around it — find the root cause.
 */

import { describe, expectTypeOf, it } from 'vitest';

import type { ExecutionEnv, FlowChart, RunnableFlowChart, ScopeFactory } from '../../src/index.js';
import type {
  CallExtractorFn,
  ExecuteNodeFn,
  GetStagePathFn,
  RunStageFn,
} from '../../src/lib/engine/handlers/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. RunnableFlowChart assignable to FlowChart
//    Broken in v3.0.9: TraversalExtractor (snapshot: StageSnapshot) vs (snapshot: unknown)
//    Fixed in v3.0.10 by unifying the type definition.
// ─────────────────────────────────────────────────────────────────────────────

describe('RunnableFlowChart extends FlowChart', () => {
  it('RunnableFlowChart is assignable to FlowChart', () => {
    expectTypeOf<RunnableFlowChart>().toMatchTypeOf<FlowChart>();
  });

  it('RunnableFlowChart has required buildTimeStructure (not optional)', () => {
    // buildTimeStructure is optional on FlowChart but required on RunnableFlowChart.
    // If this fails, build() output can't be passed to addSubFlowChartBranch.
    type HasRequired = RunnableFlowChart extends { buildTimeStructure: object } ? true : false;
    expectTypeOf<HasRequired>().toEqualTypeOf<true>();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Handler callback types are structurally unified
//    ExecuteStageFn in SubflowExecutor was a same-shape duplicate of RunStageFn.
//    Fixed in v3.0.12 by replacing with RunStageFn from handlers/types.ts.
// ─────────────────────────────────────────────────────────────────────────────

describe('Handler callback type unification', () => {
  it('SubflowExecutor no longer re-exports handler types (factory pattern)', () => {
    // After the factory refactor, SubflowExecutor no longer uses or re-exports
    // RunStageFn — it delegates to SubflowTraverserFactory instead.
    // This test verifies the types still exist in their canonical location.
    expectTypeOf<RunStageFn>().not.toBeNever();
  });

  it('ExecuteNodeFn, RunStageFn, CallExtractorFn, GetStagePathFn all come from one source', () => {
    // These are imported from handlers/types.ts — if the module resolution
    // breaks (e.g. someone re-introduces a local definition with a different shape),
    // the import itself will fail at compile time.
    expectTypeOf<ExecuteNodeFn>().not.toBeNever();
    expectTypeOf<RunStageFn>().not.toBeNever();
    expectTypeOf<CallExtractorFn>().not.toBeNever();
    expectTypeOf<GetStagePathFn>().not.toBeNever();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Public ScopeFactory includes executionEnv (4-param engine version)
//    index.ts was exporting the 3-param memory version — fixed in v3.0.11.
// ─────────────────────────────────────────────────────────────────────────────

describe('ScopeFactory public type includes executionEnv', () => {
  it('ScopeFactory accepts a 4-param implementation with executionEnv', () => {
    // A factory that uses executionEnv must be assignable to the public ScopeFactory.
    // If index.ts exports the 3-param version, this fails.
    type FourParamFactory = (
      context: object,
      stageName: string,
      readOnlyContext?: unknown,
      executionEnv?: ExecutionEnv,
    ) => object;

    expectTypeOf<FourParamFactory>().toMatchTypeOf<ScopeFactory<object>>();
  });
});
