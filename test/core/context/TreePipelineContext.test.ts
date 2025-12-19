import { GlobalContext } from '../../../src/core/context/GlobalContext';
import { StageContext } from '../../../src/core/context/StageContext';
import { TreePipelineContext } from '../../../src/core/context/TreePipelineContext';

describe('TreePipelineContext', () => {
  let treePipelineContext: TreePipelineContext;

  beforeEach(() => {
    treePipelineContext = new TreePipelineContext('rootName', {
      showDisclaimer: true,
    });
  });

  test('should initialize with a root StageContext', () => {
    expect(treePipelineContext.rootStageContext).toBeInstanceOf(StageContext);
    expect(treePipelineContext.rootStageContext.stageName).toBe('rootName');
  });

  test('should initialize with a GlobalContext', () => {
    expect(treePipelineContext.globalContext).toBeInstanceOf(GlobalContext);
  });

  test('should return context tree', () => {
    const contextTree = treePipelineContext.getContextTree();
    expect(contextTree).toEqual({
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

  test('should reflect updates in global context', () => {
    treePipelineContext.globalContext.updateValue('', [], 'testKey', 'testValue');
    const contextTree = treePipelineContext.getContextTree();
    expect(contextTree.globalContext).toEqual({ showDisclaimer: true, testKey: 'testValue' });
  });

  test('should add debug info in root stage context', () => {
    treePipelineContext.rootStageContext.addDebugInfo('debugKey', 'debugValue');
    const contextTree = treePipelineContext.getContextTree();
    expect(contextTree.stageContexts.logs).toEqual({ debugKey: 'debugValue' });
  });

  test('should add error info in root stage context', () => {
    treePipelineContext.rootStageContext.addErrorInfo('errorKey', 'errorValue');
    const contextTree = treePipelineContext.getContextTree();
    expect(contextTree.stageContexts.errors).toEqual({ errorKey: 'errorValue' });
  });

  test('should add child contexts correctly', () => {
    const childContext = treePipelineContext.rootStageContext.createChildContext('childPath', 'childId', 'childName');
    const contextTree = treePipelineContext.getContextTree();
    expect(contextTree.stageContexts.children?.[0]).toEqual({
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
    const nextContext = treePipelineContext.rootStageContext.createNextContext('nextPath', 'nextName');
    const contextTree = treePipelineContext.getContextTree();
    expect(contextTree.stageContexts.next).toEqual({
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
    const nextContext = treePipelineContext.rootStageContext.createNextContext('nextPath', 'nextName', true);
    const contextTree = treePipelineContext.getContextTree();
    expect(contextTree.stageContexts.next).toEqual({
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
});
