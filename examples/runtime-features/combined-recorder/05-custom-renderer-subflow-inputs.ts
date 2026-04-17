/**
 * Combined Recorder — Custom Renderer Applied Across Subflow Inputs
 *
 * Shows that a `NarrativeFormatter` (previously `NarrativeRenderer`) plugged
 * into `enableNarrative({ renderer })` governs the narrative CONSISTENTLY:
 * the same domain-aware `renderOp` hook produces custom text for BOTH
 * ordinary scope writes AND the per-key Input lines inside subflow entry.
 *
 * This was the library's long-standing rendering-consistency bug. Consumers
 * (e.g. agentfootprint) saw beautiful domain-aware lines for scope writes
 * but generic `{hasToolCalls, toolCalls, content}` key-list summaries for
 * subflow inputs — because the subflow-input loop bypassed the renderer.
 * The fix routes subflow per-key inputs through `renderer.renderOp`; this
 * example doubles as a regression guard.
 *
 * Pipeline: Seed (writes `parsedResponse`) → [ExecuteTools: Run] — the
 * subflow's inputMapper passes `parsedResponse` through, so you should see
 * the same domain-aware "Parsed: tool_calls → [calculator({})]" line in
 * BOTH places.
 *
 * Run: npx tsx examples/runtime-features/combined-recorder/05-custom-renderer-subflow-inputs.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import type { NarrativeFormatter, OpRenderContext } from 'footprintjs/recorders';

// ── State shapes ────────────────────────────────────────────────────────────

interface ParsedResponse {
  hasToolCalls: boolean;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  content: string;
}

interface ParentState {
  userMsg: string;
  parsedResponse: ParsedResponse;
  result: string;
}

interface InnerState {
  parsedResponse: ParsedResponse;
  result: string;
}

// ── Domain-aware formatter ──────────────────────────────────────────────────
//
// This is the same shape an agent framework like agentfootprint exposes
// via `createAgentRenderer()`. It produces semantic narrative text for
// well-known keys. The library's contract: this hook must fire for ANY
// place `parsedResponse` becomes visible in the narrative — scope writes
// and subflow inputs alike.

const formatter: NarrativeFormatter = {
  renderOp(ctx: OpRenderContext) {
    if (ctx.key === 'parsedResponse' && ctx.type === 'write') {
      const v = ctx.rawValue as ParsedResponse | undefined;
      if (!v?.toolCalls) return null;
      const signatures = v.toolCalls
        .map((tc) => `${tc.name}(${JSON.stringify(tc.arguments ?? {})})`)
        .join(', ');
      return `Parsed: tool_calls → [${signatures}]`;
    }
    // Other keys: return undefined to fall back to the library's default
    // template ("Input: key = summary"). This is documented on the
    // NarrativeFormatter.renderOp return type.
    return undefined;
  },
};

// ── Subflow that receives parsedResponse via inputMapper ────────────────────

const toolSubflow = flowChart<InnerState>(
  'Run',
  (scope) => {
    scope.result = `ran:${scope.parsedResponse.toolCalls[0]?.name ?? 'none'}`;
  },
  'run',
).build();

// ── Parent chart ────────────────────────────────────────────────────────────

const chart = flowChart<ParentState>(
  'Seed',
  (scope) => {
    scope.userMsg = 'give me the weather';
    // Simulating an LLM response that calls `calculator({})` — the exact
    // failure mode where empty-args tool calls were invisible before the
    // rendering fix.
    scope.parsedResponse = {
      hasToolCalls: true,
      toolCalls: [{ name: 'calculator', arguments: {} }],
      content: '',
    };
  },
  'seed',
)
  .addSubFlowChartNext('sf-exec', toolSubflow, 'ExecuteTools', {
    inputMapper: (parent) => ({ parsedResponse: parent.parsedResponse }),
    outputMapper: (sf) => ({ result: sf.result }),
  })
  .build();

// ── Run + show the narrative ────────────────────────────────────────────────

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative({ renderer: formatter });
  await executor.run();

  console.log('Narrative (custom renderer takes effect everywhere):\n');
  executor.getNarrative().forEach((line) => console.log(`  ${line}`));

  // Regression-guard assertion: the domain-aware line MUST appear at least
  // twice — once for the scope write in Seed, once for the subflow input
  // in ExecuteTools' entry. Before the fix, only the first one appeared.
  const narrative = executor.getNarrative();
  const matches = narrative.filter((line) =>
    line.includes('Parsed: tool_calls → [calculator({})]'),
  );
  if (matches.length < 2) {
    console.error(
      `\nREGRESSION: domain-aware line appeared ${matches.length} time(s); ` +
        `expected >= 2 (one for scope write, one for subflow input). The ` +
        `subflow-input rendering bug has resurfaced.`,
    );
    process.exit(1);
  }
  console.log(
    `\nOK — "Parsed: tool_calls → [calculator({})]" appeared ${matches.length} ` +
      'times, covering both the scope write AND the subflow input path.',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
