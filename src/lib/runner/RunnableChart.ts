/**
 * RunnableChart -- Adds .recorder(), .redact(), .run(), .toOpenAPI(), .toMCPTool()
 * to a FlowChart object.
 *
 * Called by FlowChartBuilder.build() to enrich the compiled chart with
 * d3-style chainable run methods and self-describing outputs.
 */

import { zodToJsonSchema } from '../contract/schema.js';
import type { FlowRecorder } from '../engine/narrative/types.js';
import type { FlowChart, RunOptions, SerializedPipelineStructure } from '../engine/types.js';
import type { Recorder, RedactionPolicy } from '../scope/types.js';
import { type RunResult, RunContext } from './RunContext.js';

/** OpenAPI generation options. */
export interface ChartOpenAPIOptions {
  title?: string;
  version?: string;
  description?: string;
  path?: string;
}

/** MCP tool description. */
export interface MCPToolDescription {
  name: string;
  description: string;
  inputSchema?: unknown;
}

/** FlowChart with d3-style methods: run, recorder, redact, toOpenAPI, toMCPTool. */
export interface RunnableFlowChart<TOut = any, TScope = any> extends FlowChart<TOut, TScope> {
  // ── Builder metadata (set by FlowChartBuilder.build()) ──────────────────
  /** Always set by build() — narrows the optional field from FlowChart to required. */
  buildTimeStructure: SerializedPipelineStructure;
  /** Human-readable numbered step list. Empty string when no descriptions were provided. */
  description: string;
  /** Per-stage descriptions, keyed by stage name. */
  stageDescriptions: Map<string, string>;
  /** Output schema (Zod or JSON Schema) — declared via .contract(). */
  outputSchema?: unknown;
  /** Output mapper — extracts response from final scope. Declared via .contract(). */
  outputMapper?: (finalScope: Record<string, unknown>) => unknown;
  // ── Runtime methods ──────────────────────────────────────────────────────
  /** Attach a recorder for the next run. Returns a chainable RunContext. */
  recorder(r: Recorder | FlowRecorder): RunContext<TOut, TScope>;
  /** Set redaction policy for the next run. Returns a chainable RunContext. */
  redact(policy: RedactionPolicy): RunContext<TOut, TScope>;
  /** Execute the chart directly (bare run, no recorders). */
  run(options?: RunOptions): Promise<RunResult>;
  /** Generate OpenAPI 3.1 spec from chart metadata + contract. Cached. */
  toOpenAPI(options?: ChartOpenAPIOptions): object;
  /** Generate MCP tool description from chart metadata. Cached. */
  toMCPTool(): MCPToolDescription;
}

// Caches for describe outputs
const openAPICache = new WeakMap<FlowChart, object>();
const mcpCache = new WeakMap<FlowChart, MCPToolDescription>();

/**
 * Enrich a FlowChart with run + describe methods.
 * Called by FlowChartBuilder.build().
 */
export function makeRunnable<TOut, TScope>(chart: FlowChart<TOut, TScope>): RunnableFlowChart<TOut, TScope> {
  const runnable = chart as RunnableFlowChart<TOut, TScope>;

  runnable.recorder = function (r: Recorder | FlowRecorder): RunContext<TOut, TScope> {
    return new RunContext(chart).recorder(r);
  };

  runnable.redact = function (policy: RedactionPolicy): RunContext<TOut, TScope> {
    return new RunContext(chart).redact(policy);
  };

  runnable.run = function (options?: RunOptions): Promise<RunResult> {
    return new RunContext(chart).run(options);
  };

  runnable.toOpenAPI = function (options?: ChartOpenAPIOptions): object {
    const cached = openAPICache.get(chart);
    if (cached) return cached;

    const builderChart = chart as any;
    const title = options?.title ?? builderChart.description?.split('\n')[0] ?? 'API';
    const version = options?.version ?? '1.0.0';
    const path = options?.path ?? `/${(builderChart.root?.name ?? 'execute').toLowerCase().replace(/\s+/g, '-')}`;

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

    openAPICache.set(chart, spec);
    return spec;
  };

  runnable.toMCPTool = function (): MCPToolDescription {
    const cached = mcpCache.get(chart);
    if (cached) return cached;

    const builderChart = chart as any;
    const name = (builderChart.root?.name ?? 'execute').toLowerCase().replace(/\s+/g, '_');
    const description = builderChart.description || `Execute the ${name} flowchart`;

    const tool: MCPToolDescription = {
      name,
      description,
      ...(builderChart.inputSchema ? { inputSchema: normalizeSchema(builderChart.inputSchema) } : {}),
    };

    mcpCache.set(chart, tool);
    return tool;
  };

  return runnable;
}

/** Normalize a Zod schema or plain JSON Schema to JSON Schema object. */
function normalizeSchema(schema: unknown): unknown {
  if (!schema) return schema;
  // If it's a Zod schema with ._def, convert to JSON Schema
  if (
    typeof schema === 'object' &&
    schema !== null &&
    typeof (schema as Record<string, unknown>)._def !== 'undefined'
  ) {
    try {
      return zodToJsonSchema(schema as Record<string, unknown>);
    } catch {
      // If conversion fails (e.g. unsupported Zod type), return as-is
      return schema;
    }
  }
  return schema;
}
