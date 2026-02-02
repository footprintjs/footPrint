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
});
