import { describe, expect, it } from 'vitest';

import type { SubflowMountOptions } from '../../../src/advanced.js';
import type { NativeMappingBinding, PausableHandler, TypedScope } from '../../../src/index.js';
import { createRunLifecycle, flowChart } from '../../../src/index.js';

describe('native lifecycle binding at input and output mapping boundaries', () => {
  for (const redact of [false, true]) {
    it(`mapping callbacks have their parent's captured private runtime binding (redaction ${redact})`, async () => {
      let inputBinding: unknown;
      let outputBinding: unknown;
      const child = flowChart<string, TypedScope<Record<string, unknown>>>(
        'child',
        (scope) => {
          return scope.$getArgs<{ value: string }>().value;
        },
        'child',
      ).build();
      const chart = flowChart<Record<string, unknown>>(
        'seed',
        (scope) => {
          const bound = owner.forScope(scope);
          bound.set(slot, { visits: 0 });
          scope.value = 'parent';
        },
        'seed',
      )
        .addSubFlowChartNext('member', child, 'member', {
          inputMapper: (parent, binding?: unknown) => {
            expect(binding).toBeDefined();
            inputBinding = binding;
            const frame = owner.forScope(binding);
            const value = frame.read(slot);
            expect(value.present).toBe(true);
            if (!value.present) throw new Error('missing private parent value');
            value.value.visits++;
            expect(frame.origin.kind).toBe('stage');
            return { value: parent.value };
          },
          outputMapper: (result, _parent, binding?: unknown) => {
            expect(binding).toBeDefined();
            outputBinding = binding;
            const frame = owner.forScope(binding);
            const value = frame.read(slot);
            expect(value.present).toBe(true);
            if (!value.present) throw new Error('missing private parent value');
            expect(value.value.visits).toBe(1);
            value.value.visits++;
            return { result };
          },
        })
        .addFunction(
          'finish',
          (scope) => {
            const value = owner.forScope(scope).read(slot);
            expect(value.present).toBe(true);
            if (!value.present) throw new Error('missing private parent value');
            expect(value.value.visits).toBe(2);
            return scope.result;
          },
          'finish',
        )
        .build();
      const owner = createRunLifecycle(chart, { runnerId: 'mapping' });
      const slot = owner.slot<{ visits: number }>('runtime');
      await expect(
        owner.withRun((run) =>
          run.execute(
            { kind: 'run' },
            {
              ...(redact && { redaction: { keys: ['value'] } }),
            },
          ),
        ),
      ).resolves.toBe('parent');
      expect(inputBinding).not.toBe(outputBinding);
      expect(owner.forScope(inputBinding).retired).toBe(true);
      expect(owner.forScope(inputBinding).origin.runId).toBe(owner.view()?.origin?.runId);
      expect(() => owner.forScope({ origin: owner.forScope(inputBinding).origin })).toThrow(TypeError);
      expect(() => owner.forScope(inputBinding).set(slot, { visits: 99 })).toThrow(TypeError);
    });
  }
});

describe('independently reachable output mapping binding', () => {
  for (const redact of [false, true]) {
    it(`output callback resolves the parent bank after an awaited child (redaction ${redact})`, async () => {
      let captured: unknown;
      let outputCalls = 0;
      const child = flowChart(
        'child',
        async () => {
          await Promise.resolve();
          return 'child-result';
        },
        'child',
      ).build();
      const chart = flowChart<Record<string, unknown>>(
        'seed',
        (scope) => {
          owner.forScope(scope).set(slot, 'private-parent');
        },
        'seed',
      )
        .addSubFlowChartNext('member', child, 'member', {
          inputMapper: () => ({}),
          outputMapper: (result, _parent, binding?: unknown) => {
            outputCalls++;
            captured = binding;
            if (binding === undefined) return { result: 'missing-binding' };
            const value = owner.forScope(binding).read(slot);
            return { result: value.present ? `${result}:${value.value}` : 'wrong-bank' };
          },
        })
        .addFunction('finish', (scope) => scope.result, 'finish')
        .build();
      const owner = createRunLifecycle(chart, { runnerId: 'output-binding' });
      const slot = owner.slot<string>('runtime');
      const result = await owner.withRun((run) =>
        run.execute(
          { kind: 'run' },
          {
            ...(redact && { redaction: { keys: ['unused'] } }),
          },
        ),
      );
      expect(outputCalls).toBe(1);
      expect(captured).toBeDefined();
      expect(result).toBe('child-result:private-parent');
      expect(owner.forScope(captured).retired).toBe(true);
    });
  }
});

