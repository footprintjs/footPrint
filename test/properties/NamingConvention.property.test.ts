/**
 * Property-based tests for the renamed API (naming-convention-refactor spec).
 * Uses fast-check for property-based testing.
 *
 * Feature: naming-convention-refactor
 * 
 * Tests validate that the new naming conventions work correctly:
 * - RuntimeSnapshot structure completeness
 * - StageSnapshot structure completeness
 * - WriteBuffer retrieval
 * - Commit round-trip
 * - Metadata operations (addLog, setLog, addError)
 */

import * as fc from 'fast-check';

import { PipelineRuntime, RuntimeSnapshot } from '../../src/core/memory/PipelineRuntime';
import { StageContext, StageSnapshot } from '../../src/core/memory/StageContext';
import { GlobalStore } from '../../src/core/memory/GlobalStore';
import { WriteBuffer } from '../../src/internal/memory/WriteBuffer';
import { ExecutionHistory } from '../../src/internal/history/ExecutionHistory';

// Arbitrary for valid stage names (non-empty alphanumeric strings)
const stageNameArb = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(s));

// Arbitrary for valid keys (non-empty alphanumeric strings)
const keyArb = fc.string({ minLength: 1, maxLength: 15 }).filter((s) => /^[a-zA-Z][a-zA-Z0-9_]*$/.test(s));

// Arbitrary for simple values (strings, numbers, booleans)
const simpleValueArb = fc.oneof(
  fc.string({ minLength: 0, maxLength: 50 }),
  fc.integer(),
  fc.boolean(),
);

// Arbitrary for object values
const objectValueArb = fc.dictionary(keyArb, simpleValueArb, { minKeys: 1, maxKeys: 5 });

/**
 * **Feature: naming-convention-refactor, Property 1: RuntimeSnapshot Structure Completeness**
 *
 * *For any* PipelineRuntime instance, calling `getSnapshot()` SHALL return
 * a RuntimeSnapshot with all required fields: globalContext, stageContexts, history.
 *
 * **Validates: Requirements 2.1, 3.1**
 */
