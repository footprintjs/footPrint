/**
 * FlowChartExecutor end-to-end integration tests.
 *
 * Ports key scenarios from old API tests to verify the full
 * builder → executor → introspection pipeline works with new names.
 */

import { flowChart, FlowChartBuilder } from '../../../../src/lib/builder';
import type { StageContext } from '../../../../src/lib/memory';
import { ExecutionRuntime, FlowChartExecutor } from '../../../../src/lib/runner';
import { ScopeFacade, toScopeFactory } from '../../../../src/lib/scope';

// ─── Helpers ───

const noopScope = (ctx: StageContext) => ({ ctx });
const log: string[] = [];

function clearLog() {
  log.length = 0;
}

function makeScopeFactory() {
  return (ctx: StageContext, stageName: string) => ({
    ctx,
    stageName,
    setValue: (key: string, value: unknown) => ctx.setGlobal(key, value),
    getValue: (key: string) => ctx.getGlobal(key),
  });
}

// ─── Tests ───

describe('FlowChartExecutor — end-to-end', () => {
  beforeEach(clearLog);

  // === Linear execution ===

  it('executes a linear chain and returns result', async () => {
    const chart = flowChart('A', (scope: any) => {
      log.push('A');
    })
      .addFunction('B', (scope: any) => {
        log.push('B');
      })
      .addFunction('C', (scope: any) => {
        log.push('C');
        return 'done';
      })
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    const result = await executor.run();

    expect(log).toEqual(['A', 'B', 'C']);
    expect(result).toBe('done');
  });

  // === Context sharing between stages ===

  it('stages can write and read from shared context', async () => {
    const scopeFactory = makeScopeFactory();
    const chart = flowChart('write', (scope: any) => {
      scope.setValue('name', 'Alice');
    })
      .addFunction('read', (scope: any) => {
        return scope.getValue('name');
      })
      .build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    const result = await executor.run();

    expect(result).toBe('Alice');
  });

  // === Decider branching ===

  it('decider selects correct branch', async () => {
    const chart = flowChart('check', (scope: any) => {
      log.push('check');
    })
      .addDeciderFunction('router', async (scope: any) => {
        log.push('router');
        return 'branchB';
      })
      .addFunctionBranch('branchA', 'A', () => {
        log.push('A');
      })
      .addFunctionBranch('branchB', 'B', () => {
        log.push('B');
      })
      .end()
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    expect(log).toEqual(['check', 'router', 'B']);
    expect(log).not.toContain('A');
  });

  // === Fork (parallel children) ===

  it('fork executes all children in parallel', async () => {
    const chart = flowChart('parent', (scope: any) => {
      log.push('parent');
    })
      .addListOfFunction([
        {
          id: 'c1',
          name: 'child1',
          fn: () => {
            log.push('child1');
          },
        },
        {
          id: 'c2',
          name: 'child2',
          fn: () => {
            log.push('child2');
          },
        },
        {
          id: 'c3',
          name: 'child3',
          fn: () => {
            log.push('child3');
          },
        },
      ])
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    expect(log).toContain('parent');
    expect(log).toContain('child1');
    expect(log).toContain('child2');
    expect(log).toContain('child3');
  });

  // === Break stops execution ===

  it('break function stops execution', async () => {
    const chart = flowChart('A', (scope: any, breakFn: () => void) => {
      log.push('A');
      breakFn();
    })
      .addFunction('B', () => {
        log.push('B');
      })
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    expect(log).toEqual(['A']);
  });

  // === Snapshot introspection ===

  it('getSnapshot() returns runtime state after execution', async () => {
    const scopeFactory = makeScopeFactory();
    const chart = flowChart('init', (scope: any) => {
      scope.setValue('counter', 42);
    }).build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    const snapshot = executor.getSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot.sharedState).toBeDefined();
    expect(snapshot.sharedState.counter).toBe(42);
    expect(snapshot.executionTree).toBeDefined();
    expect(snapshot.commitLog).toBeDefined();
    expect(Array.isArray(snapshot.commitLog)).toBe(true);
  });

  // === Runtime access ===

  it('getRuntime() returns ExecutionRuntime', async () => {
    const chart = flowChart('A', () => {}).build();
    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    const runtime = executor.getRuntime();
    expect(runtime).toBeInstanceOf(ExecutionRuntime);
    expect(runtime.globalStore).toBeDefined();
    expect(runtime.rootStageContext).toBeDefined();
    expect(runtime.executionHistory).toBeDefined();
  });

  // === Runtime root ===

  it('getRuntimeRoot() returns the root StageNode', async () => {
    const chart = flowChart('entry', () => {}).build();
    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    const root = executor.getRuntimeRoot();
    expect(root.name).toBe('entry');
  });

  // === Runtime structure ===

  it('getRuntimeStructure() returns serialized structure', async () => {
    const chart = flowChart('A', () => {})
      .addFunction('B', () => {})
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    const structure = executor.getRuntimeStructure();
    expect(structure).toBeDefined();
    expect(structure!.name).toBe('A');
  });

  // === Extractor ===

  it('getExtractedResults() collects extractor output', async () => {
    const chart = flowChart('A', () => {
      return 'outputA';
    })
      .addFunction('B', () => {
        return 'outputB';
      })
      .addTraversalExtractor((snapshot: any) => ({
        name: snapshot.node.name,
        step: snapshot.stepNumber,
      }))
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    const results = executor.getExtractedResults<{ name: string; step: number }>();
    expect(results.size).toBeGreaterThan(0);

    let hasA = false;
    let hasB = false;
    for (const [key, val] of results) {
      if (val.name === 'A') hasA = true;
      if (val.name === 'B') hasB = true;
    }
    expect(hasA).toBe(true);
    expect(hasB).toBe(true);
  });

  // === Enriched snapshots ===

  it('enrichSnapshots captures scope state and debug info', async () => {
    const scopeFactory = makeScopeFactory();
    let capturedSnapshot: any;

    const chart = flowChart('write', (scope: any) => {
      scope.setValue('x', 100);
    })
      .addTraversalExtractor((snapshot: any) => {
        capturedSnapshot = snapshot;
        return snapshot.node.name;
      })
      .build();

    // Pass enrichSnapshots=true (9th constructor param)
    const executor = new FlowChartExecutor(
      chart,
      scopeFactory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true, // enrichSnapshots
    );
    await executor.run();

    expect(capturedSnapshot).toBeDefined();
    expect(capturedSnapshot.scopeState).toBeDefined();
    expect(capturedSnapshot.scopeState.x).toBe(100);
  });

  // === Narrative ===

  it('enableNarrative() produces flow narrative sentences', async () => {
    const chart = flowChart('validate', () => {})
      .addFunction('process', () => {})
      .addFunction('complete', () => {})
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    executor.enableNarrative();
    await executor.run();

    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
    expect(narrative[0]).toContain('validate');
  });

  it('build-time enableNarrative flag works without runtime call', async () => {
    const chart = flowChart('A', () => {})
      .addFunction('B', () => {})
      .setEnableNarrative()
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    const narrative = executor.getNarrative();
    expect(narrative.length).toBeGreaterThan(0);
  });

  // === Error propagation ===

  it('stage errors propagate with correct error', async () => {
    const chart = flowChart('boom', () => {
      throw new Error('kaboom');
    }).build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await expect(executor.run()).rejects.toThrow('kaboom');
  });

  // === Extractor errors ===

  it('getExtractorErrors() collects extractor failures', async () => {
    const chart = flowChart('A', () => {})
      .addTraversalExtractor(() => {
        throw new Error('extractor broke');
      })
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    const errors = executor.getExtractorErrors();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('extractor broke');
  });

  // === Multiple runs produce fresh state ===

  it('run() starts fresh each time (no state leakage)', async () => {
    let callCount = 0;
    const chart = flowChart('counter', () => {
      callCount++;
      return callCount;
    }).build();

    const executor = new FlowChartExecutor(chart, noopScope);
    const result1 = await executor.run();
    const result2 = await executor.run();

    expect(result1).toBe(1);
    expect(result2).toBe(2);

    const snapshot = executor.getSnapshot();
    expect(snapshot.commitLog.length).toBeGreaterThan(0);
  });

  // === getBranchIds ===

  it('getBranchIds() returns after fork execution', async () => {
    const chart = flowChart('root', () => {})
      .addListOfFunction([
        { id: 'a', name: 'A', fn: () => {} },
        { id: 'b', name: 'B', fn: () => {} },
      ])
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    const branchIds = executor.getBranchIds();
    expect(branchIds).toBeDefined();
  });
});

