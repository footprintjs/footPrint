import { assert, boolean, constantFrom, integer, property, record } from 'fast-check';
import { expect, it } from 'vitest';

import { flowChart } from '../../../../src/index';
import type { FlowChart, StageNode } from '../../../../src/lib/builder/types';

const noop = () => {};
const generate = record({
  linear: integer({ min: 0, max: 4 }),
  branches: integer({ min: 1, max: 4 }),
  fork: integer({ min: 2, max: 4 }),
  nesting: integer({ min: 0, max: 3 }),
  repeatedId: boolean(),
  childLoop: boolean(),
  parentLoop: constantFrom('seed', 'middle', 'finish'),
});

function stages(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, name: `${prefix} ${index}` }));
}

/** Build charts and write their legacy presentation from the fixture recipe, without a renderer or graph walk. */
function fixture(shape: ReturnType<typeof generate.generate>['value']) {
  const linear = stages('linear', shape.linear);
  const branches = stages('branch', shape.branches);
  const fork = stages('task', shape.fork);
  const leaf = flowChart('Leaf start', noop, 'leaf-start').addFunction('Leaf stop', noop, 'leaf-stop');
  if (shape.childLoop) leaf.loopTo('leaf-start');
  let inner = leaf.build();
  for (let i = 0; i < shape.nesting; i++) {
    inner = flowChart(`Level ${i}`, noop, 'start')
      .addSubFlowChartNext('inner', inner, `Inner box ${i}`)
      .addFunction(`Join ${i}`, noop, 'stop')
      .build();
  }

  const second = shape.repeatedId ? 'mount' : 'another';
  const builder = flowChart('Seed', noop, 'seed');
  for (const { id, name } of linear) builder.addFunction(name, noop, id);
  const decision = builder.addDeciderFunction('Route', () => 'branch-0', 'route');
  for (const { id, name } of branches) decision.addFunctionBranch(id, name, noop);
  const chart = decision
    .end()
    .addListOfFunction(fork.map((stage) => ({ ...stage, fn: noop })))
    .addSubFlowChartNext('mount', inner, 'First mount')
    .addFunction('Middle', noop, 'middle')
    .addSubFlowChartNext(second, inner, 'Second mount')
    .addFunction('Finish', noop, 'finish')
    .loopTo(shape.parentLoop)
    .build();

  const legacy = ['flowchart TD', 'seed["Seed"]'];
  let previous = 'seed';
  for (const { id, name } of linear) {
    const flat = id.replace('-', '_');
    legacy.push(`${previous} --> ${flat}`, `${flat}["${name}"]`);
    previous = flat;
  }
  legacy.push(`${previous} --> route`, 'route["Route"]');
  for (const { id, name } of branches) {
    const flat = id.replace('-', '_');
    legacy.push(`route --> ${flat}`, `${flat}["${name}"]`);
  }
  legacy.push('route --> route_fork', 'route_fork["route-fork"]');
  for (const { id, name } of fork) {
    const flat = id.replace('-', '_');
    legacy.push(`route_fork --> ${flat}`, `${flat}["${name}"]`);
  }
  legacy.push('route_fork --> mount', 'mount["First mount"]', 'mount --> middle', 'middle["Middle"]');
  // The legacy declaration uses one identity per bare ID, so the repeated mount ends its flat walk.
  if (shape.repeatedId) legacy.push('middle --> mount');
  else {
    legacy.push(
      'middle --> another',
      'another["Second mount"]',
      'another --> finish',
      'finish["Finish"]',
      `finish --> ${shape.parentLoop}`,
    );
  }
  return { chart, legacy: legacy.join('\n') };
}

type Placement = readonly string[];
type LocatedNode = readonly [kind: 'stage' | 'mount', placement: Placement];
type LocatedEdge = readonly [from: Placement, to: Placement];

function fromGraph(chart: FlowChart) {
  const nodes: LocatedNode[] = [];
  const edges: LocatedEdge[] = [];

  function scope(root: StageNode, mounts: Placement, prefix: string) {
    const stages = new Set([root]);
    const targets = new Map<string, StageNode>();
    const outgoing = (stage: StageNode) => [...(stage.children ?? []), ...(stage.next ? [stage.next] : [])];
    for (const stage of stages) {
      if (!targets.has(stage.id)) targets.set(stage.id, stage);
      for (const neighbor of outgoing(stage)) if (!neighbor.isLoopRef) stages.add(neighbor);
    }
    const placement = (stage: StageNode): Placement => [...mounts, stage.name.slice(prefix.length)];
    for (const stage of stages) {
      const position = placement(stage);
      if (stage.subflowId) {
        const nested = chart.subflows?.[stage.subflowId];
        if (!nested) throw new Error(`Fixture mount ${stage.subflowId} has no graph`);
        nodes.push(['mount', position]);
        scope(nested.root, position, `${stage.subflowId}/`);
      } else {
        nodes.push(['stage', position]);
      }
      for (const neighbor of outgoing(stage)) {
        const destination = neighbor.isLoopRef ? targets.get(neighbor.id) : neighbor;
        if (!destination) throw new Error(`Fixture loop target ${neighbor.id} is outside its graph`);
        edges.push([position, placement(destination)]);
      }
    }
  }

  scope(chart.root, [], '');
  return { nodes, edges };
}

function fromDiagram(text: string) {
  const [header, ...lines] = text.split('\n');
  expect(header).toBe('flowchart TD');
  const scopes: string[] = [];
  const addresses = new Map<string, Placement>();
  const nodes: LocatedNode[] = [];
  const pendingEdges: [string, string][] = [];
  for (const untrimmed of lines) {
    const line = untrimmed.trim();
    const node = /^(subgraph )?(\w+)\["([^"]+)"\]$/.exec(line);
    const edge = /^(\w+) --> (\w+)$/.exec(line);
    if (node) {
      const [, mount, id, name] = node;
      const position = [...scopes, name];
      expect(addresses.has(id), `duplicate Mermaid id ${id}`).toBe(false);
      addresses.set(id, position);
      nodes.push([mount ? 'mount' : 'stage', position]);
      if (mount) scopes.push(name);
    } else if (edge) {
      pendingEdges.push([edge[1], edge[2]]);
    } else if (line === 'end') {
      expect(scopes.pop(), 'subgraph ended without opening').toBeDefined();
    } else {
      throw new Error(`Unexpected Mermaid line: ${line}`);
    }
  }
  expect(scopes).toEqual([]);
  const address = (id: string): Placement => {
    const position = addresses.get(id);
    if (!position) throw new Error(`Mermaid edge points to undeclared id ${id}`);
    return position;
  };
  const edges = pendingEdges.map(([from, to]): LocatedEdge => [address(from), address(to)]);
  return { nodes, edges };
}

const multiset = (items: readonly unknown[]) => items.map((item) => JSON.stringify(item)).sort();

it('draws every compiled node placement and edge while retaining the legacy drawing bytes', () => {
  assert(
    property(generate, (shape) => {
      const { chart, legacy } = fixture(shape);
      const expected = fromGraph(chart);
      const expanded = fromDiagram(chart.toMermaid({ expandSubflows: true }));
      expect(multiset(expanded.nodes)).toEqual(multiset(expected.nodes));
      expect(multiset(expanded.edges)).toEqual(multiset(expected.edges));
      expect(chart.toMermaid()).toBe(legacy);
    }),
    { numRuns: 100, seed: 228_033 },
  );
});
