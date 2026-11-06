/**
 * Property: for ANY selected value, by ANY selection route and threshold shape, the served evidence holds it nowhere —
 * not on a live event, in the narrative, in a redacted recorder row, or on disk. And its twin, so the first cannot pass
 * by hiding everything: a threshold nothing selected, in a stage with no selected read, stays a value with no marker.
 *
 * Test type: Property (fast-check).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RedactionPolicy } from '../../../../src/index.js';
import { decide, flowChart, select } from '../../../../src/index.js';
import { conditionsOf, evidenceSurfaces, surfacesHolding } from '../helpers/evidenceSurfaces.js';

type Rules = (s: any) => any[];

/** A last rule matches, so `select()` always reports its evidence (it fires none when nothing was selected). */
function chartOf(door: 'decide' | 'select', seed: (s: any) => void, given: Rules) {
  const rules: Rules = (s) => [...given(s), { when: () => true, then: 'no' }];
  const start = flowChart<any>('Seed', seed, 'seed');
  const branches = (cursor: any) =>
    cursor.addFunctionBranch('yes', 'Yes', () => undefined).addFunctionBranch('no', 'No', () => undefined);
  if (door === 'decide') {
    return branches(start.addDeciderFunction('Route', (s: any) => decide(s, rules(s), 'no'), 'route'))
      .setDefault('no')
      .end()
      .build();
  }
  return branches(start.addSelectorFunction('Pick', (s: any) => select(s, rules(s)), 'pick'))
    .end()
    .build();
}

/** The shapes a threshold can take around a value. */
const SHAPES: ReadonlyArray<(value: string) => Record<string, unknown>> = [
  (value) => ({ ne: value }),
  (value) => ({ notIn: ['x', value] }),
  (value) => ({ ne: [value] }),
  (value) => ({ ne: { name: 'A', deep: { list: [value] } } }),
];

interface Case {
  readonly policy?: RedactionPolicy;
  readonly input?: unknown;
  readonly seed: (s: any) => void;
  readonly rules: Rules;
}

/** One selection route, for a value and a threshold shape. */
const ROUTES: ReadonlyArray<(value: string, shape: (value: string) => Record<string, unknown>) => Case> = [
  (value, shape) => ({
    policy: { keys: ['named'] },
    seed: (s) => {
      s.named = value;
    },
    rules: () => [{ when: { named: shape(value) }, then: 'yes' }],
  }),
  (value, shape) => ({
    policy: { patterns: [/^nam/] },
    seed: (s) => {
      s.named = value;
    },
    rules: () => [{ when: { named: shape(value) }, then: 'yes' }],
  }),
  (value, shape) => ({
    seed: (s) => {
      s.$setValue('named', value, true);
    },
    rules: () => [{ when: { named: shape(value) }, then: 'yes' }],
  }),
  (value, shape) => ({
    policy: { fields: { named: ['inner'] } },
    seed: (s) => {
      s.named = { inner: value };
    },
    rules: () => [{ when: { named: shape(value) }, then: 'yes' }],
  }),
  (value, shape) => ({
    policy: { keys: ['named'] },
    seed: (s) => {
      s.plain = 'clear';
      s.named = value;
    },
    rules: (s) => [{ when: { plain: shape(s.named) }, then: 'yes' }],
  }),
  (value, shape) => ({
    policy: { keys: ['named'] },
    input: { deep: { named: value } },
    seed: (s) => {
      s.plain = 'clear';
    },
    rules: (s) => [{ when: { plain: shape(s.$getArgs().deep.named) }, then: 'yes' }],
  }),
  (value) => ({
    policy: { keys: ['named'] },
    seed: (s) => {
      s.named = value;
    },
    rules: () => [
      {
        when: (x: any) => {
          throw new Error(`rule saw ${x.named}`);
        },
        then: 'yes',
      },
    ],
  }),
];

// Alphanumeric, so no JSON escape can hide the value from a substring search.
const secret = fc.stringMatching(/^[A-Za-z0-9]{10,24}$/).map((text) => `S3CR3T${text}`);

describe('evidence redaction — property', () => {
  it('the served evidence holds a selected value nowhere', async () => {
    await fc.assert(
      fc.asyncProperty(
        secret,
        fc.nat({ max: ROUTES.length - 1 }),
        fc.nat({ max: SHAPES.length - 1 }),
        fc.constantFrom('decide', 'select') as fc.Arbitrary<'decide' | 'select'>,
        async (value, route, shape, door) => {
          const built = ROUTES[route](value, SHAPES[shape]);
          const surfaces = await evidenceSurfaces(chartOf(door, built.seed, built.rules), built.policy, built.input);
          expect(surfaces.evidence.length).toBeGreaterThan(0);
          expect(surfaces.capture).not.toBe('');
          expect(surfacesHolding(surfaces, value)).toEqual([]);
          for (const condition of conditionsOf(surfaces)) expect(condition.thresholdRedacted).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  }, 60_000);

  it('a threshold nothing selected stays a value, under any policy that names something else', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant('[REDACTED]')),
        fc.constantFrom<RedactionPolicy>({ keys: ['named'] }, { patterns: [/^nam/] }, { fields: { named: ['inner'] } }),
        fc.constantFrom('decide', 'select') as fc.Arbitrary<'decide' | 'select'>,
        async (threshold, policy, door) => {
          const surfaces = await evidenceSurfaces(
            chartOf(
              door,
              (s) => {
                s.plain = 'clear';
                s.named = { inner: 'held back' };
              },
              () => [{ when: { plain: { ne: threshold } }, then: 'yes' }],
            ),
            policy,
          );
          const [condition] = conditionsOf(surfaces);
          expect(condition.threshold).toBe(threshold);
          expect(Object.hasOwn(condition, 'thresholdRedacted')).toBe(false);
        },
      ),
      { numRuns: 40 },
    );
  }, 60_000);
});
