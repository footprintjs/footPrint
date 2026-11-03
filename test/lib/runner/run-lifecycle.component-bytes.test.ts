/**
 * Real component-absent2488+#142 output, captured twice per encoding.
 * Only existing named volatile fields/duration text are normalized; no adapter.
 */
import { expect, it } from 'vitest';

import { runUntaggedFixture } from '../engine/scenario/declared-tags-untagged-fixture.js';
import { withSettledAttemptDurations } from '../engine/scenario/p1a-attempt-evidence.js';
import delta from './fixtures/component-absent-2488-f2.delta.json';
import full from './fixtures/component-absent-2488-f2.full.json';

it.each(['full', 'delta'] as const)(
  'unused component cells preserve component-absent %s record bytes',
  async (mode) => {
    const before = JSON.stringify(mode === 'full' ? full : delta, null, 2);
    expect(withSettledAttemptDurations(await runUntaggedFixture(mode))).toBe(before);
  },
);
