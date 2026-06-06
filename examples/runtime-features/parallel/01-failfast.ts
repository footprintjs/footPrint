/**
 * Parallel Fan-Out — failFast vs. best-effort error semantics
 *
 * When a selector picks ≥2 branches they run IN PARALLEL. One branch throwing
 * has two possible meanings, and footprintjs lets you pick:
 *
 *   - DEFAULT (best-effort, `Promise.allSettled`): the error is collected, NOT
 *     rethrown. Every sibling still finishes; the run RESOLVES and continues
 *     past the fan-out. Good when partial success is acceptable.
 *
 *   - `failFast: true` (`Promise.all`): the first error REJECTS the whole run.
 *     Good when every selected branch is REQUIRED.
 *
 * ## Why this matters
 *
 * This is the exact shape of an LLM request assembly: three REQUIRED slots —
 * system-prompt, messages, tools — fan out in parallel, then converge at a
 * `messageAPI` stage that assembles them into one request. If the tools slot
 * throws and you're on the DEFAULT mode, the error is SILENTLY SWALLOWED: the
 * run resolves "successfully" with a half-built request. `failFast: true` makes
 * that failure surface as a rejection so the caller can react.
 *
 * ## What you'll see
 *
 * Fan-out: Pick ─┬─ System Prompt (ok)
 *                ├─ Messages (ok)
 *                └─ Tools (THROWS) ──┐
 *                                    ▼
 *                                 messageAPI (assemble)
 *
 * Run 1 (DEFAULT): resolves; messageAPI still runs → the swallowed-error footgun.
 * Run 2 (failFast): rejects with the tools slot's error → correct for required slots.
 *
 * Run: npx tsx examples/runtime-features/parallel/01-failfast.ts
 */

import { flowChart, flowChartSelector, select, FlowChartExecutor } from 'footprintjs';

// ── Slot subflows (the parallel branches) ───────────────────────────────────

const systemPromptSlot = () =>
  flowChart('BuildSystemPrompt', (scope: any) => { scope.systemPrompt = 'You are a helpful assistant.'; }, 'build-system-prompt').build();

const messagesSlot = () =>
  flowChart('BuildMessages', (scope: any) => { scope.messages = ['hi']; }, 'build-messages').build();

// The tools slot fails — e.g. a tool provider rejects while listing tools.
const failingToolsSlot = () =>
  flowChart('BuildTools', () => { throw new Error('tool provider unavailable'); }, 'build-tools').build();

// ── Chart factory: three REQUIRED slots fan out, then converge at messageAPI ─

function requestAssembly(failFast?: boolean) {
  return flowChartSelector(
    'Pick',
    (scope: any) =>
      select(scope, [
        { when: () => true, then: 'sf-system-prompt', label: 'system prompt' },
        { when: () => true, then: 'sf-messages', label: 'messages' },
        { when: () => true, then: 'sf-tools', label: 'tools' },
      ]),
    'pick',
    failFast !== undefined ? { failFast } : undefined,
  )
    .addSubFlowChartBranch('sf-system-prompt', systemPromptSlot(), 'System Prompt')
    .addSubFlowChartBranch('sf-messages', messagesSlot(), 'Messages')
    .addSubFlowChartBranch('sf-tools', failingToolsSlot(), 'Tools')
    .end()
    .addFunction('messageAPI', (scope: any) => { scope.assembled = true; }, 'message-api', 'assemble the request')
    .build();
}

// ── Run + verify ────────────────────────────────────────────────────────────

(async () => {
  // Run 1 — DEFAULT (best-effort): the tools error is swallowed.
  const bestEffort = new FlowChartExecutor(requestAssembly());
  let bestEffortRejected = false;
  await bestEffort.run({ input: {} }).catch(() => { bestEffortRejected = true; });
  const bestEffortState = bestEffort.getSnapshot()?.sharedState as { assembled?: boolean };

  console.log('Run 1 — DEFAULT (best-effort):');
  console.log('  run rejected?      ', bestEffortRejected);     // false — error swallowed
  console.log('  messageAPI ran?    ', bestEffortState.assembled === true); // true — half-built request

  // Run 2 — failFast: the tools error rejects the whole run.
  const strict = new FlowChartExecutor(requestAssembly(true));
  let strictError: string | undefined;
  await strict.run({ input: {} }).catch((e: unknown) => { strictError = (e as Error).message; });
  const strictState = strict.getSnapshot()?.sharedState as { assembled?: boolean };

  console.log('\nRun 2 — failFast: true:');
  console.log('  run rejected?      ', strictError !== undefined);          // true — error surfaced
  console.log('  reject message:    ', strictError);
  console.log('  messageAPI ran?    ', strictState.assembled === true);     // false — aborted before convergence

  // ── Regression guards — fail the example if the semantics break ──
  if (bestEffortRejected) {
    console.error('\nREGRESSION: DEFAULT mode rejected. Best-effort fan-out must resolve even when a branch throws.');
    process.exit(1);
  }
  if (bestEffortState.assembled !== true) {
    console.error('\nREGRESSION: DEFAULT mode did not converge. Best-effort fan-out must continue past a swallowed error.');
    process.exit(1);
  }
  if (strictError === undefined) {
    console.error('\nREGRESSION: failFast:true did NOT reject. A required branch error must abort the whole run.');
    process.exit(1);
  }
  if (!strictError.includes('tool provider unavailable')) {
    console.error(`\nREGRESSION: failFast:true rejected with the wrong error ("${strictError}"). The branch error must propagate intact.`);
    process.exit(1);
  }
  if (strictState.assembled === true) {
    console.error('\nREGRESSION: failFast:true ran messageAPI. The convergence stage must NOT run after an aborting fan-out.');
    process.exit(1);
  }

  console.log('\n✓ All parallel fan-out error semantics verified.');
})();
