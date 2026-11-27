import { expect, it, vi } from 'vitest';

import { readSkippedWriters, skippedWriterCaptureOptions } from '../../../../src/skipped-writers.js';

vi.mock('foottrace/cause', () => ({ evaluateSkippedPaths: 42 }));

it('uses the same gap when the installed skipped-writer capability is not callable', async () => {
  const options = {};
  expect(await skippedWriterCaptureOptions(options)).toBe(options);
  expect(await readSkippedWriters({}, 'target', 0)).toEqual({
    candidates: [],
    gaps: ['not-collected'],
  });
});
