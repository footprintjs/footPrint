import { expect, it } from 'vitest';

import { validateClosureEvidence } from './evidence.js';
import { copyCaptureClosure } from './format.js';

it('refuses absent descriptors without inventing native closure', () => {
  expect(copyCaptureClosure(undefined, {}, {})).toBeUndefined();
});

it('refuses retained invocation totals without matching commit evidence', () => {
  const closure = { commits: { from: 0, to: 1 } };
  const extent = { invocations: { started: 1 } };
  expect(validateClosureEvidence(closure, extent, { runtimeStageId: 'one#0', nativeInvocations: 1 }, [])).toBe(false);
});
