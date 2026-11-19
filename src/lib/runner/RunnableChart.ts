/**
 * RunnableChart -- Adds .recorder(), .redact(), .run(), .toOpenAPI(), .toMCPTool(),
 * .toMermaid(), .timeBudget() to a FlowChart object.
 *
 * Called by FlowChartBuilder.build() to enrich the compiled chart with
 * d3-style chainable run methods and self-describing outputs.
 */

import { type TimeBudgetOptions, type TimeBudgetReport, timeBudget } from '../budget/index.js';
import type { FlowChart } from '../builder/types.js';
import { normalizeSchema } from '../contract/schema.js';
import type { JsonSchema } from '../contract/types.js';
import type { FlowRecorder } from '../engine/narrative/types.js';
import type { RunOptions, StageNode } from '../engine/types.js';
import type { RedactionPolicy, ScopeRecorder } from '../scope/types.js';
import { type RunResult, RunContext } from './RunContext.js';

/** OpenAPI generation options. */
export interface ChartOpenAPIOptions {
  title?: string;
  version?: string;
  description?: string;
  path?: string;
}

/** Mermaid generation options. */
export interface ChartMermaidOptions {
  /** Draw eagerly mounted subflows as nested subgraphs. Defaults to false. */
  expandSubflows?: boolean;
}

/** MCP tool description — shape required by the Model Context Protocol spec. */
export interface MCPToolDescription {
  name: string;
  description: string;
  /**
   * JSON Schema object describing the tool's input.
   * Always present — the MCP spec requires inputSchema even for tools with no parameters.
   * Defaults to `{ type: 'object', properties: {}, additionalProperties: false }`.
   */
  inputSchema: JsonSchema;
}

/**
 * FlowChart enriched with d3-style run methods and self-describing outputs.
 *
 * Extends builder.FlowChart (which already carries buildTimeStructure, description,
 * stageDescriptions, inputSchema, outputSchema, outputMapper) and adds the runtime
 * methods attached by makeRunnable().
 */
export interface RunnableFlowChart<TOut = any, TScope = any> extends FlowChart<TOut, TScope> {
  /** Attach a recorder for the next run. Returns a chainable RunContext. */
  recorder(r: ScopeRecorder | FlowRecorder): RunContext<TOut, TScope>;
  /** Set redaction policy for the next run. Returns a chainable RunContext. */
  redact(policy: RedactionPolicy): RunContext<TOut, TScope>;
  /** Execute the chart directly (bare run, no recorders). */
  run(options?: RunOptions): Promise<RunResult>;
  /** Generate OpenAPI 3.1 spec from chart metadata + contract. Cached for no-options calls. */
  toOpenAPI(options?: ChartOpenAPIOptions): object;
  /** Generate MCP tool description from chart metadata. Cached. */
  toMCPTool(): MCPToolDescription;
  /** Generate a Mermaid flowchart diagram string from the chart's node graph. */
  toMermaid(options?: ChartMermaidOptions): string;
  /**
   * The slowest this chart can take, from its declared retry policies — `timeBudget(chart, options)`. Checks
   * against the chart's declared `.budget(ms)` unless `options.budgetMs` is given.
   */
  timeBudget(options?: TimeBudgetOptions): TimeBudgetReport;
}

/**
 * Draw the default `flowchart TD` from a chart root. Declare each node once and draw every edge.
 * A loop-reference stub supplies only its back-edge. Labels escape quotes as `#quot;`.
 * IDs use `[A-Za-z0-9_]`; collisions get `_2`, `_3`, and so on in encounter order.
 */
export function chartToMermaid(root: StageNode): string {
  const lines: string[] = ['flowchart TD'];
  const mermaidIds = new Map<string, string>();
  const taken = new Set<string>();
  const idOf = (id: string): string => {
    const known = mermaidIds.get(id);
    if (known !== undefined) return known;
    const base = (id || '').replace(/[^a-zA-Z0-9_]/g, '_') || '_';
    let mermaidId = base;
    for (let n = 2; taken.has(mermaidId); n++) mermaidId = `${base}_${n}`;
    taken.add(mermaidId);
    mermaidIds.set(id, mermaidId);
    return mermaidId;
  };
  const visited = new Set<string>();
  const walk = (n: StageNode): void => {
    if (n.isLoopRef || visited.has(n.id)) return;
    visited.add(n.id);
    const nid = idOf(n.id);
    lines.push(`${nid}["${String(n.name).replace(/"/g, '#quot;')}"]`);
    for (const c of n.children || []) {
      lines.push(`${nid} --> ${idOf(c.id)}`);
      walk(c);
    }
    if (n.next) {
      lines.push(`${nid} --> ${idOf(n.next.id)}`);
      walk(n.next);
    }
  };
  walk(root);
  return lines.join('\n');
}

