import { setNestedValue, updateNestedValue } from '../stateManagement/utils';

export class DebugContext {
  public logContext: { [key: string]: any } = {};
  public errorContext: { [key: string]: any } = {};
  public metricContext: { [key: string]: any } = {};
  public evalContext: { [key: string]: any } = {};

  addDebugInfo(key: string, value: any, path: string[] = []) {
    updateNestedValue(this.logContext, '', path, key, value);
  }

  setDebugInfo(key: string, value: any, path: string[] = []) {
    setNestedValue(this.logContext, '', path, key, value);
  }

  addErrorInfo(key: string, value: any, path: string[] = []) {
    updateNestedValue(this.errorContext, '', path, key, value);
  }

  addMetric(key: string, value: any, path: string[] = []) {
    updateNestedValue(this.metricContext, '', path, key, value);
  }

  setMetric(key: string, value: any, path: string[] = []) {
    setNestedValue(this.metricContext, '', path, key, value);
  }

  addEval(key: string, value: any, path: string[] = []) {
    updateNestedValue(this.evalContext, '', path, key, value);
  }

  setEval(key: string, value: any, path: string[] = []) {
    setNestedValue(this.evalContext, '', path, key, value);
  }
}
