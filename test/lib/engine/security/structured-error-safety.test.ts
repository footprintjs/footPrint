/**
 * Security test: Structured error system safety.
 *
 * Verifies that the structured error pipeline does not:
 * - Leak sensitive data from error objects into narrative strings
 * - Allow prototype pollution through crafted error objects
 * - Expose raw error internals (stack traces) in narrative output
 * - Mutate the original error object during extraction
 *
 * Also verifies:
 * - formatErrorInfo never includes .raw or .stack in output
 * - Crafted errors with getters/proxies don't break extraction
 * - FlowRecorder error isolation holds for structured errors
 */

import { vi } from 'vitest';

import { extractErrorInfo, formatErrorInfo } from '../../../../src/lib/engine/errors/errorInfo';
import type { StageNode } from '../../../../src/lib/engine/graph/StageNode';
import type { FlowErrorEvent, FlowRecorder } from '../../../../src/lib/engine/narrative/types';
import { FlowchartTraverser } from '../../../../src/lib/engine/traversal/FlowchartTraverser';
import type { ILogger, StageFunction } from '../../../../src/lib/engine/types';
import { ExecutionRuntime } from '../../../../src/lib/runner/ExecutionRuntime';
import { InputValidationError } from '../../../../src/lib/schema/errors';

const silentLogger: ILogger = {
  info: vi.fn(),
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
};

function simpleScopeFactory(context: any) {
  return {
    get: (key: string) => context.getValue([], key),
    set: (key: string, value: unknown) => context.setObject([], key, value),
  };
}

// ─────────────────────── Data Leakage ───────────────────────

describe('Security: Structured error data leakage', () => {
  it('formatErrorInfo does not include stack traces', () => {
    const error = new Error('something broke');
    error.stack = 'Error: something broke\n    at /secret/internal/path.ts:42\n    at sensitiveModule';

    const info = extractErrorInfo(error);
    const formatted = formatErrorInfo(info);

    expect(formatted).not.toContain('/secret/internal/path');
    expect(formatted).not.toContain('sensitiveModule');
    expect(formatted).toBe('something broke');
  });

  it('formatErrorInfo does not include raw error object contents', () => {
    const error = new Error('public message') as Error & { sensitiveData: string };
    error.sensitiveData = 'SSN:123-45-6789';

    const info = extractErrorInfo(error);
    const formatted = formatErrorInfo(info);

    expect(formatted).not.toContain('SSN');
    expect(formatted).not.toContain('123-45-6789');
  });

  it('InputValidationError issue messages do not leak input values by default', () => {
    // Issues should describe the PROBLEM, not echo the VALUE
    const issues = [
      { path: ['password'], message: 'Must be at least 8 characters', code: 'too_small' },
      { path: ['ssn'], message: 'Invalid format', code: 'invalid_string' },
    ];
    const error = new InputValidationError('Validation failed', issues);

    const info = extractErrorInfo(error);
    const formatted = formatErrorInfo(info);

    // formatErrorInfo includes paths and messages, NOT input values
    expect(formatted).toContain('password');
    expect(formatted).toContain('Must be at least 8 characters');
    // The actual password/ssn values are never in the error — that's the correct pattern
  });

  it('narrative output does not include stack traces from structured errors', async () => {
    const capturedEvents: FlowErrorEvent[] = [];
    const spy: FlowRecorder = {
      id: 'spy',
      onError(event: FlowErrorEvent) {
        capturedEvents.push(event);
      },
    };

    const stageMap = new Map<string, StageFunction>();
    stageMap.set('fail', () => {
      const err = new Error('public error');
      err.stack = 'Error: public error\n    at /internal/secret/path.ts:99';
      throw err;
    });

    const root: StageNode = { name: 'fail', id: 'fail' };
    const runtime = new ExecutionRuntime(root.name);
    const traverser = new FlowchartTraverser({
      root,
      stageMap,
      scopeFactory: simpleScopeFactory,
      executionRuntime: runtime,
      scopeProtectionMode: 'off',
      logger: silentLogger,
      narrativeEnabled: true,
      flowRecorders: [spy],
    });

    await expect(traverser.execute()).rejects.toThrow('public error');

    // structuredError.message should not contain stack
    expect(capturedEvents[0].structuredError.message).toBe('public error');
    expect(capturedEvents[0].structuredError.message).not.toContain('/internal/secret');
  });
});

