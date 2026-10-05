import { describe, expect, it } from 'vitest';

import * as contract from '../../../../src/lib/contract';

describe('contract module boundary', () => {
  it('owns schema normalization, not a second chart factory or OpenAPI generator', () => {
    expect(Object.keys(contract).sort()).toEqual(['normalizeSchema', 'zodToJsonSchema']);
  });
});
