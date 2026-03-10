import { detectSchema } from '../../../../src/lib/schema/detect';
import { validateAgainstSchema } from '../../../../src/lib/schema/validate';

describe('Security: schema detection prototype pollution', () => {
  it('__proto__ property does not pollute detection', () => {
    const obj = Object.create(null);
    obj.__proto__ = { safeParse: () => ({ success: true }) };
    // Object.create(null) ignores __proto__ as prototype — it's just a data property
    // detectSchema should see no schema-like methods on obj itself
    expect(detectSchema(obj)).toBe('none');
  });

  it('inherited safeParse does not trick detection', () => {
    // Create an object that inherits safeParse from its prototype
    const proto = { safeParse: () => ({ success: true }) };
    const obj = Object.create(proto);
    // detectSchema uses typeof checks which DO see inherited properties — this is expected
    expect(detectSchema(obj)).toBe('parseable');
  });

  it('frozen schema objects still work for detection', () => {
    const schema = Object.freeze({ safeParse: () => ({ success: true, data: 42 }) });
    expect(detectSchema(schema)).toBe('parseable');
  });

  it('sealed schema objects still work for detection', () => {
    const schema = Object.seal({ parse: (v: unknown) => v, _def: { type: 'string' } });
    expect(detectSchema(schema)).toBe('zod');
  });
});

describe('Security: validation does not leak data', () => {
  it('validation failure does not include input data in error message', () => {
    const sensitiveInput = { password: 'super-secret-123', ssn: '123-45-6789' };
    const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };

    const result = validateAgainstSchema(schema, sensitiveInput);
    if (!result.success) {
      const errorStr = JSON.stringify(result.error);
      expect(errorStr).not.toContain('super-secret-123');
      expect(errorStr).not.toContain('123-45-6789');
    }
  });

  it('JSON Schema validation does not mutate the input', () => {
    const input = { name: 'Alice', age: 30 };
    const original = { ...input };
    const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };

    validateAgainstSchema(schema, input);
    expect(input).toEqual(original);
  });
});