describe('mapper binding composition and retirement', () => {
  it('isolates repeated nested mounts in two parallel regions, two parents and a direct run', async () => {
    type Private = { label: string; visits: number };
    const banks = new Set<Private>();
    const bindings: NativeMappingBinding[] = [];
    const seen: Array<{ label: string; runId: string }> = [];
    const leaf = flowChart(
      'leaf',
      async () => {
        await Promise.resolve();
        return 'ok';
      },
      'leaf',
    ).build();
    const inputMapper = (_parent: unknown, binding?: NativeMappingBinding) => {
      if (!binding) throw new Error('missing input binding');
      bindings.push(binding);
      const bound = owner.forScope(binding);
      const cell = bound.read(slot);
      if (!cell.present) throw new Error('missing parent runtime bank');
      cell.value.visits++;
      banks.add(cell.value);
      seen.push({ label: cell.value.label, runId: bound.origin.runId });
      return {};
    };
    const outputMapper = (_result: unknown, _parent: unknown, binding?: NativeMappingBinding) => {
      if (!binding) return { mapping: 'missing-binding' };
      bindings.push(binding);
      const cell = owner.forScope(binding).read(slot);
      if (!cell.present) return { mapping: 'wrong-bank' };
      cell.value.visits++;
      return { mapping: 'mapped' };
    };
    const middle = flowChart<Record<string, unknown>>(
      'seed',
      (scope) => {
        owner.forScope(scope).set(slot, { label: scope.$getArgs<{ label: string }>().label, visits: 0 });
      },
      'seed',
    )
      .addSubFlowChartNext('first', leaf, 'first', { inputMapper, outputMapper })
      .addSubFlowChartNext('second', leaf, 'second', { inputMapper, outputMapper })
      .addFunction(
        'finish',
        (scope) => {
          const cell = owner.forScope(scope).read(slot);
          if (!cell.present) throw new Error('missing parent bank at finish');
          expect(scope.mapping).toBe('mapped');
          expect(cell.value.visits).toBe(4);
          return cell.value.label;
        },
        'finish',
      )
      .build();
    const owner = createRunLifecycle(middle, { runnerId: 'shared-middle' });
    const slot = owner.slot<Private>('runtime');
    const parent = flowChart<Record<string, unknown>>(
      'seed',
      (scope) => {
        scope.marker = scope.$getArgs<{ prefix: string }>().prefix;
      },
      'seed',
    )
      .addSelectorFunction('both', () => ['left', 'right'], 'both')
      .addSubFlowChartBranch('left', middle, 'left', { inputMapper: (p) => ({ label: `${p.marker}-L` }) })
      .addSubFlowChartBranch('right', middle, 'right', { inputMapper: (p) => ({ label: `${p.marker}-R` }) })
      .end()
      .build();
    const a = createRunLifecycle(parent, { runnerId: 'parent-A' });
    const b = createRunLifecycle(parent, { runnerId: 'parent-B' });
    const results = await Promise.allSettled([
      a.withRun((run) => run.execute({ kind: 'run', options: { input: { prefix: 'A' } } })),
      b.withRun((run) => run.execute({ kind: 'run', options: { input: { prefix: 'B' } } })),
      owner.withRun((run) => run.execute({ kind: 'run', options: { input: { label: 'direct' } } })),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect([...banks].map((cell) => cell.label).sort()).toEqual(['A-L', 'A-R', 'B-L', 'B-R', 'direct']);
    expect([...banks].map((cell) => cell.visits)).toEqual([4, 4, 4, 4, 4]);
    expect(new Set(seen.map((row) => row.runId)).size).toBe(3);
    expect(new Set(bindings).size).toBe(20);
    for (const binding of bindings) {
      expect(Object.isFrozen(binding)).toBe(true);
      expect(binding.origin.kind).toBe('stage');
      expect(binding.origin.runtimeStageId).toBeTruthy();
      expect(owner.forScope(binding).retired).toBe(true);
    }
    for (const prefix of ['A', 'B']) {
      const rows = seen.filter((row) => row.label.startsWith(prefix));
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((row) => row.runId)).size).toBe(1);
    }
  });

  it.each(['same', 'fresh'] as const)('keeps mapper bindings on their captured leg across %s resume', async (mode) => {
    const inputs: NativeMappingBinding[] = [];
    const outputs: NativeMappingBinding[] = [];
    const secret = 'PRIVATE-MAPPER-BANK-298';
    const handler: PausableHandler<TypedScope<Record<string, unknown>>> = {
      execute: async () => ({ question: 'continue?' }),
      resume: async () => undefined,
    };
    const child = flowChart('ask', handler, 'ask').build();
    const chart = flowChart('seed', () => undefined, 'seed')
      .addSubFlowChartNext('child', child, 'child', {
        inputMapper: (_parent, binding) => {
          if (!binding) throw new Error('missing input binding');
          inputs.push(binding);
          owner.forScope(binding).local(slot, () => ({
            secret,
            toJSON() {
              throw new Error('private serialized');
            },
          }));
          return {};
        },
        outputMapper: (_result, _parent, binding) => {
          if (!binding) return { status: 'missing-binding' };
          outputs.push(binding);
          const value = owner.forScope(binding).read(slot);
          return { status: value.present && value.value.secret === secret ? 'mapped' : 'wrong-bank' };
        },
      })
      .build();
    const owner = createRunLifecycle(chart, { runnerId: 'mapper-resume' });
    const slot = owner.slot<{ secret: string; toJSON(): never }>('runtime');
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    const token = owner.continuation()!;
    const checkpoint = token.checkpoint();
    const firstInput = inputs[0];
    const firstId = firstInput.origin.runId;
    expect(JSON.stringify(checkpoint)).not.toContain(secret);
    expect(owner.forScope(firstInput).retired).toBe(true);
    await owner.withRun((run) =>
      run.execute(
        mode === 'same'
          ? { kind: 'resume', mode, continuation: token, input: 'yes' }
          : { kind: 'resume', mode, checkpoint, input: 'yes' },
      ),
    );
    expect(inputs).toHaveLength(2);
    expect(outputs).toHaveLength(1);
    expect(inputs[1].origin.runId).not.toBe(firstId);
    expect(outputs[0].origin.runId).toBe(inputs[1].origin.runId);
    expect(owner.forScope(firstInput).origin.runId).toBe(firstId);
    expect(owner.forScope(firstInput).read(slot).present).toBe(true);
    expect(() => owner.forScope(firstInput).take(slot)).toThrow('retired');
    expect(owner.view()!.snapshot()!.sharedState.status).toBe('mapped');
    expect(JSON.stringify(owner.view()!.snapshot())).not.toContain(secret);
    for (const copy of [{ ...inputs[1] }, structuredClone(inputs[1]), JSON.parse(JSON.stringify(inputs[1]))]) {
      expect(() => owner.forScope(copy)).toThrow(TypeError);
    }
    let probes = 0;
    const proxy = new Proxy(
      {},
      {
        get() {
          probes++;
          throw new Error('must not probe');
        },
      },
    );
    expect(() => owner.forScope(proxy)).toThrow(TypeError);
    expect(probes).toBe(0);
    expect(() => owner.forScope(undefined)).toThrow(TypeError);
  });
});

