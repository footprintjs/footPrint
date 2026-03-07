import { EventLog, SharedMemory, StageContext } from '../../../../src/lib/memory';
import { __clearScopeResolversForTests, toScopeFactory } from '../../../../src/lib/scope/providers';
import { ScopeFacade } from '../../../../src/lib/scope/ScopeFacade';

function makeCtx(runId = 'p1', stageName = 's1') {
  return new StageContext(runId, stageName, new SharedMemory(), '', new EventLog());
}

describe('Scenario: class scope vs factory scope', () => {
  beforeEach(() => __clearScopeResolversForTests());

  it('class-based scope via toScopeFactory', () => {
    class UserScope extends ScopeFacade {
      get name(): string {
        return this.getValue('name') as string;
      }

      set name(v: string) {
        this.setValue('name', v);
      }
    }

    const factory = toScopeFactory(UserScope);
    const ctx = makeCtx();
    const scope = factory(ctx, 'test') as UserScope;

    expect(scope).toBeInstanceOf(UserScope);
    scope.name = 'Alice';
    ctx.commit();
    expect(scope.name).toBe('Alice');
  });

  it('factory-based scope via toScopeFactory', () => {
    const myFactory = (ctx: any, stageName: string) => ({
      name: stageName,
      greet: () => `Hello from ${stageName}`,
    });

    const factory = toScopeFactory(myFactory);
    const scope = factory({} as any, 'myStage') as any;

    expect(scope.name).toBe('myStage');
    expect(scope.greet()).toBe('Hello from myStage');
  });

  it('class scope inherits ScopeFacade methods', () => {
    class MetricsScope extends ScopeFacade {
      recordLatency(ms: number) {
        this.addMetric('latency', ms);
      }
    }

    const factory = toScopeFactory(MetricsScope);
    const ctx = makeCtx();
    const scope = factory(ctx, 'metrics') as MetricsScope;

    scope.recordLatency(42);
    expect(ctx.debug.metricContext).toBeDefined();
  });

  it('class scope with readOnlyValues', () => {
    class ConfigScope extends ScopeFacade {
      get apiKey(): string {
        return (this.getReadOnlyValues() as any)?.apiKey;
      }
    }

    const ctx = makeCtx();
    const scope = new ConfigScope(ctx, 'config', { apiKey: 'secret123' });
    expect(scope.apiKey).toBe('secret123');
  });

  it('multiple class scopes share same SharedMemory via StageContext', () => {
    const mem = new SharedMemory();
    const log = new EventLog();
    const ctx1 = new StageContext('p1', 's1', mem, '', log);
    const ctx2 = new StageContext('p1', 's2', mem, '', log);

    const scope1 = new ScopeFacade(ctx1, 's1');
    const scope2 = new ScopeFacade(ctx2, 's2');

    scope1.setValue('shared', 'from-s1');
    ctx1.commit();

    expect(scope2.getValue('shared')).toBe('from-s1');
  });
});