/** The pinned default bytes require a separate ID scheme for scoped subgraph placements. */
function drawExpandedMermaid(root: StageNode, subflows: FlowChart['subflows']): string {
  const lines = ['flowchart TD'];
  const taken = new Set<string>();
  const allocateId = (stageId: string): string => {
    const base = `fp_${stageId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    return id;
  };
  const labelOf = (name: string): string => name.replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ');

  const draw = (entry: StageNode, indent: string, mountPath = ''): void => {
    // A definition may be mounted twice. Give each expansion its own node identities
    // and resolve its loop targets in that graph, using the first concrete node for an id.
    const ids = new Map<StageNode, string>();
    const firstByStageId = new Map<string, string>();
    const loops: { from: string; target: string }[] = [];

    const walk = (node: StageNode): string => {
      const existing = ids.get(node);
      if (existing !== undefined) return existing;
      const id = allocateId(node.id);
      ids.set(node, id);
      if (!firstByStageId.has(node.id)) firstByStageId.set(node.id, id);

      const name = node.name.startsWith(mountPath) ? node.name.slice(mountPath.length) : node.name;
      const label = labelOf(name);
      const child =
        node.isSubflowRoot && node.subflowId && !node.subflowResolver ? subflows?.[node.subflowId] : undefined;
      if (child) {
        lines.push(`${indent}subgraph ${id}["${label}"]`);
        draw(child.root, `${indent}  `, `${node.subflowId}/`);
        lines.push(`${indent}end`);
      } else {
        const detail = node.isDynamicParallel
          ? ' (parallelForEach branches at run time)'
          : node.subflowResolver
          ? ' (lazy subflow at run time)'
          : node.isSubflowRoot
          ? ' (subflow details unavailable)'
          : '';
        lines.push(`${indent}${id}["${label}${detail}"]`);
      }

      const drawEdge = (target: StageNode): void => {
        if (target.isLoopRef) loops.push({ from: id, target: target.id });
        else lines.push(`${indent}${id} --> ${walk(target)}`);
      };
      for (const child of node.children ?? []) drawEdge(child);
      if (node.next) drawEdge(node.next);
      return id;
    };

    if (!entry.isLoopRef) walk(entry);
    for (const { from, target } of loops) {
      let to = firstByStageId.get(target);
      if (to === undefined) {
        to = allocateId(target);
        firstByStageId.set(target, to);
        lines.push(`${indent}${to}["${labelOf(`Undrawn target ${target}`)}"]`);
      }
      lines.push(`${indent}${from} --> ${to}`);
    }
  };

  draw(root, '');
  return lines.join('\n');
}

// Cache for no-options toOpenAPI() calls only — parameterized calls are not cached
// because different options produce different output.
const openAPICache = new WeakMap<FlowChart, object>();
const mcpCache = new WeakMap<FlowChart, MCPToolDescription>();

/**
 * Enrich a FlowChart with run + describe methods.
 * Called by FlowChartBuilder.build().
 */
export function makeRunnable<TOut, TScope>(chart: FlowChart<TOut, TScope>): RunnableFlowChart<TOut, TScope> {
  const runnable = chart as RunnableFlowChart<TOut, TScope>;

  runnable.recorder = function (r: ScopeRecorder | FlowRecorder): RunContext<TOut, TScope> {
    return new RunContext(chart).recorder(r);
  };

  runnable.redact = function (policy: RedactionPolicy): RunContext<TOut, TScope> {
    return new RunContext(chart).redact(policy);
  };

  runnable.run = function (options?: RunOptions): Promise<RunResult> {
    return new RunContext(chart).run(options);
  };

  runnable.toOpenAPI = function (options?: ChartOpenAPIOptions): object {
    // Only cache no-options calls — parameterized calls vary by options
    if (!options) {
      const cached = openAPICache.get(chart);
      if (cached) return cached;
    }

    const builderChart = chart as any;
    const title = options?.title ?? builderChart.description?.split('\n')[0] ?? 'API';
    const version = options?.version ?? '1.0.0';
    // Use root.id (the explicit machine-readable id) as the path segment, sanitized
    const rawId = builderChart.root?.id ?? 'execute';
    const path = options?.path ?? `/${slugify(rawId)}`;

    const spec: Record<string, unknown> = {
      openapi: '3.1.0',
      info: { title, version, description: options?.description ?? builderChart.description },
      paths: {
        [path]: {
          post: {
            summary: title,
            description: builderChart.description,
            ...(builderChart.inputSchema
              ? {
                  requestBody: {
                    content: { 'application/json': { schema: normalizeSchema(builderChart.inputSchema) } },
                  },
                }
              : {}),
            responses: {
              '200': {
                description: 'Success',
                ...(builderChart.outputSchema
                  ? { content: { 'application/json': { schema: normalizeSchema(builderChart.outputSchema) } } }
                  : {}),
              },
            },
          },
        },
      },
    };

    if (!options) openAPICache.set(chart, spec);
    return spec;
  };

  runnable.toMermaid = function (options?: ChartMermaidOptions): string {
    return options?.expandSubflows ? drawExpandedMermaid(chart.root, chart.subflows) : chartToMermaid(chart.root);
  };

  runnable.timeBudget = function (options?: TimeBudgetOptions): TimeBudgetReport {
    return timeBudget(chart, options);
  };

  runnable.toMCPTool = function (): MCPToolDescription {
    const cached = mcpCache.get(chart);
    if (cached) return cached;

    const builderChart = chart as any;
    // Use root.id (explicit machine-readable id), sanitized to MCP name character allowlist
    const name = sanitizeMCPName(builderChart.root?.id ?? 'execute');
    const description = builderChart.description || `Execute the ${name} flowchart`;

    // MCP spec requires inputSchema to always be present.
    // When no contract is defined, use the recommended no-parameter form.
    const inputSchema: JsonSchema = builderChart.inputSchema
      ? normalizeSchema(builderChart.inputSchema)
      : { type: 'object', properties: {}, additionalProperties: false };

    const tool: MCPToolDescription = { name, description, inputSchema };

    mcpCache.set(chart, tool);
    return tool;
  };

  return runnable;
}

/**
 * Sanitize a string to conform to the MCP tool name character allowlist:
 * [A-Za-z0-9_\-.] — any other character is replaced with underscore.
 * Trims leading/trailing underscores introduced by replacement.
 */
function sanitizeMCPName(id: string): string {
  return id.replace(/[^A-Za-z0-9_\-.]/g, '_').replace(/^_+|_+$/g, '') || 'execute';
}

/**
 * Slugify a string for use as an OpenAPI path segment.
 * Lowercases and replaces non-alphanumeric runs with hyphens.
 */
function slugify(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'execute'
  );
}
