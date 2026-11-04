import type { FlowChart } from '../builder/types.js';
import { type ExecutorResult, defaultLogger } from '../engine/types.js';
import { canonicalRunComponentRoot, declareRunComponentRoot } from '../memory/RunComponent.js';
import { type RunFrame, RunBanks } from '../memory/RunFrame.js';
import type { FlowchartCheckpoint } from '../pause/types.js';
import { type ComponentPort, registerComponentPort } from '../recorder/ComponentRunControl.js';
import { FinalizationBook, reportFinalizationFailures } from '../recorder/FinalizationBook.js';
import { scopeRunFrame } from '../scope/runtime.js';
import { type NativeEntry, NativeRunAdapter } from './NativeRunAdapter.js';
import { RunSlots } from './RunCells.js';
import { type RunAdmission, RunLease } from './RunLease.js';
import type {
  BoundRun,
  OwnedRun,
  PausedContinuation,
  RunEntry,
  RunLifecycle,
  RunLifecycleOptions,
  RunPhase,
  RunSetup,
  RunSlot,
  RunView,
} from './RunLifecycle.js';

type Outcome<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown };

function observe<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}

interface ExecutionView {
  adapter?: NativeRunAdapter;
  frame?: RunFrame;
  settled: boolean;
  phase: RunPhase;
}

interface Admission {
  readonly view: ExecutionView;
  readonly legBanks: RunBanks;
  readonly runtimeBanks: RunBanks;
  readonly componentBanks: RunBanks;
  readonly cancel: AbortController;
  readonly finalizers: FinalizationBook;
  readonly controls: Array<Promise<Outcome<unknown>>>;
  bodyOpen: boolean;
  retired: boolean;
  requested: boolean;
  native?: Promise<Outcome<ExecutorResult>>;
}

interface Pause {
  readonly adapter: NativeRunAdapter;
  readonly checkpoint: FlowchartCheckpoint;
  readonly token: PausedContinuation;
  spent: boolean;
}

/** Owns a logical runner; stages use only their captured native frame and namespace. */
class NativeRunLifecycle implements RunLifecycle {
  private readonly slots = new RunSlots();
  private readonly componentSetup: RunLifecycleOptions['componentSetup'];
  private readonly componentPort: ComponentPort = {
    open: (frame, finalizers) => {
      if (!this.componentSetup) return {};
      this.slots.freeze();
      const write = () => {
        if (frame.retired) throw new TypeError('Native component binding has retired');
      };
      const cells = this.slots.cells(
        (namespace, lifetime) => frame.bank(namespace, lifetime, this.componentRoot),
        () => undefined,
        write,
      );
      return this.componentSetup(
        Object.freeze({
          ...cells,
          origin: frame.componentOrigin,
          entry: frame.componentEntry,
          onFinalize: (callback: Parameters<FinalizationBook['register']>[0]) => {
            write();
            finalizers.register(callback);
          },
        }),
      );
    },
  };

  private componentRoot?: object;
  private readonly lease: RunLease;
  private active?: Admission;
  private latest?: RunView;
  private pause?: Pause;
  private readonly pauses = new WeakMap<object, Pause>();

  constructor(private readonly chart: FlowChart, private readonly options: RunLifecycleOptions) {
    this.lease = new RunLease(options.runnerId);
    this.componentSetup = options.componentSetup;
  }

  slot<T>(lifetime: 'leg' | 'runtime' | 'component'): RunSlot<T> {
    const chartRoot = lifetime === 'component' ? this.chart.root : undefined;
    const root = chartRoot === undefined ? undefined : canonicalRunComponentRoot(chartRoot);
    if (root !== undefined && this.componentRoot !== undefined && root !== this.componentRoot) {
      throw new TypeError('A lifecycle component root cannot change after slot issuance');
    }
    const slot = this.slots.issue<T>(lifetime);
    if (chartRoot !== undefined) {
      this.componentRoot = declareRunComponentRoot(chartRoot);
      registerComponentPort(this.componentRoot, this.slots, this.componentPort);
    }
    return slot;
  }

  forScope(scope: unknown): BoundRun {
    const frame = scopeRunFrame(scope);
    if (!frame) throw new TypeError('Scope has no registered native run binding');
    this.slots.freeze();
    const cells = this.slots.cells(
      (namespace, lifetime) => frame.bank(namespace, lifetime, this.componentRoot),
      () => undefined,
      () => {
        if (frame.retired) throw new TypeError('Native run binding has retired');
      },
    );
    return Object.freeze({
      ...cells,
      get origin() {
        return frame.origin;
      },
      get retired() {
        return frame.retired;
      },
    });
  }

  view(): RunView | undefined {
    return this.active ? this.readView(this.active.view) : this.latest;
  }

