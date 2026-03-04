import { BaseState } from '../../../../src/scope/BaseState';
import { toScopeFactory } from '../../../../src/scope/providers/resolve';
import type { ScopeFactory, StageContextLike } from '../../../../src/scope/providers/types';

// ---- a minimal StageContext stub that records operations
class FakeStageContext implements StageContextLike {
  public pipelineId = 'pipe-int';
  public store: Record<string, unknown> = {};
  public calls: Array<{ op: string; args: any[] }> = [];

  getValue(path: string[], key?: string) {
    const k = key ? [...path, key].join('.') : path.join('.');
    this.calls.push({ op: 'getValue', args: [path, key] });
    return this.store[k];
  }

  setObject(path: string[], key: string, value: unknown, shouldRedact?: boolean) {
    const k = key ? [...path, key].join('.') : path.join('.');
    this.calls.push({ op: 'setObject', args: [path, key, value, shouldRedact] });
    this.store[k] = value;
  }

  updateObject(path: string[], key: string, value: unknown) {
    const k = key ? [...path, key].join('.') : path.join('.');
    this.calls.push({ op: 'updateObject', args: [path, key, value] });
    const cur = (this.store[k] as any) ?? {};
    this.store[k] = { ...cur, ...(value as object) };
  }

  // optional helpers used by BaseState/compat
  addLog(key: string, val: unknown) {
    this.calls.push({ op: 'addLog', args: [key, val] });
  }

  addError(key: string, val: unknown) {
    this.calls.push({ op: 'addError', args: [key, val] });
  }

  getFromGlobalContext(key: string) {
    this.calls.push({ op: 'getFromGlobalContext', args: [key] });
    return `root:${key}`;
  }

  setRoot(key: string, value: unknown) {
    this.calls.push({ op: 'setRoot', args: [key, value] });
    this.store[`root.${key}`] = value;
  }
}

// ---- a tiny “stage runner” that mirrors the pipeline’s scope creation
function runStage<TScope>(
  scopeInput: ScopeFactory<TScope> | (new (...a: any[]) => TScope),
  stageFn: (s: any) => any,
  ro?: unknown,
) {
  const ctx = new FakeStageContext();
  const scopeFactory = toScopeFactory<TScope>(scopeInput);
  const scope = scopeFactory(ctx, 'StageA', ro);
  const result = stageFn(scope);
  return { ctx, scope, result };
}

describe('integration: stage runner + toScopeFactory', () => {
  test('class input (extends BaseState): stage can read/write via BaseState methods', () => {
    class MyScope extends BaseState {
      constructor(c: any, s: string, ro?: unknown) {
        super(c, s, ro);
      }

      doWork() {
        // write
        this.setObject('prompt', 'hi', true);
        this.updateObject('exec', { t: 123 });
        // read
        return this.getValue('prompt');
      }
    }

    const { ctx, scope } = runStage(MyScope, (s: MyScope) => (s as any).doWork());

    // wrote with redact flag and merged object
    expect(ctx.store['prompt']).toBe('hi');
    expect(ctx.store['exec']).toEqual({ t: 123 });

    // read back
    expect((scope as MyScope).getValue('prompt')).toBe('hi');

    // some trace of calls recorded
    expect(ctx.calls.find((c) => c.op === 'setObject')).toBeTruthy();
    expect(ctx.calls.find((c) => c.op === 'updateObject')).toBeTruthy();
  });

  test('factory input: stage receives whatever the factory returns', () => {
    const factory: ScopeFactory<any> = (c, stage, ro) => ({
      tag: 'custom',
      stage,
      ro,
      setObject: c.setObject.bind(c),
      updateObject: c.updateObject.bind(c),
      getValue: c.getValue.bind(c),
    });

    const { ctx, scope } = runStage(
      factory,
      (s) => {
        s.setObject(['x'], 'y', 5);
        s.updateObject(['m'], 'n', { p: 1 });
        return s.getValue(['x'], 'y');
      },
      { ro: true },
    );

    expect(scope.tag).toBe('custom');
    expect(scope.stage).toBe('StageA');
    expect(scope.ro).toEqual({ ro: true });

    // writes landed
    expect(ctx.store['x.y']).toBe(5);
    expect(ctx.store['m.n']).toEqual({ p: 1 });
  });
});
