import { GlobalStore } from '../../../../src/core/memory/GlobalStore';

describe('GlobalStore', () => {
  let globalStore: GlobalStore;

  beforeEach(() => {
    globalStore = new GlobalStore();
  });

  test('should update global context', () => {
    globalStore.updateValue('', [], 'key', 'value');
    const context = globalStore.getValue('', [], 'key');
    expect(context).toBe('value');
  });

  test('should update pipeline in global context', () => {
    globalStore.updateValue('id1', [], 'key', 'value');
    const context = globalStore.getValue('id1', [], 'key');
    expect(context).toBe('value');
  });

  test('should update nested object in global context', () => {
    globalStore.updateValue('id1', ['a', 'b'], 'key', 'value');
    const context = globalStore.getValue('id1', ['a', 'b'], 'key');
    expect(context).toBe('value');
  });

  test('should return JSON representation', () => {
    const json = globalStore.getState();
    expect(json).toEqual({});
  });
});
