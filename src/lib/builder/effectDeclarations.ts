/** Whole existing retry/effect declaration units, shared by builder cursors. */
import { touchesProblem } from '../attempt/effect.js';
import { retryPolicyProblem } from '../attempt/policy.js';
import type { StageTouches } from '../engine/types.js';
import type { RetryPolicy, SerializedPipelineStructure, StageNode } from './types.js';

const fail = (msg: string): never => {
  throw new Error(`[FlowChartBuilder] ${msg}`);
};

/**
 * Attach a declarative retry policy to a stage node + its spec node.
 *
 * The ONE place a policy lands on a node, shared by the `.retry()` cursor
 * modifier and by every `options.retry` declaration site, so validation and the
 * spec's `retryAttempts` mirror can never drift between them.
 *
 * `attempts` is validated at BUILD time rather than defended at runtime: a
 * typo'd `attempts: 0` should fail while you are writing the chart, not
 * silently turn a stage into a no-op run three months later. `attempts: 1` is
 * accepted on purpose — it means "policy declared, currently off", so a policy
 * can be dialled down without deleting the declaration. The rule is
 * `attempt/policy.ts · retryPolicyProblem`, which the traverser also applies to
 * a StageNode a stage returns at run time.
 */
export function applyRetryPolicy(
  node: StageNode<any, any>,
  spec: SerializedPipelineStructure,
  retry: RetryPolicy | undefined,
  where: string,
): void {
  if (!retry) return;
  const problem = retryPolicyProblem(retry);
  if (problem !== undefined) fail(`${where}: ${problem}`);
  // A touching stage declared first: the policy must not make it retry without a key (P3 — either order refuses).
  if (node.touches) {
    const touching = touchesProblem(node.touches, retry);
    if (touching !== undefined) fail(`${where}: stage '${node.name}' ${touching}`);
  }
  node.retry = retry;
  spec.retryAttempts = retry.attempts;
  // The cap rides the spec beside the count (P5): a JSON-safe fact, so a reader of the spec sees what bounds the stage.
  if (retry.timeoutMs !== undefined) spec.timeoutMs = retry.timeoutMs;
}

/**
 * Attach a side-effect declaration to a stage node + its spec node (10.1, design §3.3) — the twin of
 * {@link applyRetryPolicy}: the ONE place `touches` lands, shared by the `.touches()` cursor modifier and every
 * `options.touches` site.
 *
 * The law is `attempt/effect.ts · touchesProblem`, which the traverser also applies to a StageNode returned at run
 * time and to every stage it runs: `system` a name, the key rule a function, and a stage that may retry must declare
 * the key rule — a retry of an outside effect without one can apply it twice. Checked here against the policy
 * already on the node; `applyRetryPolicy` checks a policy that lands after. The spec carries the system NAME only.
 */
export function applyTouches(
  node: StageNode<any, any>,
  spec: SerializedPipelineStructure,
  touches: StageTouches | undefined,
  where: string,
): void {
  if (touches === undefined) return;
  if (node.touches) fail(`${where}: touches already declared at '${node.name}' (${node.touches.system})`);
  // Each field read ONCE, then checked and frozen: what is checked is exactly what lands (a getter cannot differ).
  const read = (touches !== null && typeof touches === 'object' ? touches : {}) as Partial<StageTouches>;
  const { system, idempotencyKey } = read;
  const copy = { system, ...(idempotencyKey !== undefined && { idempotencyKey }) };
  const problem = touchesProblem(touches === null || typeof touches !== 'object' ? touches : copy, node.retry);
  if (problem !== undefined) fail(`${where}: stage '${node.name}' ${problem}`);
  // The node's copy is frozen and holds only the two named fields: nothing else on the caller's object rides along.
  node.touches = Object.freeze(copy as StageTouches);
  spec.touches = system as string;
}
