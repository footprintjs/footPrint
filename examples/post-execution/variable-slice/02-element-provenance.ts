/**
 * Element Provenance — "which stage produced messages[2]?"
 *
 * The agent MEGA-KEY problem: in agent charts everything funnels through one
 * array key (`history`), so a key-level slice degenerates to "everything
 * depends on history". Append-fold provenance answers the real triage
 * question at ELEMENT level — and needs no new capture: under
 * `commitValues: 'delta'` the log already records every append's tail.
 *
 * Chart: Seed → Work → Check ─(again)→ loop back to Work ×3 — the shape of
 * a ReAct loop growing a message array each iteration.
 *
 * Run: npx tsx examples/post-execution/variable-slice/02-element-provenance.ts
 */

import { flowChart, FlowChartExecutor } from 'footprintjs';
import { arrayProvenance, elementProvenance } from 'footprintjs/trace';

interface State { msgs: string[]; round?: number }

const chart = flowChart<State>('Seed', async (scope) => {
  scope.msgs = ['user-question'];
  scope.round = 0;
}, 'seed')
  .addFunction('Work', async (scope) => {
    scope.round = scope.round! + 1;
    scope.msgs.push(`tool-result-${scope.round}`);
  }, 'work')
  .addDeciderFunction('Check', async (scope) => (scope.round! < 3 ? 'again' : 'done'), 'check')
  .addFunctionBranch('again', 'Loop', async () => { /* hop back */ }, undefined, { loopTo: 'work' })
  .addFunctionBranch('done', 'Finish', async () => { /* end */ })
  .setDefault('done')
  .end()
  .build();

(async () => {
  // 'delta' mode records appends as appends → EXACT element attribution.
  const executor = new FlowChartExecutor(chart, { commitValues: 'delta' });
  await executor.run();
  const { commitLog } = executor.getSnapshot();

  const prov = arrayProvenance(commitLog, 'msgs')!;
  console.log(`msgs has ${prov.length} elements — where did each come from?\n`);
  for (const b of prov.births) {
    console.log(`  msgs[${b.index}] = ${JSON.stringify(b.value)}  ← ${b.runtimeStageId} (${b.basis})`);
  }
  // msgs[0] = "user-question"   ← seed#0   (whole-value)
  // msgs[1] = "tool-result-1"   ← work#1   (append-verb)   — iteration 1
  // msgs[2] = "tool-result-2"   ← work#4   (append-verb)   — iteration 2
  // msgs[3] = "tool-result-3"   ← work#7   (append-verb)   — iteration 3

  // The single-element form — the exact call an LLM backtrack tool makes:
  const birth = elementProvenance(commitLog, 'msgs', 2)!;
  console.log(`\nwho produced msgs[2]? → ${birth.runtimeStageId} (verb: ${birth.verb}, ${birth.basis})`);
})().catch(console.error);