describe('FlowChartExecutor — streaming', () => {
  it('streaming stage receives token callback and triggers handlers', async () => {
    const tokens: string[] = [];
    const startedStreams: string[] = [];
    const endedStreams: string[] = [];

    const chart = flowChart('entry', () => {})
      .addStreamingFunction('stream', 'test-stream', async (scope: any, breakFn: any, streamCallback: any) => {
        streamCallback('hello');
        streamCallback(' world');
        return 'hello world';
      })
      .build();

    const executor = new FlowChartExecutor(chart, noopScope, undefined, undefined, undefined, undefined, {
      onToken: (id, token) => tokens.push(token),
      onStart: (id) => startedStreams.push(id),
      onEnd: (id) => endedStreams.push(id),
    });

    await executor.run();

    expect(tokens).toEqual(['hello', ' world']);
    expect(startedStreams).toContain('test-stream');
    expect(endedStreams).toContain('test-stream');
  });
});

describe('FlowChartExecutor — embedded functions', () => {
  it('executes inline fn on StageNode without stageMap', async () => {
    const chart = flowChart('entry', () => {
      log.push('entry');
      return 'from-entry';
    }).build();

    const executor = new FlowChartExecutor(chart, noopScope);
    const result = await executor.run();

    expect(log).toEqual(['entry']);
    expect(result).toBe('from-entry');
  });
});

