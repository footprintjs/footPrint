/**
 * Addressed pause and resume for a separately executed child.
 * @module footprintjs/child-continuation
 */
export type {
  ChildContinuation,
  ChildContinuationBinding,
  ChildContinuationEntry,
  ChildContinuationInitial,
  ChildContinuationOutcome,
  ChildGate,
} from './lib/runner/childContinuation.js';
export { createChildContinuation } from './lib/runner/childContinuation.js';
