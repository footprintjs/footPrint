import { equal, refuse } from '../../../readLawWitness.js';
import type { Bound, Op } from './types.js';
import { literal, objectId, objectKind, supported } from './values.js';

/** Shared prior branch preconditions, extracted before declared projection dispatch. */
export function validateCalls(op: Op, bound: Bound): void {
  const { branch: receipt, read } = bound;
  if (
    !objectId(read.id) ||
    !objectId(read.frame) ||
    receipt.operation.nativeId !== read.id ||
    receipt.operation.frame !== read.frame ||
    receipt.calls[0] !== read ||
    read.method !== 'getValue' ||
    read.outcome !== 'returned' ||
    !read.result ||
    receipt.path.length !== 0
  )
    return refuse('missing exact joined native CHART read');
  supported(read.result);
  const ids = new Set<number>();
  for (const call of receipt.calls) {
    if (
      !objectId(call.id) ||
      ids.has(call.id) ||
      call.frame !== read.frame ||
      call.outcome !== 'returned' ||
      !equal(call.operation, receipt.operation.coordinate) ||
      call.call.objects.length !== call.call.args.length
    )
      return refuse('missing or mismatched actual native call identity');
    ids.add(call.id);
    for (const [i, value] of call.call.args.entries()) {
      supported(value);
      if (objectKind(value) ? !objectId(call.call.objects[i]) : call.call.objects[i] !== undefined)
        return refuse('argument object identity is missing or inconsistent');
    }
  }
  if (!equal(receipt.calls[0].call.args, [literal([]), literal(op.k)])) return refuse('wrong actual read arguments');
  if (objectKind(read.result) ? !objectId(read.resultObject) : read.resultObject !== undefined)
    return refuse('returned value object identity missing or inconsistent');
}
