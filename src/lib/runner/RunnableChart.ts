/**
 * RunnableChart -- Adds .recorder(), .redact(), .run(), .toOpenAPI(), .toMCPTool()
 * to a FlowChart object.
 *
 * Called by FlowChartBuilder.build() to enrich the compiled chart with
 * d3-style chainable run methods and self-describing outputs.
 */

import type { FlowChart } from '../builder/types.js';
import { normalizeSchema } from '../contract/schema.js';
import type { JsonSchema } from '../contract/types.js';
import type { FlowRecorder } from '../engine/narrative/types.js';
import type { RunOptions } from '../engine/types.js';
import type { Recorder, RedactionPolicy } from '../scope/types.js';
import { type RunResult, RunContext } from './RunContext.js';

/** OpenAPI generation options. */
export interface ChartOpenAPIOptions {
  title?: string;
  version?: string;
  description?: string;
  path?: string;
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
  recorder(r: Recorder | FlowRecorder): RunContext<TOut, TScope>;
  /** Set redaction policy for the next run. Returns a chainable RunContext. */
  redact(policy: RedactionPolicy): RunContext<TOut, TScope>;
  /** Execute the chart directly (bare run, no recorders). */
  run(options?: RunOptions): Promise<RunResult>;
  /** Generate OpenAPI 3.1 spec from chart metadata + contract. Cached for no-options calls. */
  toOpenAPI(options?: ChartOpenAPIOptions): object;
  /** Generate MCP tool description from chart metadata. Cached. */
  toMCPTool(): MCPToolDescription;
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