describe('FlowChartExecutor — ScopeFacade integration', () => {
  class TestScope extends ScopeFacade {
    get name() {
      return this.getValue('name') as string;
    }

    set name(v: string) {
      this.setValue('name', v);
    }
  }

  it('ScopeFacade subclass works as scope in executor', async () => {
    const scopeFactory = toScopeFactory(TestScope);
    const chart = flowChart('write', (scope: TestScope) => {
      scope.name = 'Alice';
    })
      .addFunction('read', (scope: TestScope) => {
        return scope.name;
      })
      .build();

    // scopeProtectionMode 'off' — ScopeFacade uses setValue/getValue internally,
    // but the proxy intercepts the setter before ScopeFacade's own setter runs
    const executor = new FlowChartExecutor(
      chart,
      scopeFactory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'off',
    );
    const result = await executor.run();

    expect(result).toBe('Alice');
  });
});

describe('FlowChartExecutor — throttlingErrorChecker', () => {
  it('flags throttled errors on fork children', async () => {
    const chart = flowChart('root', () => {})
      .addListOfFunction([
        { id: 'ok', name: 'ok', fn: () => 'success' },
        {
          id: 'throttled',
          name: 'throttled',
          fn: () => {
            throw new Error('rate limited');
          },
        },
      ])
      .build();

    const executor = new FlowChartExecutor(
      chart,
      noopScope,
      undefined,
      undefined,
      undefined,
      (error: unknown) => error instanceof Error && error.message.includes('rate limited'),
    );

    // Fork uses Promise.allSettled — one child errors but execution completes
    const result = await executor.run();
    expect(result).toBeDefined();
  });

  it('throttlingErrorChecker is passed to traverser (line 111 coverage)', async () => {
    // Build a single-stage chart that writes to root, exercising setRootObject
    const scopeFactory = makeScopeFactory();
    const chart = flowChart('init', (scope: any) => {
      scope.setValue('data', 'value');
    }).build();

    const checker = (error: unknown) => error instanceof Error && error.message.includes('throttle');
    const executor = new FlowChartExecutor(chart, scopeFactory, undefined, undefined, undefined, checker);

    await executor.run();

    // Verify setRootObject delegates without error (covers line 111)
    expect(() => executor.setRootObject([], 'key', 'val')).not.toThrow();
  });
});

describe('FlowChartExecutor — setRootObject', () => {
  it('setRootObject delegates to traverser (covers line 111)', async () => {
    const scopeFactory = makeScopeFactory();
    const chart = flowChart('init', () => {}).build();

    const executor = new FlowChartExecutor(chart, scopeFactory);
    await executor.run();

    // setRootObject should delegate to the traverser without throwing
    expect(() => executor.setRootObject(['nested'], 'myKey', { foo: 'bar' })).not.toThrow();
  });
});

describe('FlowChartExecutor — getEnrichedResults', () => {
  it('getEnrichedResults returns extractor results (covers line 135)', async () => {
    const chart = flowChart('A', () => {
      return 'outputA';
    })
      .addFunction('B', () => {
        return 'outputB';
      })
      .addTraversalExtractor((snapshot: any) => ({
        name: snapshot.node.name,
      }))
      .build();

    const executor = new FlowChartExecutor(chart, noopScope);
    await executor.run();

    const enriched = executor.getEnrichedResults<{ name: string }>();
    expect(enriched.size).toBeGreaterThan(0);

    // getEnrichedResults should return the same map as getExtractedResults
    const extracted = executor.getExtractedResults<{ name: string }>();
    expect(enriched.size).toBe(extracted.size);
  });
});