describe('native mapping data and private binding remain separate', () => {
  for (const shape of ['linear', 'fork', 'lazy', 'decision'] as const) {
    for (const policy of ['none', 'whole', 'field', 'per-call'] as const) {
      it(`${shape} mappings preserve data taint with ${policy} redaction`, async () => {
        const secret = 'MAPPED-DATA-SECRET-298';
        const privateSecret = 'PRIVATE-CELL-SECRET-931';
        const bindings: NativeMappingBinding[] = [];
        const child = flowChart<Record<string, unknown>, TypedScope<Record<string, unknown>>>(
          'child',
          async (scope) => {
            await Promise.resolve();
            return { copied: scope.$getArgs<{ copied: { secret: string; visible: string } }>().copied };
          },
          'child',
        ).build();
        const options: SubflowMountOptions = {
          inputMapper: (parent, binding) => {
            if (!binding) throw new Error('missing input binding');
            bindings.push(binding);
            const cell = owner.forScope(binding).read(slot);
            if (!cell.present || cell.value !== privateSecret) throw new Error('wrong input parent bank');
            return { copied: parent.payload };
          },
          outputMapper: (output, _parent, binding) => {
            if (!binding) return { mapped: null, correctBank: false };
            bindings.push(binding);
            const cell = owner.forScope(binding).read(slot);
            return { mapped: output.copied, correctBank: cell.present && cell.value === privateSecret };
          },
        };
        let builder = flowChart<Record<string, unknown>>(
          'seed',
          (scope) => {
            owner.forScope(scope).set(slot, privateSecret);
            scope.$setValue('payload', { secret, visible: 'public' }, policy === 'per-call');
          },
          'seed',
        );
        if (shape === 'linear') builder = builder.addSubFlowChartNext('member', child, 'member', options);
        else if (shape === 'fork') builder = builder.addSubFlowChart('member', child, 'member', options);
        else if (shape === 'lazy') builder = builder.addLazySubFlowChart('member', () => child, 'member', options);
        else
          builder = builder
            .addDeciderFunction('route', () => 'member', 'route')
            .addSubFlowChartBranch('member', child, 'member', options)
            .end();
        const chart = builder
          .addFunction(
            'finish',
            (scope) => {
              expect(scope.correctBank).toBe(true);
              expect(scope.$getValue('mapped')).toEqual({ secret, visible: 'public' });
            },
            'finish',
          )
          .build();
        const owner = createRunLifecycle(chart, { runnerId: `mapping-${shape}-${policy}` });
        const slot = owner.slot<string>('runtime');
        await owner.withRun((run) =>
          run.execute(
            { kind: 'run' },
            {
              narrative: {},
              ...(policy === 'whole'
                ? { redaction: { keys: ['payload'] } }
                : policy === 'field'
                ? { redaction: { fields: { payload: ['secret'] } } }
                : policy === 'per-call'
                ? { redaction: {} }
                : {}),
            },
          ),
        );
        expect(bindings).toHaveLength(2);
        expect(bindings[0]).not.toBe(bindings[1]);
        for (const binding of bindings) {
          expect(Object.isFrozen(binding)).toBe(true);
          expect(owner.forScope(binding).read(slot)).toEqual({ present: true, value: privateSecret });
        }
        const retained = JSON.stringify([
          owner.view()!.snapshot({ redact: true }),
          owner.view()!.getNarrativeEntries(),
        ]);
        expect(retained).not.toContain(privateSecret);
        if (policy !== 'none') expect(retained).not.toContain(secret);
      });
    }
  }
});

