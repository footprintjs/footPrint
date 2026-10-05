import { describe, expect, it } from 'vitest';

import { flowChart } from '../../../../src/index';
import type { SerializedPipelineStructure } from '../../../../src/lib/builder/types';

function buildLinearChain(length: number) {
  let builder = flowChart('Stage0', () => {}, 'stage-0');
  for (let index = 1; index < length; index++) {
    builder = builder.addFunction(`Stage${index}`, () => {}, `stage-${index}`);
  }
  return builder.build();
}

function deepStructure(depth: number): SerializedPipelineStructure {
  let node: SerializedPipelineStructure = { name: 'Injected', id: `node-${depth}`, type: 'stage' };
  for (let index = depth - 1; index >= 0; index--) {
    node = { name: 'Injected', id: `node-${index}`, type: 'stage', next: node };
  }
  return node;
}

function descriptions(chart: ReturnType<typeof buildLinearChain>) {
  const spec = chart.toOpenAPI({}) as {
    info: { description: string };
    paths: Record<string, { post: { description: string } }>;
  };
  return [spec.info.description, ...Object.values(spec.paths).map(({ post }) => post.description)];
}

describe('chart.toOpenAPI() — consumes the builder description without a structure walk', () => {
  it.each([1, 5, 20, 30])('retains the canonical description of a %i-stage chart', (length) => {
    const chart = buildLinearChain(length);
    expect(chart.description).toContain('Stage0');
    expect(chart.description).toContain(`Stage${length - 1}`);
    expect(descriptions(chart)).toEqual([chart.description, chart.description]);
    expect(descriptions(chart)).toEqual(descriptions(chart));
  });

  it.each([499, 501, 1000])('ignores an injected %i-level build-time structure', (depth) => {
    const chart = buildLinearChain(3);
    const canonical = chart.description;
    const injected = deepStructure(depth);
    // Mutate the actual chart closed over by toOpenAPI, not a shallow copy whose
    // methods would still read the original chart and make this guard vacuous.
    chart.buildTimeStructure = injected;

    expect(chart.buildTimeStructure).toBe(injected);
    expect(descriptions(chart)).toEqual([canonical, canonical]);
    expect(JSON.stringify(chart.toOpenAPI({}))).not.toContain('Injected');
  });

  it('does not even read buildTimeStructure', () => {
    const chart = buildLinearChain(3);
    const canonical = chart.description;
    Object.defineProperty(chart, 'buildTimeStructure', {
      get() {
        throw new Error('OpenAPI must not read the structure');
      },
    });

    expect(descriptions(chart)).toEqual([canonical, canonical]);
  });

  it('ignores a cyclic injected structure without affecting subsequent charts', () => {
    const chart = buildLinearChain(3);
    const cycle: SerializedPipelineStructure = { name: 'Injected', id: 'injected', type: 'stage' };
    cycle.next = cycle;
    chart.buildTimeStructure = cycle;
    expect(descriptions(chart)).toEqual([chart.description, chart.description]);

    const normal = buildLinearChain(2);
    expect(descriptions(normal)).toEqual([normal.description, normal.description]);
  });

  it('keeps the collected loop description', () => {
    const chart = flowChart('Start', (scope) => scope.$break(), 'start')
      .loopTo('start')
      .build();
    expect(descriptions(chart)).toEqual([chart.description, chart.description]);
  });

  it('keeps the collected decider branch description', () => {
    const chart = flowChart('Router', () => {}, 'router')
      .addDeciderFunction('Route', () => 'a', 'route', 'Route the request')
      .addFunctionBranch('a', 'HandleA', () => {})
      .addFunctionBranch('b', 'HandleB', () => {})
      .end()
      .build();

    expect(chart.description).toContain('(branches: a, b)');
    expect(descriptions(chart)).toEqual([chart.description, chart.description]);
  });

  it('keeps the collected parallel child descriptions', () => {
    const chart = flowChart('Fetch', () => {}, 'fetch')
      .addListOfFunction([
        { id: 'a', name: 'ParseHTML', fn: () => {} },
        { id: 'b', name: 'ParseCSS', fn: () => {} },
      ])
      .addFunction('Merge', () => {}, 'merge')
      .build();

    expect(chart.description).toContain('parallel');
    expect(chart.description).toContain('ParseHTML');
    expect(chart.description).toContain('ParseCSS');
    expect(descriptions(chart)).toEqual([chart.description, chart.description]);
  });
});