describe('Property 1: RuntimeSnapshot Structure Completeness', () => {
  it('should return RuntimeSnapshot with all required fields', () => {
    fc.assert(
      fc.property(stageNameArb, (rootName) => {
        const runtime = new PipelineRuntime(rootName);
        const snapshot = runtime.getSnapshot();

        // Verify all required fields exist
        return (
          snapshot !== undefined &&
          typeof snapshot.globalContext === 'object' &&
          typeof snapshot.stageContexts === 'object' &&
          Array.isArray(snapshot.history)
        );
      }),
      { numRuns: 100 },
    );
  });

  it('should have stageContexts with correct root stage name', () => {
    fc.assert(
      fc.property(stageNameArb, (rootName) => {
        const runtime = new PipelineRuntime(rootName);
        const snapshot = runtime.getSnapshot();

        return snapshot.stageContexts.name === rootName;
      }),
      { numRuns: 100 },
    );
  });

  it('should preserve initial context in globalContext', () => {
    fc.assert(
      fc.property(stageNameArb, keyArb, simpleValueArb, (rootName, key, value) => {
        const initialContext = { [key]: value };
        const runtime = new PipelineRuntime(rootName, undefined, initialContext);
        const snapshot = runtime.getSnapshot();

        return snapshot.globalContext[key] === value;
      }),
      { numRuns: 100 },
    );
  });

  it('should have empty history initially', () => {
    fc.assert(
      fc.property(stageNameArb, (rootName) => {
        const runtime = new PipelineRuntime(rootName);
        const snapshot = runtime.getSnapshot();

        return snapshot.history.length === 0;
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * **Feature: naming-convention-refactor, Property 2: StageSnapshot Structure Completeness**
 *
 * *For any* StageContext instance, calling `getSnapshot()` SHALL return
 * a StageSnapshot with all required fields: id, name, logs, errors, metrics, evals.
 *
 * **Validates: Requirements 2.2**
 */
describe('Property 2: StageSnapshot Structure Completeness', () => {
  it('should return StageSnapshot with all required fields', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, (pipelineId, stageName) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        const snapshot = context.getSnapshot();

        return (
          snapshot !== undefined &&
          typeof snapshot.id === 'string' &&
          typeof snapshot.name === 'string' &&
          typeof snapshot.logs === 'object' &&
          typeof snapshot.errors === 'object' &&
          typeof snapshot.metrics === 'object' &&
          typeof snapshot.evals === 'object'
        );
      }),
      { numRuns: 100 },
    );
  });

  it('should have correct id and name in snapshot', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, (pipelineId, stageName) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        const snapshot = context.getSnapshot();

        return snapshot.id === pipelineId && snapshot.name === stageName;
      }),
      { numRuns: 100 },
    );
  });

  it('should include next stage in snapshot when created', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, stageNameArb, (pipelineId, stageName, nextStageName) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        context.createNext(pipelineId, nextStageName);
        const snapshot = context.getSnapshot();

        return (
          snapshot.next !== undefined &&
          snapshot.next.name === nextStageName
        );
      }),
      { numRuns: 100 },
    );
  });

  it('should include children in snapshot when created', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, stageNameArb, (pipelineId, stageName, childName) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        context.createChild(pipelineId, 'branch1', childName);
        const snapshot = context.getSnapshot();

        return (
          snapshot.children !== undefined &&
          snapshot.children.length === 1 &&
          snapshot.children[0].name === childName
        );
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * **Feature: naming-convention-refactor, Property 3: WriteBuffer Retrieval**
 *
 * *For any* StageContext instance, calling `getWriteBuffer()` SHALL return
 * a WriteBuffer instance that can be used for staging mutations.
 *
 * **Validates: Requirements 3.2**
 * 
 * NOTE: The legacy alias `getMemoryContext()` has been removed as part of the
 * backward compatibility cleanup. Use `getWriteBuffer()` instead.
 */
describe('Property 3: WriteBuffer Retrieval', () => {
  it('should return a WriteBuffer instance', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, (pipelineId, stageName) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        const buffer = context.getWriteBuffer();

        return buffer instanceof WriteBuffer;
      }),
      { numRuns: 100 },
    );
  });

  it('should return the same WriteBuffer instance on multiple calls', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, (pipelineId, stageName) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        const buffer1 = context.getWriteBuffer();
        const buffer2 = context.getWriteBuffer();

        return buffer1 === buffer2;
      }),
      { numRuns: 100 },
    );
  });

  it('should allow staging mutations via WriteBuffer', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, keyArb, simpleValueArb, (pipelineId, stageName, key, value) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        const buffer = context.getWriteBuffer();
        
        buffer.set([key], value);
        const retrieved = buffer.get([key]);

        return retrieved === value;
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * **Feature: naming-convention-refactor, Property 4: Commit Round-Trip**
 *
 * *For any* staged mutations, calling `commit()` SHALL apply them to the
 * GlobalStore and record them in the ExecutionHistory.
 *
 * **Validates: Requirements 3.3**
 * 
 * NOTE: The legacy alias `commitPatch()` has been removed as part of the
 * backward compatibility cleanup. Use `commit()` instead.
 */
describe('Property 4: Commit Round-Trip', () => {
  it('should apply staged mutations to GlobalStore after commit()', () => {
    fc.assert(
      fc.property(stageNameArb, keyArb, simpleValueArb, (rootName, key, value) => {
        const runtime = new PipelineRuntime(rootName);
        const context = runtime.rootStageContext;
        
        context.setGlobal(key, value);
        context.commit();
        
        const snapshot = runtime.getSnapshot();
        return snapshot.globalContext[key] === value;
      }),
      { numRuns: 100 },
    );
  });

  it('should record commit in ExecutionHistory', () => {
    fc.assert(
      fc.property(stageNameArb, keyArb, simpleValueArb, (rootName, key, value) => {
        const runtime = new PipelineRuntime(rootName);
        const context = runtime.rootStageContext;
        
        context.setGlobal(key, value);
        context.commit();
        
        const snapshot = runtime.getSnapshot();
        return snapshot.history.length === 1;
      }),
      { numRuns: 100 },
    );
  });

  it('should support multiple commits with accumulated history', () => {
    fc.assert(
      fc.property(stageNameArb, keyArb, keyArb, simpleValueArb, simpleValueArb, (rootName, key1, key2, value1, value2) => {
        // Ensure keys are different
        if (key1 === key2) return true;

        const runtime = new PipelineRuntime(rootName);
        const context = runtime.rootStageContext;
        
        context.setGlobal(key1, value1);
        context.commit();
        
        context.setGlobal(key2, value2);
        context.commit();
        
        const snapshot = runtime.getSnapshot();
        return (
          snapshot.globalContext[key1] === value1 &&
          snapshot.globalContext[key2] === value2 &&
          snapshot.history.length === 2
        );
      }),
      { numRuns: 100 },
    );
  });
});

/**
 * **Feature: naming-convention-refactor, Property 5: Metadata Operations**
 *
 * *For any* StageContext instance, the metadata methods (addLog, setLog, addError)
 * SHALL correctly store and retrieve metadata in the stage's debug context.
 *
 * **Validates: Requirements 3.4, 3.5**
 * 
 * NOTE: The legacy aliases (addDebugInfo, setDebugInfo, addErrorInfo) have been
 * removed as part of the backward compatibility cleanup. Use the new method names:
 * addLog, setLog, addError.
 */
describe('Property 5: Metadata Operations', () => {
  it('addLog() should add entries to logs', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, keyArb, simpleValueArb, (pipelineId, stageName, key, value) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        
        context.addLog(key, value);
        const snapshot = context.getSnapshot();

        return snapshot.logs[key] === value;
      }),
      { numRuns: 100 },
    );
  });

  it('setLog() should set entries in logs', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, keyArb, simpleValueArb, (pipelineId, stageName, key, value) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        
        context.setLog(key, value);
        const snapshot = context.getSnapshot();

        return snapshot.logs[key] === value;
      }),
      { numRuns: 100 },
    );
  });

  it('addError() should add entries to errors', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, keyArb, simpleValueArb, (pipelineId, stageName, key, value) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        
        context.addError(key, value);
        const snapshot = context.getSnapshot();

        return snapshot.errors[key] === value;
      }),
      { numRuns: 100 },
    );
  });

  it('should support multiple metadata entries', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, keyArb, keyArb, simpleValueArb, simpleValueArb, 
        (pipelineId, stageName, key1, key2, value1, value2) => {
          // Ensure keys are different
          if (key1 === key2) return true;

          const globalStore = new GlobalStore();
          const context = new StageContext(pipelineId, stageName, globalStore);
          
          context.addLog(key1, value1);
          context.addLog(key2, value2);
          context.addError('err1', 'error message');
          
          const snapshot = context.getSnapshot();

          return (
            snapshot.logs[key1] === value1 &&
            snapshot.logs[key2] === value2 &&
            snapshot.errors['err1'] === 'error message'
          );
        }),
      { numRuns: 100 },
    );
  });
});