  continuation(): PausedContinuation | undefined {
    return this.active ? undefined : this.pause?.token;
  }

  async withRun<T>(body: (run: OwnedRun) => T | Promise<T>): Promise<T> {
    const lease = this.lease.acquire();
    try {
      return await this.admit(body, lease);
    } finally {
      lease.release();
    }
  }

  private async admit<T>(body: (run: OwnedRun) => T | Promise<T>, lease: RunAdmission): Promise<T> {
    this.slots.freeze();
    const state: Admission = {
      view: { settled: false, phase: 'preparing' },
      legBanks: new RunBanks(),
      runtimeBanks: new RunBanks(),
      componentBanks: new RunBanks(),
      cancel: new AbortController(),
      finalizers: new FinalizationBook(),
      controls: [],
      bodyOpen: true,
      retired: false,
      requested: false,
    };
    this.active = state;
    const bankFor = (namespace: object, lifetime: 'leg' | 'runtime' | 'component') =>
      (lifetime === 'leg' ? state.legBanks : lifetime === 'runtime' ? state.runtimeBanks : state.componentBanks).bank(
        namespace,
      );
    const read = () => {
      if (state.retired) throw new TypeError('Owned run has retired');
    };
    const write = () => {
      read();
      if (!state.bodyOpen) throw new TypeError('Owned run body has closed');
    };
    const cells = this.slots.cells(bankFor, read, write);
    const owned: OwnedRun = Object.freeze({
      ...cells,
      get origin() {
        return state.view.frame?.origin;
      },
      execute: (entry: RunEntry, setup?: RunSetup) => {
        write();
        if (state.requested) throw new TypeError('Owned run accepts one execution');
        state.requested = true;
        // Install observation and joining BEFORE any native setup or caller getter.
        let resolveExecution!: (value: ExecutorResult | PromiseLike<ExecutorResult>) => void;
        let rejectExecution!: (reason: unknown) => void;
        const execution = new Promise<ExecutorResult>((resolve, reject) => {
          resolveExecution = resolve;
          rejectExecution = reject;
        });
        state.native = observe(execution);
        try {
          const selected = this.select(entry);
          const adapter = selected.adapter ?? new NativeRunAdapter(this.chart, this.options.executorOptions);
          state.view.adapter = adapter;
          const native = adapter.execute(selected.entry, setup, {
            legBanks: state.legBanks,
            runtimeBanks: state.runtimeBanks,
            componentBanks: state.componentBanks,
            finalizers: state.finalizers,
            signal: state.cancel.signal,
            cleanup: (callback) => {
              state.finalizers.register(callback);
            },
            bindOrigin: (frame) => {
              state.view.frame = frame;
              lease.bindRunId(frame.origin.runId);
              this.pause = undefined;
              this.latest = this.readView(state.view);
            },
            initialize: (callback) => {
              if (!callback) return;
              let open = true;
              const allowed = () => {
                if (!open) throw new TypeError('Run origin initializer has closed');
              };
              const initializerCells = this.slots.cells(bankFor, allowed, allowed);
              let returned: unknown;
              try {
                returned = callback(initializerCells, state.view.frame!.origin);
              } finally {
                open = false;
              }
              if ((typeof returned === 'object' && returned !== null) || typeof returned === 'function') {
                const then = (returned as { then?: unknown }).then;
                if (typeof then === 'function') {
                  // Read `then` once, observe before invoking foreign thenable code, and join it.
                  const control = Promise.resolve().then(
                    () =>
                      new Promise<unknown>((resolve, reject) => {
                        Reflect.apply(then, returned, [resolve, reject]);
                      }),
                  );
                  state.controls.push(observe(control));
                  throw new TypeError('Run onOrigin must be synchronous');
                }
              }
            },
          });
          native
            .then(
              (result) => {
                state.view.phase = 'postprocessing';
                const checkpoint = adapter.checkpoint(state.view.frame);
                if (checkpoint) this.offerPause(adapter, checkpoint);
                resolveExecution(result);
              },
              (error: unknown) => {
                state.view.phase = 'postprocessing';
                rejectExecution(error);
              },
            )
            .catch(rejectExecution);
        } catch (error) {
          rejectExecution(error);
        }
        return execution;
      },
      onFinalize: (cleanup: () => void | Promise<void>) => {
        write();
        if (typeof cleanup !== 'function') throw new TypeError('Run cleanup must be a function');
        state.finalizers.register(cleanup);
      },
      snapshot: (options?: { redact?: boolean }) => {
        read();
        return state.view.adapter?.snapshot(state.view.frame, options);
      },
    });

    let bodyResult: Outcome<T>;
    let nativeResult: Outcome<ExecutorResult> | undefined;
    let firstCleanup: { reason: unknown } | undefined;
    let secondary = 0;
    let cleanupFailures = 0;
    const increment = (count: number) => Math.min(Number.MAX_SAFE_INTEGER, count + 1);
    try {
      try {
        bodyResult = { status: 'fulfilled', value: await body(owned) };
      } catch (reason) {
        bodyResult = { status: 'rejected', reason };
      }
      state.bodyOpen = false;
      if (bodyResult.status === 'rejected' && state.native) state.cancel.abort(bodyResult.reason);
      nativeResult = state.native && (await state.native);
      if (
        bodyResult.status === 'rejected' &&
        nativeResult?.status === 'rejected' &&
        !Object.is(bodyResult.reason, nativeResult.reason)
      )
        secondary = increment(secondary);
      for (const control of state.controls) {
        if ((await control).status === 'rejected') secondary = increment(secondary);
      }
      const end =
        bodyResult.status === 'rejected' || nativeResult?.status === 'rejected'
          ? { kind: 'failed' as const }
          : state.view.adapter?.paused(state.view.frame)
          ? { kind: 'paused' as const }
          : { kind: 'completed' as const };
      const offered = this.pause;
      if (end.kind === 'failed' && offered && offered.adapter === state.view.adapter) {
        offered.spent = true;
        this.pause = undefined;
      }
      const cleanupResult = await state.finalizers.finish(end);
      cleanupFailures = cleanupResult.count;
      firstCleanup = cleanupResult.first;
      reportFinalizationFailures(this.chart.logger ?? defaultLogger, secondary, cleanupFailures);
      if (bodyResult.status === 'rejected') throw bodyResult.reason;
      if (nativeResult?.status === 'rejected') throw nativeResult.reason;
      if (firstCleanup && end.kind !== 'paused') throw firstCleanup.reason;
      return bodyResult.value;
    } finally {
      state.bodyOpen = false;
      state.retired = true;
      state.view.settled = true;
      state.view.phase = 'settled';
      state.controls.length = 0;
      state.native = undefined;
      if (this.active === state) this.active = undefined;
    }
  }

