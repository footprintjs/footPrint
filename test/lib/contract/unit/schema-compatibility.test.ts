import { describe, expect, it } from 'vitest';
import { z as z3 } from 'zod/v3';

import { normalizeSchema, zodToJsonSchema } from '../../../../src/advanced.js';

describe('schema compatibility through the advanced door', () => {
  it('normalizes actual Zod 3 arrays, optional/default fields and both enum forms without losing their values', () => {
    const schema = z3.object({
      names: z3.array(z3.string()),
      mode: z3.enum(['read', 'write']),
      role: z3.nativeEnum({ Viewer: 'viewer', Editor: 'editor' }),
      enabled: z3.literal(false),
      retries: z3.number().default(0),
      note: z3.string().optional(),
    });
    expect(normalizeSchema(schema)).toEqual({
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string', enum: ['read', 'write'] },
        role: { type: 'string', enum: ['viewer', 'editor'] },
        enabled: { type: 'boolean', enum: [false] },
        retries: { type: 'number', default: 0 },
        note: { type: 'string' },
      },
      required: ['names', 'mode', 'role', 'enabled'],
    });
  });

  it('unwraps real Zod 3 effects and pipelines to input schemas, preserving descriptions and nullable/union records', () => {
    expect(normalizeSchema(z3.string().transform((value) => value.length))).toEqual({ type: 'string' });
    expect(normalizeSchema(z3.string().pipe(z3.coerce.number()))).toEqual({ type: 'string' });
    expect(
      normalizeSchema(
        z3
          .record(z3.union([z3.string(), z3.number()]))
          .nullable()
          .describe('attributes'),
      ),
    ).toEqual({
      description: 'attributes',
      oneOf: [
        { type: 'object', additionalProperties: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
        { type: 'null' },
      ],
    });
  });

  it('keeps the available definition when a runtime-dependent Zod 3 default throws during normalization', () => {
    const unavailable = () => {
      throw new Error('default needs runtime context');
    };
    const schema = z3.string().default(unavailable);
    expect(normalizeSchema(schema)).toEqual({ type: 'string', default: unavailable });
  });

  it.each([
    [{ _def: {} }, {}],
    [{ _def: { typeName: 'FutureZodType' } }, {}],
    [{ def: { type: 'literal' } }, { enum: [] }],
    [{ def: { type: 'literal', values: ['a', 'b'] } }, { enum: ['a', 'b'] }],
    [{ def: { type: 'enum' } }, { type: 'string', enum: [] }],
    [{ def: { type: 'array' } }, { type: 'array', items: {} }],
    [{ def: { type: 'object' } }, { type: 'object' }],
    [{ def: { type: 'optional' } }, {}],
    [{ def: { type: 'default', defaultValue: 0 } }, { default: 0 }],
    [{ def: { type: 'nullable' } }, { oneOf: [{}, { type: 'null' }] }],
    [{ def: { type: 'union' } }, {}],
    [{ def: { type: 'union', options: [{}, { _def: { type: 'boolean' } }] } }, { oneOf: [{ type: 'boolean' }] }],
    [{ def: { type: 'record' } }, { type: 'object', additionalProperties: true }],
    [{ def: { type: 'pipe' } }, {}],
    [{ def: { type: 'transform' } }, {}],
    [{ _def: { typeName: 'ZodEffects', innerType: { _def: { type: 'string' } } } }, { type: 'string' }],
  ])('does not invent constraints for incomplete or future schema definitions (%#)', (schema, expected) => {
    expect(zodToJsonSchema(schema)).toEqual(expected);
  });

  it('retains incomplete optional/default fields without making them required or inventing types', () => {
    expect(
      zodToJsonSchema({
        def: {
          type: 'object',
          shape: {
            optional: { def: { type: 'optional' } },
            defaulted: { def: { type: 'default' } },
            unknown: {},
          },
        },
      }),
    ).toEqual({ type: 'object', properties: { optional: {}, defaulted: {} } });
  });
});
