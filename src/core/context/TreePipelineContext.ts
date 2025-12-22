import { CommitBundle, MemoryHistory } from '../stateManagement/MemoryHistory';
import { GlobalContext } from './GlobalContext';
import { StageContext, StageType } from './StageContext';

export type ContextTreeType = {
  globalContext: Record<string, unknown>;
  stageContexts: StageType;
  history: CommitBundle[];
};

export class TreePipelineContext {
  public globalContext: GlobalContext;
  public rootStageContext: StageContext;
  public pipelineHistory: MemoryHistory;

  constructor(rootName: string, defaultValuesForContext?: unknown, initialContext?: unknown) {
    this.pipelineHistory = new MemoryHistory(initialContext);
    this.globalContext = new GlobalContext(defaultValuesForContext, initialContext);
    this.rootStageContext = new StageContext('', rootName, this.globalContext, '', this.pipelineHistory);
  }

  getPipelines() {
    return this.globalContext.getPipelines();
  }

  setRootObject(path: string[], key: string, value: unknown) {
    this.rootStageContext.setObject(path, key, value);
  }

  getContextTree(): ContextTreeType {
    const globalContext = this.globalContext.getJson();
    const stageContexts = this.rootStageContext.getJson();
    return {
      globalContext,
      stageContexts,
      history: this.pipelineHistory.list(),
    };
  }
}
