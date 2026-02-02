import { StageMetadata } from '../../../../src/core/memory/StageMetadata';

describe('StageMetadata', () => {
  let stageMetadata: StageMetadata;

  beforeEach(() => {
    stageMetadata = new StageMetadata();
  });

  test('should add log entry', () => {
    stageMetadata.addLog('testKey', 'testValue');
    expect(stageMetadata.logContext.testKey).toBe('testValue');
  });

  test('should add error entry', () => {
    stageMetadata.addError('testKey', 'testValue');
    expect(stageMetadata.errorContext.testKey).toBe('testValue');
  });
});