/**
 * **Feature: naming-convention-refactor, Property 6: New API Methods Work Correctly**
 *
 * *For any* usage of the new API methods, they SHALL work correctly.
 *
 * **Validates: Requirements 6.1 (new API)**
 * 
 * NOTE: Legacy aliases (createNextContext, createChildContext, createDeciderContext,
 * getMemoryContext, commitPatch, addDebugInfo, setDebugInfo, addErrorInfo) have been
 * removed as part of the backward compatibility cleanup. Use the new method names:
 * createNext, createChild, createDecider, getWriteBuffer, commit, addLog, setLog, addError.
 */
describe('Property 6: New API Methods Work Correctly', () => {
  it('globalStore should be accessible', () => {
    fc.assert(
      fc.property(stageNameArb, (rootName) => {
        const runtime = new PipelineRuntime(rootName);
        
        return runtime.globalStore !== undefined;
      }),
      { numRuns: 100 },
    );
  });

  it('executionHistory should be accessible', () => {
    fc.assert(
      fc.property(stageNameArb, (rootName) => {
        const runtime = new PipelineRuntime(rootName);
        
        return runtime.executionHistory !== undefined;
      }),
      { numRuns: 100 },
    );
  });

  it('createNext() should create a next stage context', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, stageNameArb, (pipelineId, stageName, nextName) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        const next = context.createNext(pipelineId, nextName);

        return (
          next.stageName === nextName &&
          next.pipelineId === pipelineId
        );
      }),
      { numRuns: 100 },
    );
  });

  it('createChild() should create a child stage context', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, stageNameArb, (pipelineId, stageName, childName) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        const child = context.createChild(pipelineId, 'branch', childName);

        return (
          child.stageName === childName &&
          child.pipelineId === pipelineId &&
          child.branchId === 'branch'
        );
      }),
      { numRuns: 100 },
    );
  });

  it('createDecider() should create a decider stage context', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, stageNameArb, (pipelineId, stageName, deciderName) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        const decider = context.createDecider(pipelineId, deciderName);

        return (
          decider.stageName === deciderName &&
          decider.isDecider === true
        );
      }),
      { numRuns: 100 },
    );
  });
});
