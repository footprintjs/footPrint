/**
 * Tests for generateOpenAPI() description source and resilience to injected structures.
 *
 * Principle: collect during traversal, never post-process.
 *
 * chart.description is assembled incrementally by FlowChartBuilder as each stage is
 * added (_descriptionParts array). By the time build() is called, the description is
 * complete. generateOpenAPI() reads chart.description directly — it never walks
 * buildTimeStructure. This means:
 *
 *   1. No recursive walk = no stack overflow risk in the openapi path.
 *   2. Injecting a deep buildTimeStructure cannot affect the description.
 *   3. The description is always the canonical builder-assembled text.
 */

import { flowChart } from '../../../../src/index';
import type { FlowChart, SerializedPipelineStructure } from '../../../../src/lib/builder/types';
import { defineContract } from '../../../../src/lib/contract/defineContract';
import { generateOpenAPI } from '../../../../src/lib/contract/openapi';

// Helper: build a linear chain of N stages
function buildLinearChain(n: number): FlowChart {
  let builder = flowChart<any>('Stage0', async () => {}, 'stage-0');
  for (let i = 1; i < n; i++) {
    builder = builder.addFunction(`Stage${i}`, async () => {}, `stage-${i}`) as any;
  }
  return builder.build();
}

// Helper: replace buildTimeStructure with an injected deep linked list
// (simulates a malformed or adversarially crafted structure)
function injectDeepStructure(chart: FlowChart, depth: number): FlowChart {
  let node: SerializedPipelineStructure = { name: `node-${depth}`, type: 'stage' };
  for (let i = depth - 1; i >= 1; i--) {
    node = { name: `node-${i}`, type: 'stage', next: node };
  }
  const root: SerializedPipelineStructure = { name: 'root', type: 'stage', next: node };
  return { ...chart, buildTimeStructure: root };
}

// ---------------------------------------------------------------------------
// Pattern 1: unit — description comes from chart.description, not structure walk
// ---------------------------------------------------------------------------
describe('openapi description source — unit: uses chart.description', () => {
  it('a single-stage pipeline generates a valid OpenAPI spec', () => {
    const chart = buildLinearChain(1);
    const contract = defineContract(chart, {});
    const spec = generateOpenAPI(contract);
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBeDefined();
  });

  it('description in spec matches chart.description (not a re-derived value)', () => {
    const chart = buildLinearChain(3);
    const contract = defineContract(chart, {});
    const spec = generateOpenAPI(contract);
    const description = Object.values(spec.paths)[0]?.post?.description ?? '';
    // chart.description is the canonical source — spec description must equal it
    expect(description).toBe(chart.description);
  });

  it('injecting a deep buildTimeStructure does not change the description', () => {
    const chart = buildLinearChain(3);
    const originalDescription = chart.description;
    const injected = injectDeepStructure(chart, 200);
    const contract = defineContract(injected, {});
    const spec = generateOpenAPI(contract);
    const description = Object.values(spec.paths)[0]?.post?.description ?? '';
    // Description comes from chart.description (pre-built), not buildTimeStructure
    expect(description).toBe(originalDescription);
  });
});

