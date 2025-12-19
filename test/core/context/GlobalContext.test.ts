import { GlobalContext } from '../../../src/core/context/GlobalContext';

describe('GlobalContext', () => {
  let globalContext: GlobalContext;

  beforeEach(() => {
    globalContext = new GlobalContext();
  });

  test('should update global context', () => {
    globalContext.updateValue('', [], 'key', 'value');
    const context = globalContext.getValue('', [], 'key');
    expect(context).toBe('value');
  });

  test('should update pipeline in global context', () => {
    globalContext.updateValue('id1', [], 'key', 'value');
    const context = globalContext.getValue('id1', [], 'key');
    expect(context).toBe('value');
  });

  test('should update nested object in global context', () => {
    globalContext.updateValue('id1', ['a', 'b'], 'key', 'value');
    const context = globalContext.getValue('id1', ['a', 'b'], 'key');
    expect(context).toBe('value');
  });

  test('should return JSON representation', () => {
    const json = globalContext.getJson();
    expect(json).toEqual({});
  });
});