  private select(entry: RunEntry): { adapter?: NativeRunAdapter; entry: NativeEntry } {
    if (!entry || typeof entry !== 'object') throw new TypeError('Run entry is required');
    const kind = entry.kind;
    if (kind === 'run') return { entry: { kind, options: entry.options } };
    if (kind !== 'resume') throw new TypeError('Unknown run entry kind');
    const mode = entry.mode;
    if (mode === 'fresh')
      return {
        entry: { kind, checkpoint: entry.checkpoint, input: entry.input, options: entry.options },
      };
    if (mode !== 'same') throw new TypeError('Unknown native resume mode');
    const token = entry.continuation;
    const pause = token && typeof token === 'object' ? this.pauses.get(token) : undefined;
    if (!pause || this.pause !== pause || pause.spent) throw new TypeError('Invalid or spent paused continuation');
    pause.spent = true;
    this.pause = undefined;
    return {
      adapter: pause.adapter,
      entry: { kind, checkpoint: pause.checkpoint, input: entry.input, options: entry.options },
    };
  }

  private offerPause(adapter: NativeRunAdapter, checkpoint: FlowchartCheckpoint): void {
    const token = Object.freeze({
      checkpoint: () => {
        if (this.pause !== pause || pause.spent) throw new TypeError('Paused continuation has been superseded');
        return structuredClone(checkpoint);
      },
    }) as PausedContinuation;
    const pause: Pause = { adapter, checkpoint, token, spent: false };
    this.pauses.set(token, pause);
    this.pause = pause;
  }

  private readView(state: ExecutionView): RunView {
    return Object.freeze({
      get phase(): RunPhase {
        if (state.settled) return 'settled';
        return state.phase === 'postprocessing'
          ? state.phase
          : state.adapter?.ready(state.frame)
          ? 'executing'
          : 'preparing';
      },
      get origin() {
        return state.frame?.origin;
      },
      snapshot: (options?: { redact?: boolean }) => state.adapter?.snapshot(state.frame, options),
      getNarrativeEntries: () => state.adapter?.narrative(state.frame) ?? [],
      getCommitCount: () => state.adapter?.commits(state.frame) ?? 0,
      isPaused: () => state.adapter?.paused(state.frame) ?? false,
      drainObservers: (options?: { timeoutMs?: number }) =>
        state.adapter?.drain(state.frame, options) ?? Promise.resolve({ done: 0, failed: 0, pending: 0 }),
      liveState: () => state.adapter?.liveState(state.frame),
    });
  }
}

export function createRunLifecycle(chart: FlowChart, options: RunLifecycleOptions): RunLifecycle {
  return new NativeRunLifecycle(chart, options);
}