describe('mapper binding registration contract', () => {
  it('resolves exactly the captured parent bank through both callback identities', async () => {
    const seen: NativeMappingBinding[] = [];
    const child = flowChart('child', () => undefined, 'child').build();
    const chart = flowChart(
      'seed',
      (scope) => {
        owner.forScope(scope).set(slot, 'parent-private');
      },
      'seed',
    )
      .addSubFlowChartNext('child', child, 'child', {
        inputMapper: (_parent, binding) => {
          if (binding) seen.push(binding);
          return {};
        },
        outputMapper: (_result, _parent, binding) => {
          if (binding) seen.push(binding);
          return {};
        },
      })
      .build();
    const owner = createRunLifecycle(chart, { runnerId: 'registration' });
    const slot = owner.slot<string>('runtime');
    await owner.withRun((run) => run.execute({ kind: 'run' }));
    expect(seen).toHaveLength(2);
    for (const binding of seen) {
      // Registration refusal is the property under test, not a setup failure.
      expect(() => owner.forScope(binding)).not.toThrow(TypeError);
      expect(owner.forScope(binding).read(slot)).toEqual({ present: true, value: 'parent-private' });
      expect(owner.forScope(binding).origin).toBe(binding.origin);
      expect(Object.isFrozen(binding)).toBe(true);
    }
  });
});
