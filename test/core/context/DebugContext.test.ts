import { DebugContext } from '../../../src/core/context/DebugContext';

describe('DebugContext', () => {
  let debugContext: DebugContext;

  beforeEach(() => {
    debugContext = new DebugContext();
  });

  test('should add debug info', () => {
    debugContext.addDebugInfo('testKey', 'testValue');
    expect(debugContext.logContext.testKey).toBe('testValue');
  });

  test('should add error info', () => {
    debugContext.addErrorInfo('testKey', 'testValue');
    expect(debugContext.errorContext.testKey).toBe('testValue');
  });
});