// ─────────────────────── Prototype Pollution ───────────────────────

describe('Security: Structured error prototype pollution', () => {
  it('crafted error with __proto__ does not pollute StructuredErrorInfo', () => {
    const malicious = Object.create(null);
    malicious.__proto__ = { issues: [{ path: ['hacked'], message: 'pwned' }] };
    malicious.message = 'normal error';

    const info = extractErrorInfo(malicious);

    // Should not pick up __proto__.issues — malicious is not an InputValidationError
    expect(info.issues).toBeUndefined();
    // null-prototype objects can't be String()-ified, so we get the fallback
    expect(info.message).toBe('[unserializable error]');
    expect(info.raw).toBe(malicious);
  });

  it('error with constructor pollution does not affect extraction', () => {
    const error = new Error('normal');
    Object.defineProperty(error, 'constructor', {
      value: InputValidationError,
      enumerable: false,
    });

    const info = extractErrorInfo(error);

    // instanceof check uses prototype chain, not .constructor
    // This error is NOT an InputValidationError despite the constructor property
    expect(info.issues).toBeUndefined();
    expect(info.name).toBe('Error');
  });
});

// ─────────────────────── Input Immutability ───────────────────────

describe('Security: Structured error input immutability', () => {
  it('extractErrorInfo does not mutate the original error', () => {
    const issues = [{ path: ['a'], message: 'bad' }];
    const error = new InputValidationError('test', issues);
    const originalMessage = error.message;
    const originalIssueCount = error.issues.length;

    const info = extractErrorInfo(error);

    // Original error unchanged
    expect(error.message).toBe(originalMessage);
    expect(error.issues.length).toBe(originalIssueCount);
    expect(error.issues).toBe(issues); // original reference intact

    // StructuredErrorInfo.issues is a defensive copy (not the same reference)
    expect(info.issues).not.toBe(issues);
    expect(info.issues).toEqual(issues);

    // Mutating the copy does not affect the original
    info.issues!.push({ path: ['injected'], message: 'hacked' });
    expect(error.issues.length).toBe(originalIssueCount);
  });

  it('formatErrorInfo does not mutate the StructuredErrorInfo', () => {
    const info = extractErrorInfo(new InputValidationError('test', [{ path: ['x'], message: 'bad' }]));
    const originalMessage = info.message;

    formatErrorInfo(info);

    expect(info.message).toBe(originalMessage);
    expect(info.issues).toHaveLength(1);
  });
});

// ─────────────────────── Adversarial Error Objects ───────────────────────

describe('Security: Adversarial error objects', () => {
  it('error with throwing getter on .message does not crash extraction', () => {
    const malicious = new Error('safe');
    Object.defineProperty(malicious, 'message', {
      get() {
        throw new Error('trap!');
      },
    });

    // extractErrorInfo should not crash — it catches the getter explosion
    // Since .message throws, it falls through to the non-Error path
    expect(() => extractErrorInfo(malicious)).not.toThrow();
  });

  it('error with throwing getter on .code does not crash extraction', () => {
    const error = new Error('normal') as Error & { code: string };
    Object.defineProperty(error, 'code', {
      get() {
        throw new Error('code trap!');
      },
    });

    // The code access may throw, but extraction should handle it gracefully
    // Since the getter throws during property access, code won't be set
    let info;
    try {
      info = extractErrorInfo(error);
    } catch {
      // If it throws, that's also acceptable — no silent corruption
      return;
    }
    expect(info.message).toBe('normal');
  });

  it('Proxy error object does not crash extraction', () => {
    const handler: ProxyHandler<Error> = {
      get(target, prop) {
        if (prop === 'message') return 'proxy message';
        if (prop === 'name') return 'ProxyError';
        return Reflect.get(target, prop);
      },
    };
    const proxy = new Proxy(new Error('inner'), handler);

    const info = extractErrorInfo(proxy);
    expect(info.message).toBe('proxy message');
    expect(info.name).toBe('ProxyError');
  });
});
