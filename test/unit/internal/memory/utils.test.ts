import { DELIM, MemoryPatch } from '../../../../src/internal/memory/WriteBuffer';
import { getNestedValue, redactPatch, updateNestedValue, updateValue } from '../../../../src/internal/memory/utils';

describe('updateValue', () => {
  let object: any;

  beforeEach(() => {
    object = {};
  });

  test('should update object with array value', () => {
    updateValue(object, 'key', [1, 2, 3]);
    expect(object.key).toEqual([1, 2, 3]);

    updateValue(object, 'key', [4, 5]);
    expect(object.key).toEqual([1, 2, 3, 4, 5]);
  });

  test('should update object with object value', () => {
    updateValue(object, 'key', { a: 1 });
    expect(object.key).toEqual({ a: 1 });

    updateValue(object, 'key', { b: 2 });
    expect(object.key).toEqual({ a: 1, b: 2 });
  });

  test('should update object with primitive value', () => {
    updateValue(object, 'key', 1);
    expect(object.key).toBe(1);

    updateValue(object, 'key', 'value');
    expect(object.key).toBe('value');
  });

  test('should update object with empty value', () => {
    updateValue(object, 'key', null);
    expect(object.key).toBeNull();

    updateValue(object, 'key', undefined);
    expect(object.key).toBeUndefined();
  });
});

describe('updateNestedValue', () => {
  test('sets a nested value in a new object', () => {
    const obj: any = {};
    updateNestedValue(obj, '', ['level1', 'level2'], 'field', 'value');
    expect(obj).toEqual({
      level1: {
        level2: {
          field: 'value',
        },
      },
    });
  });
  test('updates a nested value in an existing object', () => {
    const obj: any = { level1: { level2: { field: 'oldValue' } } };
    updateNestedValue(obj, '', ['level1', 'level2'], 'field', 'newValue');
    expect(obj.level1.level2.field).toBe('newValue');
  });

  test('creates pipeline with default values  ', () => {
    const expectedObj: any = {
      pipelines: {
        pipeline1: {
          defaultValue: 1,
          level1: {
            field: 'fieldValue',
          },
        },
      },
    };
    const defaultValues: any = { defaultValue: 1 };
    updateNestedValue({}, 'pipeline1', ['pipelines', 'pipeline1', 'level1'], 'field', 'fieldValue', defaultValues);
    expect(expectedObj.pipelines.pipeline1.defaultValue).toBeDefined();
    expect(expectedObj.pipelines.pipeline1.defaultValue).toEqual(1);
    expect(expectedObj.pipelines.pipeline1.level1).toBeDefined();
    expect(expectedObj.pipelines.pipeline1.level1.field).toEqual('fieldValue');
  });
});

describe('getNestedValue', () => {
  test('gets a nested value from an object', () => {
    const obj: any = { level1: { level2: { field: 'value' } } };
    const value = getNestedValue(obj, ['level1', 'level2'], 'field');
    expect(value).toBe('value');
  });
  test('returns undefined for a non-existing path', () => {
    const obj: any = { level1: { level2: { field: 'value' } } };
    const value = getNestedValue(obj, ['level1', 'nonExistent'], 'field');
    expect(value).toBeUndefined();
  });
});

describe('redactPatch', () => {
  it('redacts an existing value (scalar or object)', () => {
    const bundle: MemoryPatch = {
      chat: { secret: '123-45-6789', profile: { ssn: 'abc' } },
      foo: 42,
    };
    const redacted = redactPatch(bundle, new Set([`chat${DELIM}secret`, `chat${DELIM}profile`]));
    expect(redacted.chat.secret).toBe('REDACTED');
    expect(redacted.chat.profile).toBe('REDACTED');
    // unrelated keys stay intact
    expect(redacted.foo).toBe(42);
  });
  it('does NOT create phantom keys when path is absent', () => {
    const bundle: MemoryPatch = { foo: 1 };
    const redacted = redactPatch(bundle, new Set([`bar${DELIM}baz`]));
    // redacted bundle equals original
    expect(redacted).toEqual(bundle);
    // and still has no 'bar'
    expect(redacted).not.toHaveProperty('bar');
  });
  it('preserves explicit undefined overwrites', () => {
    const bundle: MemoryPatch = { chat: { token: undefined } };
    const redacted = redactPatch(bundle, new Set([`chat${DELIM}token`]));
    // stays undefined (not 'REDACTED')
    expect(redacted.chat.token).toBeUndefined();
  });
});
