import {
  applyOutputMapping,
  extractParentScopeValues,
  getInitialScopeValues,
} from '../../../../src/lib/engine/handlers/SubflowInputMapper';

describe('SubflowInputMapper', () => {
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

    it('appends arrays to existing arrays', () => {
      const context = makeContext();
      context.getGlobal.mockReturnValue([1, 2]);
      const options = {
        outputMapper: () => ({ items: [3, 4] }),
      };

      applyOutputMapping(null, {}, context, options);
      expect(context.setGlobal).toHaveBeenCalledWith('items', [1, 2, 3, 4]);
    });

    it('merges nested objects via setObject', () => {
      const context = makeContext();
      const options = {
        outputMapper: () => ({ agent: { status: 'done' } }),
      };

      applyOutputMapping(null, {}, context, options);
      expect(context.setObject).toHaveBeenCalledWith(['agent'], 'status', 'done');
    });

    it('appends nested arrays via appendToArray', () => {
      const context = makeContext();
      const options = {
        outputMapper: () => ({ agent: { messages: ['hello'] } }),
      };

      applyOutputMapping(null, {}, context, options);
      expect(context.appendToArray).toHaveBeenCalledWith(['agent'], 'messages', ['hello']);
    });
  });
});

function makeContext(): any {
  return {
    setGlobal: jest.fn(),
    getGlobal: jest.fn().mockReturnValue(undefined),
    setObject: jest.fn(),
    mergeObject: jest.fn(),
    appendToArray: jest.fn(),
  };
}