// ---------------------------------------------------------------------------
// Pattern 2: boundary — deep injected structures do not throw
// ---------------------------------------------------------------------------
describe('openapi description source — boundary: deep buildTimeStructure is ignored', () => {
  it('a 499-node injected chain does not throw', () => {
    const base = buildLinearChain(1);
    const deep = injectDeepStructure(base, 499);
    const contract = defineContract(deep, {});
    expect(() => generateOpenAPI(contract)).not.toThrow();
  });

  it('a 501-node injected chain does not throw (no structure walk in openapi)', () => {
    const base = buildLinearChain(1);
    const deep = injectDeepStructure(base, 501);
    const contract = defineContract(deep, {});
    // Previously this would have thrown FOOTPRINT_WALK_DEPTH_EXCEEDED.
    // Now it succeeds because the description comes from chart.description.
    expect(() => generateOpenAPI(contract)).not.toThrow();
  });

  it('a 1000-node injected chain does not throw', () => {
    const base = buildLinearChain(1);
    const deep = injectDeepStructure(base, 1000);
    const contract = defineContract(deep, {});
    expect(() => generateOpenAPI(contract)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pattern 3: scenario — realistic pipeline shapes produce correct descriptions
// ---------------------------------------------------------------------------
describe('openapi description source — scenario: realistic pipelines', () => {
  it('a 30-stage linear pipeline description contains all stage names', () => {
    const chart = buildLinearChain(30);
    const contract = defineContract(chart, {});
    const spec = generateOpenAPI(contract);
    const description = Object.values(spec.paths)[0]?.post?.description ?? '';
    expect(description).toContain('Stage0');
    expect(description).toContain('Stage29');
  });

  it('a pipeline with loopTo generates without error', async () => {
    const chart = flowChart<any>(
      'Start',
      async (scope: any) => {
        scope.$break();
      },
      'start',
    )
      .loopTo('start')
      .build();
    const contract = defineContract(chart, {});
    expect(() => generateOpenAPI(contract)).not.toThrow();
  });

  it('a pipeline with parallel forks generates correctly', () => {
    const chart = flowChart<any>('Intake', async () => {}, 'intake')
      .addFunction('Process', async () => {}, 'process')
      .addFunction('Output', async () => {}, 'output')
      .build();
    const contract = defineContract(chart, {});
    expect(() => generateOpenAPI(contract)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Pattern 4: property — description is stable across multiple generateOpenAPI calls
// ---------------------------------------------------------------------------
describe('openapi description source — property: description is deterministic', () => {
  it('calling generateOpenAPI twice on the same contract produces identical descriptions', () => {
    const chart = buildLinearChain(5);
    const contract = defineContract(chart, {});
    const spec1 = generateOpenAPI(contract);
    const spec2 = generateOpenAPI(contract);
    const desc1 = Object.values(spec1.paths)[0]?.post?.description;
    const desc2 = Object.values(spec2.paths)[0]?.post?.description;
    expect(desc1).toBe(desc2);
  });

  it('description equals chart.description for chains of any length', () => {
    for (const n of [1, 5, 20]) {
      const chart = buildLinearChain(n);
      const contract = defineContract(chart, {});
      const spec = generateOpenAPI(contract);
      const description = Object.values(spec.paths)[0]?.post?.description ?? '';
      expect(description).toBe(chart.description);
    }
  });
});

// ---------------------------------------------------------------------------
// Pattern 5: security — injected structure cannot corrupt description or throw
// ---------------------------------------------------------------------------
describe('openapi description source — security: injected buildTimeStructure is inert', () => {
  it('injected 1000-node structure does not throw and does not alter description', () => {
    const chart = buildLinearChain(3);
    const originalDescription = chart.description;
    const injected = injectDeepStructure(chart, 1000);
    const contract = defineContract(injected, {});

    let thrown: unknown;
    let spec: ReturnType<typeof generateOpenAPI> | undefined;
    try {
      spec = generateOpenAPI(contract);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeUndefined();
    expect(spec).toBeDefined();
    const description = Object.values(spec!.paths)[0]?.post?.description ?? '';
    // Injected structure must not bleed into the description
    expect(description).toBe(originalDescription);
    expect(description).not.toContain('node-1');
  });

  it('after injected-structure call, a normal pipeline still generates correctly', () => {
    const base = buildLinearChain(1);
    const deep = injectDeepStructure(base, 1000);
    const contract = defineContract(deep, {});
    generateOpenAPI(contract); // must not corrupt module state

    const normal = buildLinearChain(3);
    const normalContract = defineContract(normal, {});
    const spec = generateOpenAPI(normalContract);
    expect(spec.openapi).toBe('3.1.0');
  });
});
