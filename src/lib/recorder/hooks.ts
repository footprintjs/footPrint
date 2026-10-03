/**
 * recorder/hooks.ts — the hook registry and the one dispatcher (F6).
 *
 * Every recorder hook name is declared ONCE, here, in `HOOKS`. Everything that used to keep
 * its own hand list derives from it:
 *
 *   - channel routing (`CombinedRecorder · has*RecorderMethods`) asks `hooksOn(channel)` — the
 *     three hand lists it replaced (`RECORDER_EVENT_METHODS`, `FLOW_…`, `EMIT_…`) are gone;
 *   - the deferred tier's taps (`DeferredObserverTier · buildScopeTap / buildFlowTap`) iterate
 *     `hooksOn`;
 *   - `CompositeRecorder`'s fan-out is generated from `HOOK_NAMES` (every hook, every channel).
 *
 * `fire` is the one per-recorder loop: call the hook on each recorder, and hand a throw to the
 * caller's failure policy — never to the caller's caller. The engine keeps its two policies
 * (the scope channel routes a throw to every recorder's `onError`; the flow channel warns in
 * dev mode and moves on); `fire` only guarantees that whatever the policy does, the loop goes
 * on and nothing escapes. Borrowed: C# `MulticastDelegate` (one invocation list), OpenTelemetry
 * `MultiSpanProcessor` (one fan-out, a failing processor never stops the others).
 *
 * ## The compile-time law
 *
 * `HOOKS` is checked against the three recorder interfaces in BOTH directions:
 *
 *   - a hook added to `ScopeRecorder` / `FlowRecorder` / `EmitRecorder` and not to `HOOKS` is a
 *     missing property of the `satisfies` clause — it does not compile;
 *   - a hook added to one interface that `HOOKS` lists on another channel only is a missing
 *     key of that entry's `on` — it does not compile;
 *   - an entry naming a channel whose interface does not declare it is an excess property —
 *     it does not compile.
 *
 * Pinned by test/lib/recorder/hooks.test.ts (the `@ts-expect-error` probes).
 */

import { invokeRecorderHook } from '../capture/invokeHook.js';
import { isDevMode } from '../devMode.js';
import type { FlowRecorder } from '../engine/narrative/types.js';
import type { ScopeRecorder } from '../scope/types.js';
import type { EmitRecorder } from './EmitRecorder.js';

/** Members every recorder interface shares that are NOT events. */
type Lifecycle = 'id' | 'clear' | 'toSnapshot';

/** Hooks of the emit channel (`EmitRecorder`). */
export type EmitHookName = Exclude<keyof EmitRecorder, Lifecycle>;
/** Hooks of the scope (data-flow) channel. `ScopeRecorder` also declares `onEmit` — the emit
 *  channel rides the scope list — so it is subtracted here and counted on `emit`. */
export type ScopeHookName = Exclude<keyof ScopeRecorder, Lifecycle | EmitHookName>;
/** Hooks of the flow (control-flow) channel. */
export type FlowHookName = Exclude<keyof FlowRecorder, Lifecycle>;
/** Every recorder hook, on any channel. */
export type HookName = ScopeHookName | FlowHookName | EmitHookName;
/** The three runtime channels (the build-time structure channel fires its hooks by name). */
export type HookChannel = 'scope' | 'flow' | 'emit';

/** The channels whose interface DECLARES hook `K` — what an entry's `on` must name exactly. */
export type ChannelsOf<K extends HookName> =
  | (K extends ScopeHookName ? 'scope' : never)
  | (K extends FlowHookName ? 'flow' : never)
  | (K extends EmitHookName ? 'emit' : never);

type PayloadOf<I, K> = K extends keyof I ? (NonNullable<I[K]> extends (event: infer E) => unknown ? E : never) : never;
type ChannelInterface = { scope: ScopeRecorder; flow: FlowRecorder; emit: EmitRecorder };

/** The payload hook `K` receives on channel `C` — read off the channel's interface, never restated. */
export type HookPayload<K extends HookName, C extends ChannelsOf<K> = ChannelsOf<K>> = C extends HookChannel
  ? PayloadOf<ChannelInterface[C], K>
  : never;

/**
 * One registry entry.
 *
 * - `on` — every channel the hook is declared on, each mapped to the NAME of its payload type
 *   (prose for readers; the type itself is `HookPayload<K, C>`, read off the interface).
 * - `executorMade` — a LABEL (read by tests and docs, not by routing): `true` when the executor synthesizes the event itself instead of a
 *   dispatch site in the engine (today only `onResume`, fired by `FlowChartExecutor · resume`).
 *   Such an event goes through `fire` like every other, so a throwing recorder never aborts
 *   the executor call that made it.
 */
export type HookSpec<K extends HookName> = {
  readonly on: { readonly [C in ChannelsOf<K>]: string };
  readonly executorMade: boolean;
};

/**
 * THE registry. Key order is the order every derived list keeps: `hooksOn(channel)` is an
 * order-preserving filter of it, identical to the 9.35.0 hand-written lists it replaced.
 */
