import { touchesProblem } from '../../../attempt/effect.js';
import type { StageNode } from '../../types.js';

/** A touching node's refusal at the run-time door, or `undefined` when the law admits it. */
export function touchesRefusal(node: StageNode<any, any>): string | undefined {
  const problem = touchesProblem(node.touches, node.retry);
  return problem === undefined ? undefined : `stage '${node.id}': ${problem}`;
}
