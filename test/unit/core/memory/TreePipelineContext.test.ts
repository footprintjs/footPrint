import { GlobalStore } from '../../../../src/core/memory/GlobalStore';
import { StageContext } from '../../../../src/core/memory/StageContext';
import { PipelineRuntime } from '../../../../src/core/memory/PipelineRuntime';

describe('PipelineRuntime', () => {
  let pipelineRuntime: PipelineRuntime;

  beforeEach(() => {
    pipelineRuntime = new PipelineRuntime('rootName', {
      showDisclaimer: true,
    });
  });

  test('should initialize with a root StageContext', () => {
    expect(pipelineRuntime.rootStageContext).toBeInstanceOf(StageContext);
    expect(pipelineRuntime.rootStageContext.stageName).toBe('rootName');
  });

  test('should initialize with a GlobalStore', () => {
    expect(pipelineRuntime.globalStore).toBeInstanceOf(GlobalStore);
  });

  test('should return runtime snapshot', () => {
    const snapshot = pipelineRuntime.getSnapshot();
    expect(snapshot).toEqual({
      globalContext: {
        showDisclaimer: true,
      },
      history: [],
      stageContexts: {
        id: '',
        name: 'rootName',
        isFork: false,
        isDecider: false,
        logs: {},
        errors: {},
        metrics: {},
        evals: {},
      },
    });
  });

  test('should reflect updates in global store', () => {
    pipelineRuntime.globalStore.updateValue('', [], 'testKey', 'testValue');
    const snapshot = pipelineRuntime.getSnapshot();
    expect(snapshot.globalContext).toEqual({ showDisclaimer: true, testKey: 'testValue' });
  });

  test('should add log in root stage context', () => {
    pipelineRuntime.rootStageContext.addLog('debugKey', 'debugValue');
    const snapshot = pipelineRuntime.getSnapshot();
    expect(snapshot.stageContexts.logs).toEqual({ debugKey: 'debugValue' });
  });

  test('should add error in root stage context', () => {
    pipelineRuntime.rootStageContext.addError('errorKey', 'errorValue');
    const snapshot = pipelineRuntime.getSnapshot();
    expect(snapshot.stageContexts.errors).toEqual({ errorKey: 'errorValue' });
  });

  test('should add child contexts correctly', () => {
    const childContext = pipelineRuntime.rootStageContext.createChild('childPath', 'childId', 'childName');
    const snapshot = pipelineRuntime.getSnapshot();
    expect(snapshot.stageContexts.children?.[0]).toEqual({
      id: 'childPath',
      name: 'childName',
      isFork: false,
      isDecider: false,
      logs: {},
      errors: {},
      metrics: {},
      evals: {},
    });
  });

  test('should add next contexts correctly', () => {
    const nextContext = pipelineRuntime.rootStageContext.createNext('nextPath', 'nextName');
    const snapshot = pipelineRuntime.getSnapshot();
    expect(snapshot.stageContexts.next).toEqual({
      id: 'nextPath',
      name: 'nextName',
      isFork: false,
      isDecider: false,
      logs: {},
      errors: {},
      metrics: {},
      evals: {},
    });
  });

  test('should mark if node is a decider', () => {
    const nextContext = pipelineRuntime.rootStageContext.createNext('nextPath', 'nextName', true);
    const snapshot = pipelineRuntime.getSnapshot();
    expect(snapshot.stageContexts.next).toEqual({
      id: 'nextPath',
      name: 'nextName',
      isFork: false,
      isDecider: true,
      logs: {},
      errors: {},
      metrics: {},
      evals: {},
    });
  });

  // ─── getPipelines() ──────────────────────────────────────────────────

  describe('getPipelines', () => {
    test('should return undefined when no pipelines exist', () => {
      const pipelines = pipelineRuntime.getPipelines();
      expect(pipelines).toBeUndefined();
    });

    test('should delegate to globalStore.getPipelines()', () => {
      // Write a value under a pipeline namespace so that context.pipelines is populated
      pipelineRuntime.globalStore.setValue('myPipeline', [], 'key', 'value');
      const pipelines = pipelineRuntime.getPipelines();
      expect(pipelines).toBeDefined();
      expect(pipelines.myPipeline).toEqual(expect.objectContaining({ key: 'value' }));
    });

    test('should return multiple pipelines', () => {
      pipelineRuntime.globalStore.setValue('pipeA', [], 'x', 1);
      pipelineRuntime.globalStore.setValue('pipeB', [], 'y', 2);
      const pipelines = pipelineRuntime.getPipelines();
      expect(pipelines.pipeA).toEqual(expect.objectContaining({ x: 1 }));
      expect(pipelines.pipeB).toEqual(expect.objectContaining({ y: 2 }));
    });
  });

  // ─── setRootObject() ─────────────────────────────────────────────────

  describe('setRootObject', () => {
    test('should set a value at the root level via rootStageContext.setObject', () => {
      pipelineRuntime.setRootObject([], 'greeting', 'hello');
      // rootStageContext has pipelineId = '' so values go to global scope
      // The value is staged in writeBuffer, so read it back via the context
      const value = pipelineRuntime.rootStageContext.getValue([], 'greeting');
      expect(value).toBe('hello');
    });

    test('should set a nested value at a given path', () => {
      pipelineRuntime.setRootObject(['config'], 'theme', 'dark');
      const value = pipelineRuntime.rootStageContext.getValue(['config'], 'theme');
      expect(value).toBe('dark');
    });

    test('should overwrite an existing value', () => {
      pipelineRuntime.setRootObject([], 'showDisclaimer', false);
      const value = pipelineRuntime.rootStageContext.getValue([], 'showDisclaimer');
      expect(value).toBe(false);
    });
  });

  // ─── getFullNarrative() ───────────────────────────────────────────────

  describe('getFullNarrative', () => {
    test('should return a single entry for root context with no messages', () => {
      const narrative = pipelineRuntime.getFullNarrative();
      expect(narrative).toHaveLength(1);
      expect(narrative[0]).toEqual({
        stageId: 'rootName', // pipelineId is '' so getStageId returns stageName
        stageName: 'rootName',
        stageMessages: [],
        flowMessage: undefined,
        timeIndex: 0,
      });
    });

    test('should include stage messages from debug log context', () => {
      // addLog with an array value creates/concatenates arrays in logContext
      pipelineRuntime.rootStageContext.debug.addLog('message', ['Step 1 completed']);
      pipelineRuntime.rootStageContext.debug.addLog('message', ['Step 2 completed']);

      const narrative = pipelineRuntime.getFullNarrative();
      expect(narrative).toHaveLength(1);
      expect(narrative[0].stageMessages).toEqual(['Step 1 completed', 'Step 2 completed']);
    });

    test('should include flow messages from debug context', () => {
      pipelineRuntime.rootStageContext.addFlowDebugMessage('next', 'Moving to validation');

      const narrative = pipelineRuntime.getFullNarrative();
      expect(narrative).toHaveLength(1);
      expect(narrative[0].flowMessage).toBeDefined();
      expect(narrative[0].flowMessage!.type).toBe('next');
      expect(narrative[0].flowMessage!.description).toBe('Moving to validation');
    });

    test('should only use the first flow message as the heading', () => {
      pipelineRuntime.rootStageContext.addFlowDebugMessage('next', 'First flow');
      pipelineRuntime.rootStageContext.addFlowDebugMessage('branch', 'Second flow');

      const narrative = pipelineRuntime.getFullNarrative();
      expect(narrative[0].flowMessage!.type).toBe('next');
      expect(narrative[0].flowMessage!.description).toBe('First flow');
    });

    test('should walk linear chain: root -> next', () => {
      const nextCtx = pipelineRuntime.rootStageContext.createNext('pipe1', 'validate');
      nextCtx.debug.addLog('message', ['Validation passed']);

      const narrative = pipelineRuntime.getFullNarrative();
      expect(narrative).toHaveLength(2);
      // First entry is root
      expect(narrative[0].stageName).toBe('rootName');
      expect(narrative[0].timeIndex).toBe(0);
      // Second entry is next
      expect(narrative[1].stageName).toBe('validate');
      expect(narrative[1].stageMessages).toEqual(['Validation passed']);
      expect(narrative[1].timeIndex).toBe(1);
    });

    test('should walk children before next (current -> children -> next)', () => {
      // Create a child (parallel branch)
      const childCtx = pipelineRuntime.rootStageContext.createChild('pipe1', 'branch1', 'childStage');
      childCtx.debug.addLog('message', ['Child executed']);

      // Create a next (linear continuation)
      const nextCtx = pipelineRuntime.rootStageContext.createNext('pipe1', 'nextStage');
      nextCtx.debug.addLog('message', ['Next executed']);

      const narrative = pipelineRuntime.getFullNarrative();
      expect(narrative).toHaveLength(3);
      // Order: root -> child -> next
      expect(narrative[0].stageName).toBe('rootName');
      expect(narrative[0].timeIndex).toBe(0);
      expect(narrative[1].stageName).toBe('childStage');
      expect(narrative[1].timeIndex).toBe(1);
      expect(narrative[2].stageName).toBe('nextStage');
      expect(narrative[2].timeIndex).toBe(2);
    });

    test('should walk multiple children in order', () => {
      const child1 = pipelineRuntime.rootStageContext.createChild('pipe1', 'b1', 'child1');
      child1.debug.addLog('message', ['Child 1']);
      const child2 = pipelineRuntime.rootStageContext.createChild('pipe1', 'b2', 'child2');
      child2.debug.addLog('message', ['Child 2']);

      const narrative = pipelineRuntime.getFullNarrative();
      expect(narrative).toHaveLength(3);
      expect(narrative[0].stageName).toBe('rootName');
      expect(narrative[1].stageName).toBe('child1');
      expect(narrative[1].stageMessages).toEqual(['Child 1']);
      expect(narrative[2].stageName).toBe('child2');
      expect(narrative[2].stageMessages).toEqual(['Child 2']);
    });

    test('should walk deeply nested tree: root -> child -> child-next -> root-next', () => {
      // root has a child, child has a next, root also has a next
      const childCtx = pipelineRuntime.rootStageContext.createChild('pipe1', 'b1', 'childStage');
      const childNextCtx = childCtx.createNext('pipe1.child', 'childNext');
      const rootNextCtx = pipelineRuntime.rootStageContext.createNext('pipe1', 'rootNext');

      const narrative = pipelineRuntime.getFullNarrative();
      expect(narrative).toHaveLength(4);
      // Walk order: root -> child -> childNext -> rootNext
      expect(narrative[0].stageName).toBe('rootName');
      expect(narrative[1].stageName).toBe('childStage');
      expect(narrative[2].stageName).toBe('childNext');
      expect(narrative[3].stageName).toBe('rootNext');
    });

    test('should assign sequential timeIndex values across the tree', () => {
      pipelineRuntime.rootStageContext.createChild('p', 'b1', 'c1');
      pipelineRuntime.rootStageContext.createChild('p', 'b2', 'c2');
      pipelineRuntime.rootStageContext.createNext('p', 'n1');

      const narrative = pipelineRuntime.getFullNarrative();
      const timeIndices = narrative.map((e) => e.timeIndex);
      expect(timeIndices).toEqual([0, 1, 2, 3]);
    });

    test('should use correct stageId format for namespaced contexts', () => {
      const nextCtx = pipelineRuntime.rootStageContext.createNext('myPipeline', 'validate');

      const narrative = pipelineRuntime.getFullNarrative();
      // root has pipelineId '' so stageId is just stageName
      expect(narrative[0].stageId).toBe('rootName');
      // next has pipelineId 'myPipeline' so stageId is 'myPipeline.validate'
      expect(narrative[1].stageId).toBe('myPipeline.validate');
    });

    test('should handle context with no messages gracefully', () => {
      // Create a tree with no debug messages at all
      pipelineRuntime.rootStageContext.createChild('p', 'b1', 'emptyChild');
      pipelineRuntime.rootStageContext.createNext('p', 'emptyNext');

      const narrative = pipelineRuntime.getFullNarrative();
      expect(narrative).toHaveLength(3);
      for (const entry of narrative) {
        // stageMessages defaults to [] when logContext.message is undefined
        expect(entry.stageMessages).toEqual([]);
        expect(entry.flowMessage).toBeUndefined();
      }
    });

    test('should include flow message options like targetStage and rationale', () => {
      pipelineRuntime.rootStageContext.addFlowDebugMessage('branch', 'Branching to handlers', {
        targetStage: ['handlerA', 'handlerB'],
        rationale: 'Multiple handlers matched',
        count: 2,
      });

      const narrative = pipelineRuntime.getFullNarrative();
      const flowMsg = narrative[0].flowMessage!;
      expect(flowMsg.type).toBe('branch');
      expect(flowMsg.targetStage).toEqual(['handlerA', 'handlerB']);
      expect(flowMsg.rationale).toBe('Multiple handlers matched');
      expect(flowMsg.count).toBe(2);
    });

    test('should walk child with its own children (nested branches)', () => {
      const child = pipelineRuntime.rootStageContext.createChild('p', 'b1', 'child');
      const grandchild = child.createChild('p.child', 'b1.1', 'grandchild');

      const narrative = pipelineRuntime.getFullNarrative();
      expect(narrative).toHaveLength(3);
      expect(narrative[0].stageName).toBe('rootName');
      expect(narrative[1].stageName).toBe('child');
      expect(narrative[2].stageName).toBe('grandchild');
    });
  });
});
