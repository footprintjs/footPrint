import { describe, expect, it } from 'vitest';

import { assertExactDomainCount } from './sampleCounts.js';
describe('fixed-seed oracle-domain census controls — inert counts', () => {
  it('accepts exactly the observed pinned count', () => expect(() => assertExactDomainCount(4, 1, 1)).not.toThrow());
  it('refuses an always-true predicate count beside a narrower measured pin', () =>
    expect(() => assertExactDomainCount(4, 4, 1)).toThrow('count differs'));
  it('refuses silent growth and stale exclusions in either direction', () => {
    expect(() => assertExactDomainCount(4, 2, 1)).toThrow();
    expect(() => assertExactDomainCount(4, 0, 1)).toThrow();
  });
  it.each([-1, 5, 1.5, NaN])('refuses invalid count %s', (count) =>
    expect(() => assertExactDomainCount(4, count, 1)).toThrow(),
  );
});
