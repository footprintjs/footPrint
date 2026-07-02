/**
 * The LLM Triage Tool — `backtrack(variable, element?)` on a plain
 * footprintjs chart. NO agent framework, NO LLM dependency: this example
 * shows the TOOL CONTRACT — a bounded string in, a bounded string out —
 * that any LLM runtime (an agent framework, an MCP server, a chat loop)
 * can mount as-is. The "LLM" here is you, calling it three times the way
 * a model would on a follow-up question.
 *
 * Why bounded strings: an LLM tool must never receive the recursive slice
 * DAG (JSON.stringify on it explodes on diamond shapes) or an unbounded
 * dump. `formatSlice` + `elementProvenance` return small, honest,
 * self-describing text — a lesser model can triage a run without reading
 * the whole trace. That is the token story: structural queries replace
 * context stuffing.
 *
 * Run: npx tsx examples/post-execution/variable-slice/03-llm-triage-tool.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import {
  arrayProvenance,
  elementProvenance,
  formatSlice,
  keysReadFromExecutionTree,
  sliceForKey,
  type StateKey,
} from 'footprintjs/trace';

// ── A small pipeline that produces a suspicious result ────────────────────

interface State {
  rates: number[];
  baseRate?: number;
  riskFactor?: number;
  quote?: number;
  auditLog: string[];
}

const chart = flowChart<State>('LoadRates', async (scope) => {
  scope.rates = [3.1, 3.4, 9.9]; // 9.9 is the bad datum we'll trace
  scope.auditLog = ['rates loaded'];
}, 'load-rates')
  .addFunction('PickBase', async (scope) => {
    scope.baseRate = scope.rates[scope.rates.length - 1]; // picks the bad one
    scope.auditLog.push('base picked');
  }, 'pick-base')
  .addFunction('AssessRisk', async (scope) => {
    scope.riskFactor = 1.2;
    scope.auditLog.push('risk assessed');
  }, 'assess-risk')
  .addFunction('Quote', async (scope) => {
    scope.quote = scope.baseRate! * scope.riskFactor!;
    scope.auditLog.push('quote computed');
  }, 'quote')
  .build();

// ── The tool: ONE function, the whole triage contract ─────────────────────

/**
 * `backtrack(variable, element?)` — what an LLM tool definition wraps.
 * Given a finished executor, answers "why is this variable what it is?"
 * (or "who produced element N of this array?") as one bounded string.
 */
function makeBacktrackTool(executor: FlowChartExecutor) {
  const snapshot = executor.getSnapshot();
  const reads = keysReadFromExecutionTree(snapshot.executionTree);
  return (variable: StateKey, element?: number): string => {
    if (element !== undefined) {
      const birth = elementProvenance(snapshot.commitLog, variable, element);
      if (!birth) {
        const prov = arrayProvenance(snapshot.commitLog, variable);
        return `no element provenance for '${String(variable)}'[${element}]` +
          (prov.missing ? ` — ${prov.missing}` : ` — index out of range (length ${prov.length})`);
      }
      return (
        `'${String(variable)}'[${element}] = ${JSON.stringify(birth.value)} — born at ` +
        `${birth.runtimeStageId} ("${birth.stageName}", verb: ${birth.verb}, attribution: ${birth.basis}). ` +
        `Follow up with backtrack('${String(variable)}') anchored before commit ${birth.commitIdx + 1}.`
      );
    }
    return formatSlice(sliceForKey(snapshot.commitLog, variable, reads));
  };
}

// ── "The LLM" asks three follow-ups ────────────────────────────────────────

(async () => {
  const executor = new FlowChartExecutor(chart, { commitValues: 'delta' });
  await executor.run();
  const backtrack = makeBacktrackTool(executor);

  console.log('Q1: why is `quote` 11.88?\n');
  console.log(backtrack('quote'));
  // SLICE for 'quote' — reads via: execution-tree
  // Quote (quote#3) [wrote: quote]
  //   PickBase (pick-base#1) ← via baseRate [wrote: baseRate]
  //     LoadRates (load-rates#0) ← via rates [wrote: rates]
  //   AssessRisk (assess-risk#2) ← via riskFactor [wrote: riskFactor]

  console.log('\nQ2: the base came from rates — who put 9.9 into rates[2]?\n');
  console.log(backtrack('rates', 2));
  // 'rates'[2] = 9.9 — born at load-rates#0 (verb: set, attribution: whole-value)

  console.log('\nQ3: and a variable nobody wrote?\n');
  console.log(backtrack('discount'));
  // no slice: 'discount' was never written — came from initial state / args / a closure.
})().catch(console.error);
