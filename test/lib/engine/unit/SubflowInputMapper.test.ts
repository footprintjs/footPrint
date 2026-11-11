import { vi } from 'vitest';

import {
  applyOutputMapping,
  extractParentScopeValues,
  getInitialScopeValues,
} from '../../../../src/lib/engine/handlers/SubflowInputMapper';

describe('SubflowInputMapper', () => {
  it('pure helper calls supply no native binding and preserve their data results', () => {
    const parent = { x: 3 };
    const inputMapper = vi.fn((p: typeof parent) => ({ y: p.x }));
    const outputMapper = vi.fn((value: number, p: typeof parent) => ({ y: value + p.x }));
    expect(getInitialScopeValues(parent, { inputMapper })).toEqual({ y: 3 });
    expect(inputMapper).toHaveBeenCalledWith(parent, undefined);
    const context = makeContext();
    expect(applyOutputMapping(4, parent, context, { outputMapper })).toEqual({ y: 7 });
    expect(outputMapper).toHaveBeenCalledWith(4, parent, undefined);
    expect(context.setGlobal).toHaveBeenCalledWith('y', 7);
  });
  describe('extractParentScopeValues', () => {
    it('returns empty object when no options', () => {
      expect(extractParentScopeValues({ foo: 1 })).toEqual({});
    });

    it('returns empty object when no inputMapper', () => {
      expect(extractParentScopeValues({ foo: 1 }, {})).toEqual({});
    });

    it('calls inputMapper with parent scope', () => {
      const parentScope = { name: 'Alice', age: 30 };
      const options = {
        inputMapper: (scope: any) => ({ userName: scope.name }),
      };

      const result = extractParentScopeValues(parentScope, options);
      expect(result).toEqual({ userName: 'Alice' });
    });

    it('returns empty object for null/undefined mapper result', () => {
      expect(extractParentScopeValues({}, { inputMapper: () => null as any })).toEqual({});
      expect(extractParentScopeValues({}, { inputMapper: () => undefined as any })).toEqual({});
    });
  });

  describe('getInitialScopeValues', () => {
    it('delegates to extractParentScopeValues (always isolated)', () => {
      const scope = { x: 1, y: 2 };
      const options = { inputMapper: (s: any) => ({ mapped: s.x }) };
      expect(getInitialScopeValues(scope, options)).toEqual({ mapped: 1 });
    });
  });

  describe('applyOutputMapping', () => {
    it('returns undefined when no outputMapper', () => {
      const context = makeContext();
      expect(applyOutputMapping('output', {}, context)).toBeUndefined();
      expect(applyOutputMapping('output', {}, context, {})).toBeUndefined();
    });

    it('returns undefined for null mapper result', () => {
      const context = makeContext();
      expect(applyOutputMapping('output', {}, context, { outputMapper: () => null as any })).toBeUndefined();
    });

    it('writes scalar values via setGlobal', () => {
      const context = makeContext();
      const options = {
        outputMapper: (output: string) => ({ result: output }),
      };

      const result = applyOutputMapping('hello', {}, context, options);
      expect(result).toEqual({ result: 'hello' });
      expect(context.setGlobal).toHaveBeenCalledWith('result', 'hello');
    });

    it('appends arrays to existing arrays, and reads the existing one as a read of the mount', () => {
      const context = makeContext();
      context.readLiveRoot.mockReturnValue([1, 2]);
      const options = {
        outputMapper: () => ({ items: [3, 4] }),
      };

      applyOutputMapping(null, {}, context, options);
      expect(context.setGlobal).toHaveBeenCalledWith('items', [1, 2, 3, 4]);
      expect(context.readLiveRoot.mock.calls).toEqual([['items']]);
      // The appended array is a new one: the list the mapper returned is asked about before it is lost.
      expect(context.inheritRule.mock.calls).toEqual([[[], 'items', [3, 4]]]);
    });

    it('an array that replaces reads nothing of the parent', () => {
      const context = makeContext();
      applyOutputMapping(null, {}, context, { outputMapper: () => ({ items: [3] }), arrayMerge: 'replace' } as never);
      expect(context.setGlobal).toHaveBeenCalledWith('items', [3]);
      expect(context.readLiveRoot).not.toHaveBeenCalled();
    });

    it('merges nested objects via setObject', () => {
      const context = makeContext();
      const options = {
        outputMapper: () => ({ agent: { status: 'done' } }),
      };

      applyOutputMapping(null, {}, context, options);
      expect(context.setObject).toHaveBeenCalledWith(['agent'], 'status', 'done');
      // The field goes into what the parent holds under `agent`: the mount read that, once, where its
      // fields are written (its own view), and asked whether the object it takes apart carries a rule.
      expect(context.readOwnView.mock.calls).toEqual([['agent']]);
      expect(context.readLiveRoot).not.toHaveBeenCalled();
      expect(context.inheritRule.mock.calls).toEqual([[[], 'agent', { status: 'done' }]]);
    });

    it('an empty object merges nothing and reads nothing', () => {
      const context = makeContext();
      applyOutputMapping(null, {}, context, { outputMapper: () => ({ agent: {} }) });
      expect(context.setObject).not.toHaveBeenCalled();
      expect(context.readOwnView).not.toHaveBeenCalled();
      expect(context.inheritRule).not.toHaveBeenCalled();
    });

    it('appends nested arrays via appendToArray', () => {
      const context = makeContext();
      const options = {
        outputMapper: () => ({ agent: { messages: ['hello'] } }),
      };

      applyOutputMapping(null, {}, context, options);
      expect(context.appendToArray).toHaveBeenCalledWith(['agent'], 'messages', ['hello']);
      // A list among the fields is written as a NEW array: it is asked about by itself too.
      expect(context.inheritRule.mock.calls).toEqual([
        [[], 'agent', { messages: ['hello'] }],
        [['agent'], 'messages', ['hello']],
      ]);
    });
  });
});

function makeContext(): any {
  return {
    setGlobal: vi.fn(),
    getGlobal: vi.fn().mockReturnValue(undefined),
    readLiveRoot: vi.fn().mockReturnValue(undefined),
    readOwnView: vi.fn().mockReturnValue(undefined),
    inheritRule: vi.fn(),
    setObject: vi.fn(),
    mergeObject: vi.fn(),
    appendToArray: vi.fn(),
  };
}
