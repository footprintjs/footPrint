/**
 * Real component-absent2488+#142 output, captured twice per encoding.
 * Only existing named volatile fields/duration text are normalized, and the one named law the capture
 * predates is taken out after it is asserted: the Sub mount's node carries the keys its inputMapper and
 * merge-back read
 * (`../engine/scenario/mapper-reads-law.ts`).
 */
import { expect, it } from 'vitest';

import { runUntaggedFixture, UNTAGGED_MAPPER_READS } from '../engine/scenario/declared-tags-untagged-fixture.js';
import { withoutMapperReadsText } from '../engine/scenario/mapper-reads-law.js';
import { withSettledAttemptDurations } from '../engine/scenario/p1a-attempt-evidence.js';
import delta from './fixtures/component-absent-2488-f2.delta.json';
import full from './fixtures/component-absent-2488-f2.full.json';

it.each(['full', 'delta'] as const)(
  'unused component cells preserve component-absent %s record bytes',
  async (mode) => {
    const before = JSON.stringify(mode === 'full' ? full : delta, null, 2);
    const build = withoutMapperReadsText(await runUntaggedFixture(mode), UNTAGGED_MAPPER_READS);
    expect(withSettledAttemptDurations(build)).toBe(before);
  },
);
