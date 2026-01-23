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

import { PipelineRuntime, RuntimeSnapshot } from '../../../src/core/context/PipelineRuntime';
import { StageContext, StageSnapshot } from '../../../src/core/context/StageContext';
import { GlobalStore } from '../../../src/core/context/GlobalStore';
import { WriteBuffer } from '../../../src/core/stateManagement/WriteBuffer';
import { ExecutionHistory } from '../../../src/core/stateManagement/ExecutionHistory';

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

  it('getSnapshot() and getContextTree() should return equivalent results', () => {
    fc.assert(
      fc.property(stageNameArb, (rootName) => {
        const runtime = new PipelineRuntime(rootName);
        const snapshot = runtime.getSnapshot();
        const contextTree = runtime.getContextTree();

        return (
          JSON.stringify(snapshot.globalContext) === JSON.stringify(contextTree.globalContext) &&
          JSON.stringify(snapshot.stageContexts) === JSON.stringify(contextTree.stageContexts) &&
          JSON.stringify(snapshot.history) === JSON.stringify(contextTree.history)
        );
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

  it('getSnapshot() and getJson() should return equivalent results', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, (pipelineId, stageName) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        const snapshot = context.getSnapshot();
        const json = context.getJson();

        return JSON.stringify(snapshot) === JSON.stringify(json);
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

  it('getWriteBuffer() and getMemoryContext() should return the same instance', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, (pipelineId, stageName) => {
        const globalStore = new GlobalStore();
        const context = new StageContext(pipelineId, stageName, globalStore);
        const writeBuffer = context.getWriteBuffer();
        const memoryContext = context.getMemoryContext();

        return writeBuffer === memoryContext;
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

  it('commit() and commitPatch() should have equivalent behavior', () => {
    fc.assert(
      fc.property(stageNameArb, keyArb, simpleValueArb, (rootName, key, value) => {
        // Test commit()
        const runtime1 = new PipelineRuntime(rootName);
        runtime1.rootStageContext.setGlobal(key, value);
        runtime1.rootStageContext.commit();
        const snapshot1 = runtime1.getSnapshot();

        // Test commitPatch()
        const runtime2 = new PipelineRuntime(rootName);
        runtime2.rootStageContext.setGlobal(key, value);
        runtime2.rootStageContext.commitPatch();
        const snapshot2 = runtime2.getSnapshot();

        return (
          snapshot1.globalContext[key] === snapshot2.globalContext[key] &&
          snapshot1.history.length === snapshot2.history.length
        );
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

  it('addLog() and addDebugInfo() should have equivalent behavior', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, keyArb, simpleValueArb, (pipelineId, stageName, key, value) => {
        const globalStore1 = new GlobalStore();
        const context1 = new StageContext(pipelineId, stageName, globalStore1);
        context1.addLog(key, value);
        const snapshot1 = context1.getSnapshot();

        const globalStore2 = new GlobalStore();
        const context2 = new StageContext(pipelineId, stageName, globalStore2);
        context2.addDebugInfo(key, value);
        const snapshot2 = context2.getSnapshot();

        return snapshot1.logs[key] === snapshot2.logs[key];
      }),
      { numRuns: 100 },
    );
  });

  it('setLog() and setDebugInfo() should have equivalent behavior', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, keyArb, simpleValueArb, (pipelineId, stageName, key, value) => {
        const globalStore1 = new GlobalStore();
        const context1 = new StageContext(pipelineId, stageName, globalStore1);
        context1.setLog(key, value);
        const snapshot1 = context1.getSnapshot();

        const globalStore2 = new GlobalStore();
        const context2 = new StageContext(pipelineId, stageName, globalStore2);
        context2.setDebugInfo(key, value);
        const snapshot2 = context2.getSnapshot();

        return snapshot1.logs[key] === snapshot2.logs[key];
      }),
      { numRuns: 100 },
    );
  });

  it('addError() and addErrorInfo() should have equivalent behavior', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, keyArb, simpleValueArb, (pipelineId, stageName, key, value) => {
        const globalStore1 = new GlobalStore();
        const context1 = new StageContext(pipelineId, stageName, globalStore1);
        context1.addError(key, value);
        const snapshot1 = context1.getSnapshot();

        const globalStore2 = new GlobalStore();
        const context2 = new StageContext(pipelineId, stageName, globalStore2);
        context2.addErrorInfo(key, value);
        const snapshot2 = context2.getSnapshot();

        return snapshot1.errors[key] === snapshot2.errors[key];
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
 * **Feature: naming-convention-refactor, Property 6: Legacy Alias Compatibility**
 *
 * *For any* usage of legacy aliases, they SHALL behave identically to their
 * new counterparts.
 *
 * **Validates: Requirements 6.1 (backward compatibility)**
 */
describe('Property 6: Legacy Alias Compatibility', () => {
  it('globalContext alias should return same instance as globalStore', () => {
    fc.assert(
      fc.property(stageNameArb, (rootName) => {
        const runtime = new PipelineRuntime(rootName);
        
        return runtime.globalContext === runtime.globalStore;
      }),
      { numRuns: 100 },
    );
  });

  it('pipelineHistory alias should return same instance as executionHistory', () => {
    fc.assert(
      fc.property(stageNameArb, (rootName) => {
        const runtime = new PipelineRuntime(rootName);
        
        return runtime.pipelineHistory === runtime.executionHistory;
      }),
      { numRuns: 100 },
    );
  });

  it('createNextContext() should behave like createNext()', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, stageNameArb, (pipelineId, stageName, nextName) => {
        const globalStore1 = new GlobalStore();
        const context1 = new StageContext(pipelineId, stageName, globalStore1);
        const next1 = context1.createNext(pipelineId, nextName);

        const globalStore2 = new GlobalStore();
        const context2 = new StageContext(pipelineId, stageName, globalStore2);
        const next2 = context2.createNextContext(pipelineId, nextName);

        return (
          next1.stageName === next2.stageName &&
          next1.pipelineId === next2.pipelineId
        );
      }),
      { numRuns: 100 },
    );
  });

  it('createChildContext() should behave like createChild()', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, stageNameArb, (pipelineId, stageName, childName) => {
        const globalStore1 = new GlobalStore();
        const context1 = new StageContext(pipelineId, stageName, globalStore1);
        const child1 = context1.createChild(pipelineId, 'branch', childName);

        const globalStore2 = new GlobalStore();
        const context2 = new StageContext(pipelineId, stageName, globalStore2);
        const child2 = context2.createChildContext(pipelineId, 'branch', childName);

        return (
          child1.stageName === child2.stageName &&
          child1.pipelineId === child2.pipelineId &&
          child1.branchId === child2.branchId
        );
      }),
      { numRuns: 100 },
    );
  });

  it('createDeciderContext() should behave like createDecider()', () => {
    fc.assert(
      fc.property(stageNameArb, stageNameArb, stageNameArb, (pipelineId, stageName, deciderName) => {
        const globalStore1 = new GlobalStore();
        const context1 = new StageContext(pipelineId, stageName, globalStore1);
        const decider1 = context1.createDecider(pipelineId, deciderName);

        const globalStore2 = new GlobalStore();
        const context2 = new StageContext(pipelineId, stageName, globalStore2);
        const decider2 = context2.createDeciderContext(pipelineId, deciderName);

        return (
          decider1.stageName === decider2.stageName &&
          decider1.isDecider === decider2.isDecider
        );
      }),
      { numRuns: 100 },
    );
  });
});