export const HOOKS = {
  onRead: { on: { scope: 'ReadEvent' }, executorMade: false },
  onWrite: { on: { scope: 'WriteEvent' }, executorMade: false },
  onCommit: { on: { scope: 'CommitEvent' }, executorMade: false },
  onStageExecuted: { on: { flow: 'FlowStageEvent' }, executorMade: false },
  onNext: { on: { flow: 'FlowNextEvent' }, executorMade: false },
  onDecision: { on: { flow: 'FlowDecisionEvent' }, executorMade: false },
  onFork: { on: { flow: 'FlowForkEvent' }, executorMade: false },
  onSelected: { on: { flow: 'FlowSelectedEvent' }, executorMade: false },
  onSubflowEntry: { on: { flow: 'FlowSubflowEvent' }, executorMade: false },
  onSubflowExit: { on: { flow: 'FlowSubflowEvent' }, executorMade: false },
  onSubflowRegistered: { on: { flow: 'FlowSubflowRegisteredEvent' }, executorMade: false },
  onLoop: { on: { flow: 'FlowLoopEvent' }, executorMade: false },
  onBreak: { on: { flow: 'FlowBreakEvent' }, executorMade: false },
  onError: { on: { scope: 'ErrorEvent', flow: 'FlowErrorEvent' }, executorMade: false },
  onStageStart: { on: { scope: 'StageEvent' }, executorMade: false },
  onStageEnd: { on: { scope: 'StageEvent' }, executorMade: false },
  // Declarative per-stage retry (9.15): fires DURING a stage, once per failed attempt that will be retried.
  onStageRetry: { on: { flow: 'FlowStageRetryEvent' }, executorMade: false },
  // Throttling (9.39.0, R9): a fork child's error the run's `throttlingErrorChecker` classified.
  onThrottled: { on: { flow: 'FlowThrottledEvent' }, executorMade: false },
  onPause: { on: { scope: 'PauseEvent', flow: 'FlowPauseEvent' }, executorMade: false },
  onResume: { on: { scope: 'ResumeEvent', flow: 'FlowResumeEvent' }, executorMade: true },
  // Run boundaries — listed so a recorder whose ONLY hook is one of them still routes to the flow channel.
  onRunStart: { on: { flow: 'FlowRunEvent' }, executorMade: false },
  onRunEnd: { on: { flow: 'FlowRunEvent' }, executorMade: false },
  onRunFailed: { on: { flow: 'FlowRunFailedEvent' }, executorMade: false },
  onEmit: { on: { emit: 'EmitEvent' }, executorMade: false },
} as const satisfies { readonly [K in HookName]: HookSpec<K> };

/** Every hook name, in registry order. */
export const HOOK_NAMES = Object.freeze(Object.keys(HOOKS)) as readonly HookName[];

/** The hooks declared on `channel`, in registry order. */
export function hooksOn(channel: 'scope'): readonly ScopeHookName[];
export function hooksOn(channel: 'flow'): readonly FlowHookName[];
export function hooksOn(channel: 'emit'): readonly EmitHookName[];
export function hooksOn(channel: HookChannel): readonly HookName[];
export function hooksOn(channel: HookChannel): readonly HookName[] {
  return BY_CHANNEL[channel];
}

const declaredOn = (channel: HookChannel) =>
  Object.freeze(HOOK_NAMES.filter((hook) => Object.prototype.hasOwnProperty.call(HOOKS[hook].on, channel)));
/** Computed once at load — routing asks on every attach, the taps on every traverser. */
const BY_CHANNEL: Readonly<Record<HookChannel, readonly HookName[]>> = {
  scope: declaredOn('scope'),
  flow: declaredOn('flow'),
  emit: declaredOn('emit'),
};

/** The scope-channel error operation a failing hook is reported under (`ErrorEvent.operation`). */
export function operationFor(hook: string): 'read' | 'write' | 'commit' {
  if (hook === 'onRead') return 'read';
  if (hook === 'onCommit') return 'commit';
  return 'write';
}

/**
 * Text for anything a recorder threw. `${err}` throws on a null-prototype object (no
 * `toString`) and on a symbol — and a throw inside the isolation would escape it.
 */
export function describeThrown(error: unknown): string {
  try {
    return String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

/** What to do with a recorder's throw. Its own throw is swallowed by `fire`. */
export type HookFailure = (error: unknown, recorder: object, hook: HookName) => void;

/**
 * The flow channel's policy, verbatim since 9.0: warn in dev mode, otherwise say nothing.
 * `source` names the dispatcher in the warning (`FlowRecorderDispatcher`, `FlowChartExecutor`).
 */
export function warnInDevMode(source: string): HookFailure {
  return (error, recorder, hook) => {
    if (!isDevMode()) return;
    const id = (recorder as { id?: unknown }).id;
    // eslint-disable-next-line no-console
    console.warn(`[footprint] ${source}: recorder "${String(id)}" threw in ${hook}: ${describeThrown(error)}`);
  };
}

const SWALLOW: HookFailure = () => undefined;

/**
 * Call `hook` on every recorder that implements it (normal property lookup, `this` bound —
 * `invokeRecorderHook`), in order. A throw goes to `onFailure` and the loop continues; a
 * throw FROM `onFailure` is swallowed. Nothing a recorder does can reach the caller.
 */
export function fire<K extends HookName>(
  recorders: Iterable<object>,
  hook: K,
  event: HookPayload<K>,
  onFailure: HookFailure = SWALLOW,
): void {
  for (const recorder of recorders) {
    try {
      invokeRecorderHook(recorder, hook, event);
    } catch (error) {
      try {
        onFailure(error, recorder, hook);
      } catch {
        // An isolation that throws is itself isolated — recorder errors never reach the run.
      }
    }
  }
}
