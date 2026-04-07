/**
 * RunnableChart -- Adds .recorder(), .redact(), .run(), .toOpenAPI(), .toMCPTool()
 * to a FlowChart object.
 *
 * Called by FlowChartBuilder.build() to enrich the compiled chart with
 * d3-style chainable run methods and self-describing outputs.
 */
import type { FlowChart } from '../builder/types.js';
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
    /** Generate a Mermaid flowchart diagram string from the chart's node graph. */
    toMermaid(): string;
}
/**
 * Enrich a FlowChart with run + describe methods.
 * Called by FlowChartBuilder.build().
 */
export declare function makeRunnable<TOut, TScope>(chart: FlowChart<TOut, TScope>): RunnableFlowChart<TOut, TScope>;
