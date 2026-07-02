/**
 * The MCP Triage Socket — every footprint backend can ship a socket that
 * ANY MCP client (Claude Code, an IDE agent, a support bot) plugs into and
 * asks "why?".
 *
 * footprintjs already speaks MCP for EXECUTION (`chart.toMCPTool()` — the
 * chart AS a callable tool, `{name, description, inputSchema}`). This example
 * shows the same contract for TRIAGE: three tool descriptions + handlers over
 * a finished run, built purely from `footprintjs/trace` queries. No MCP SDK
 * dependency — the objects below are exactly what you register in any server
 * (`server.tool(name, inputSchema, handler)`); the demo invokes the handlers
 * directly the way a client would.
 *
 * The three tools mirror the triage ladder a model actually climbs:
 *   backtrack("quote")        → the slice (why is it what it is?)
 *   element_birth("rates", 2) → who produced rates[2]?
 *   slice_json("quote")       → the flat graph, for clients that render
 *
 * Run: npx tsx examples/post-execution/variable-slice/04-mcp-triage-socket.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import {
  elementProvenance,
  formatSlice,
  keysReadFromExecutionTree,
  sliceForKey,
  sliceToJSON,
} from 'footprintjs/trace';

// ── The backend under triage (same pipeline as example 03) ────────────────

interface State { rates: number[]; baseRate?: number; riskFactor?: number; quote?: number }

const chart = flowChart<State>('LoadRates', async (scope) => {
  scope.rates = [3.1, 3.4, 9.9];
}, 'load-rates')
  .addFunction('PickBase', async (scope) => {
    scope.baseRate = scope.rates[scope.rates.length - 1];
  }, 'pick-base')
  .addFunction('AssessRisk', async (scope) => {
    scope.riskFactor = 1.2;
  }, 'assess-risk')
  .addFunction('Quote', async (scope) => {
    scope.quote = scope.baseRate! * scope.riskFactor!;
  }, 'quote')
  .build();

// ── The socket: MCP tool descriptions + handlers over one finished run ────

/** The `{name, description, inputSchema}` shape `chart.toMCPTool()` uses. */
interface TriageTool {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>) => string;
}

/**
 * Build the triage socket for a finished executor. Handlers return bounded
 * strings (the MCP text-content convention, and the only LLM-safe slice
 * serialization besides sliceToJSON — never stringify a slice root).
 */
function triageSocket(executor: FlowChartExecutor): TriageTool[] {
  const snapshot = executor.getSnapshot();
  const reads = keysReadFromExecutionTree(snapshot.executionTree);
  return [
    {
      name: 'backtrack',
      description:
        "Backward slice for a state variable: who wrote it, what those writers read, which decisions allowed them. Honest about what the trace cannot see.",
      inputSchema: {
        type: 'object',
        properties: {
          variable: { type: 'string', description: 'the state key to explain' },
          before: { type: 'number', description: 'optional commit index — explain the value as it stood before this point' },
        },
        required: ['variable'],
        additionalProperties: false,
      },
      handler: (args) =>
        formatSlice(
          sliceForKey(snapshot.commitLog, String(args.variable), reads, {
            ...(typeof args.before === 'number' && { before: args.before }),
          }),
        ),
    },
    {
      name: 'element_birth',
      description:
        'For an array-valued variable: which stage execution produced element N (append-fold provenance — exact under delta commit logs).',
      inputSchema: {
        type: 'object',
        properties: {
          variable: { type: 'string' },
          index: { type: 'number' },
        },
        required: ['variable', 'index'],
        additionalProperties: false,
      },
      handler: (args) => {
        const birth = elementProvenance(snapshot.commitLog, String(args.variable), Number(args.index));
        if (!birth) return `no birth record for '${String(args.variable)}'[${Number(args.index)}] — not an array key, never written, or index out of range.`;
        return (
          `'${String(args.variable)}'[${birth.index}] = ${JSON.stringify(birth.value)} — born at ` +
          `${birth.runtimeStageId} ("${birth.stageName}", verb: ${birth.verb}, attribution: ${birth.basis}).`
        );
      },
    },
    {
      name: 'slice_json',
      description:
        'The backward slice as a flat JSON graph (nodes keyed by step id, id-referenced edges) — for clients that render rather than read.',
      inputSchema: {
        type: 'object',
        properties: { variable: { type: 'string' } },
        required: ['variable'],
        additionalProperties: false,
      },
      handler: (args) =>
        JSON.stringify(sliceToJSON(sliceForKey(snapshot.commitLog, String(args.variable), reads)), null, 2),
    },
  ];
}

// ── An MCP client session, simulated ───────────────────────────────────────

(async () => {
  const executor = new FlowChartExecutor(chart, {
    commitValues: 'delta', // exact element attribution
    writeProvenance: 'reads-prefix', // per-write edges: quote's slice won't over-claim
  });
  await executor.run();
  const tools = triageSocket(executor);

  console.log('tools this socket advertises:', tools.map((t) => t.name).join(', '), '\n');

  const call = (name: string, args: Record<string, unknown>) => {
    console.log(`▶ ${name}(${JSON.stringify(args)})`);
    console.log(tools.find((t) => t.name === name)!.handler(args), '\n');
  };

  call('backtrack', { variable: 'quote' });
  call('element_birth', { variable: 'rates', index: 2 });
  call('slice_json', { variable: 'baseRate' });
})().catch(console.error);
