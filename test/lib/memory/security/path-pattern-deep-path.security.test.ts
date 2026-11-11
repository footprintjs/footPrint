/**
 * A path-dependent redaction pattern (one that can match a dot, such as
 * `/auth\.token/`) is tested against dotted paths inside a value handed out
 * whole. Pattern matching has a length cap (ReDoS). A path past that cap used
 * to SKIP the pattern, so the value there was served raw with no warning:
 * eight ordinary 30-character keys above `auth.token` were enough.
 *
 *   1. a secret below the cap is masked (unchanged);
 *   2. a secret past the cap is masked too: an untested path is never served raw;
 *   3. the price is stated: an unrelated value past the cap is the placeholder as well;
 *   4. a name-only pattern is decided per key and is not affected by path length;
 *   5. dev mode says so, once per rule.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { disableDevMode, enableDevMode } from '../../../../src/lib/devMode.js';
import { RedactionRule, SCOPE_PLACEHOLDER } from '../../../../src/lib/memory/redaction.js';

const SEGMENT = 'customerOnboardingWorkflowStep'; // 30 characters: every key is far below the cap

/** `leaf` wrapped in `depth` ordinary keys. */
function nested(depth: number, leaf: unknown): unknown {
  let value = leaf;
  for (let i = 0; i < depth; i++) value = { [`${SEGMENT}${i}`]: value };
  return value;
}

const served = (rule: RedactionRule, value: unknown): string => JSON.stringify(rule.retainBoundary({ root: value }));

describe('a path pattern and a path past the pattern length cap', () => {
  afterEach(() => {
    disableDevMode();
    vi.restoreAllMocks();
  });

  it('masks the secret below the cap', () => {
    const rule = new RedactionRule({ patterns: [/auth\.token/] });
    const out = served(rule, nested(2, { auth: { token: 'SECRET' } }));
    expect(out).not.toContain('SECRET');
    expect(out).toContain(SCOPE_PLACEHOLDER);
  });

  it('masks the secret past the cap instead of serving it raw', () => {
    const rule = new RedactionRule({ patterns: [/auth\.token/] });
    const out = served(rule, nested(8, { auth: { token: 'SECRET' } }));
    expect(out).not.toContain('SECRET');
    expect(out).toContain(SCOPE_PLACEHOLDER);
  });

  it('serves an unrelated value past the cap as the placeholder too (the safe side)', () => {
    const rule = new RedactionRule({ patterns: [/auth\.token/] });
    const out = served(rule, nested(9, { note: 'plain text' }));
    expect(out).not.toContain('plain text');
    expect(out).toContain(SCOPE_PLACEHOLDER);
  });

  it('leaves a deep value alone under a name-only pattern, which never reads the path', () => {
    const rule = new RedactionRule({ patterns: [/^token$/] });
    const out = served(rule, nested(9, { note: 'plain text', token: 'SECRET' }));
    expect(out).toContain('plain text');
    expect(out).not.toContain('SECRET');
  });

  it('warns once per rule in dev mode', () => {
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rule = new RedactionRule({ patterns: [/auth\.token/] });
    served(rule, nested(8, { auth: { token: 'SECRET' } }));
    served(rule, nested(9, { auth: { token: 'SECRET' } }));
    const capWarnings = warn.mock.calls.filter(([text]) => String(text).includes('pattern-matching length cap'));
    expect(capWarnings).toHaveLength(1);
    expect(String(capWarnings[0][0])).not.toContain('SECRET');
  });
});
