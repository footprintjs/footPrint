/**
 * Fresh records from immutable2488 were captured twice per encoding. Compare
 * the same untouched fixture under the component implementation. Only the
 * existing named volatile fields/attempt duration text are normalized.
 */
import { expect, it } from 'vitest';

import { runUntaggedFixture } from '../engine/scenario/declared-tags-untagged-fixture.js';
import { withSettledAttemptDurations } from '../engine/scenario/p1a-attempt-evidence.js';
import delta from './fixtures/component-2488.delta.json';
import full from './fixtures/component-2488.full.json';

it.each(['full', 'delta'] as const)('no component cell preserves normalized2488 %s record bytes', async (mode) => {
  const before = JSON.stringify(mode === 'full' ? full : delta, null, 2);
  expect(withSettledAttemptDurations(await runUntaggedFixture(mode))).toBe(before);
});
