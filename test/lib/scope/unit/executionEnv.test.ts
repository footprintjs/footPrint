import type { ExecutionEnv } from '../../../../src/lib/engine/types';
import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

function makeCtx(runId = 'p1', stageName = 's1') {
  const mem = new SharedMemory();
  const log = new EventLog();
  return new StageContext(runId, stageName, mem, '', log);
}

describe('ScopeFacade.getEnv()', () => {
  it('returns empty frozen object when no env provided', () => {
    const scope = new ScopeFacade(makeCtx(), 'test');
    const env = scope.getEnv();
    expect(env).toEqual({});
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('returns frozen env with signal', () => {
    const controller = new AbortController();
    const env: ExecutionEnv = { signal: controller.signal };
    const scope = new ScopeFacade(makeCtx(), 'test', undefined, env);
    const result = scope.getEnv();
    expect(result.signal).toBe(controller.signal);
    expect(result.signal!.aborted).toBe(false);
  });

  it('returns frozen env with timeoutMs', () => {
    const scope = new ScopeFacade(makeCtx(), 'test', undefined, { timeoutMs: 5000 });
    expect(scope.getEnv().timeoutMs).toBe(5000);
  });

  it('returns frozen env with traceId', () => {
    const scope = new ScopeFacade(makeCtx(), 'test', undefined, { traceId: 'abc-123' });
    expect(scope.getEnv().traceId).toBe('abc-123');
  });

  it('returns all three values together', () => {
    const controller = new AbortController();
    const env: ExecutionEnv = {
      signal: controller.signal,
      timeoutMs: 3000,
      traceId: 'trace-xyz',
    };
    const scope = new ScopeFacade(makeCtx(), 'test', undefined, env);
    const result = scope.getEnv();
    expect(result.signal).toBe(controller.signal);
    expect(result.timeoutMs).toBe(3000);
    expect(result.traceId).toBe('trace-xyz');
  });

  it('env is frozen — mutation throws', () => {
    const scope = new ScopeFacade(makeCtx(), 'test', undefined, { traceId: 'abc' });
    const env = scope.getEnv();
    expect(() => {
      (env as any).traceId = 'mutated';
    }).toThrow();
  });

  it('env is independent from args', () => {
    const args = { message: 'hello' };
    const env: ExecutionEnv = { traceId: 'trace-1' };
    const scope = new ScopeFacade(makeCtx(), 'test', args, env);

    expect(scope.getArgs<any>().message).toBe('hello');
    expect(scope.getEnv().traceId).toBe('trace-1');

    // Args don't contain env values
    expect((scope.getArgs<any>() as any).traceId).toBeUndefined();
  });

  it('returns same reference on repeated calls', () => {
    const scope = new ScopeFacade(makeCtx(), 'test', undefined, { traceId: 'x' });
    expect(scope.getEnv()).toBe(scope.getEnv());
  });
});
