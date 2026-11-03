import type { RunCorrelation } from '../attempt/types.js';

export interface NativeLegOrigin {
  readonly kind: 'leg';
  readonly runId: string;
  readonly startedAtMs: number;
  readonly correlation?: RunCorrelation;
}

export interface NativeStageOrigin extends Omit<NativeLegOrigin, 'kind'> {
  readonly kind: 'stage';
  readonly runtimeStageId: string;
  readonly subflowPath?: string;
  readonly parentRuntimeStageId?: string;
}

export type NativeRunOrigin = NativeLegOrigin | NativeStageOrigin;

/** Opaque captured parent-runtime identity supplied separately to native mapper callbacks. */
export interface NativeMappingBinding {
  readonly origin: NativeStageOrigin;
}
export type CellBank = Map<object, unknown>;

/** Private data only: never calls application code or enters state, env or a record. */
export class RunBanks {
  private readonly namespaces = new Map<object, CellBank>();

  bank(namespace: object): CellBank {
    let cells = this.namespaces.get(namespace);
    if (!cells) {
      cells = new Map();
      this.namespaces.set(namespace, cells);
    }
    return cells;
  }
}

interface NativeLeg {
  readonly origin: NativeLegOrigin;
  readonly banks: RunBanks;
  active: boolean;
}

interface NativeComponent {
  readonly root: object | undefined;
  readonly banks: RunBanks;
}

/** Captured leg/runtime/component banks. Stage views never follow a mutable lookup. */
export class RunFrame {
  private constructor(
    private readonly leg: NativeLeg,
    readonly runtime: RunBanks,
    private readonly component: NativeComponent,
    readonly origin: NativeRunOrigin,
  ) {}

  static open(
    origin: NativeLegOrigin,
    legBanks = new RunBanks(),
    runtimeBanks = new RunBanks(),
    componentBanks = new RunBanks(),
    componentRoot?: object,
  ): RunFrame {
    const stamp: NativeLegOrigin = Object.freeze({
      kind: 'leg',
      runId: origin.runId,
      startedAtMs: origin.startedAtMs,
      ...(origin.correlation && { correlation: Object.freeze({ ...origin.correlation }) }),
    });
    return new RunFrame(
      { origin: stamp, banks: legBanks, active: true },
      runtimeBanks,
      { root: componentRoot, banks: componentBanks },
      stamp,
    );
  }

  get retired(): boolean {
    return !this.leg.active;
  }

  bank(namespace: object, lifetime: 'leg' | 'runtime' | 'component', expectedComponentRoot?: object): CellBank {
    if (lifetime === 'component') {
      if (expectedComponentRoot === undefined || this.component.root !== expectedComponentRoot) {
        throw new TypeError('Run slot has no matching captured component boundary');
      }
      return this.component.banks.bank(namespace);
    }
    return (lifetime === 'leg' ? this.leg.banks : this.runtime).bank(namespace);
  }

  mounted(componentRoot?: object): RunFrame {
    const component = componentRoot === undefined ? this.component : { root: componentRoot, banks: new RunBanks() };
    return new RunFrame(this.leg, new RunBanks(), component, this.leg.origin);
  }

  stage(coordinates: {
    readonly runtimeStageId: string;
    readonly subflowPath?: string;
    readonly parentRuntimeStageId?: string;
  }): RunFrame {
    const origin: NativeStageOrigin = Object.freeze({
      ...this.leg.origin,
      kind: 'stage',
      runtimeStageId: coordinates.runtimeStageId,
      ...(coordinates.subflowPath !== undefined && { subflowPath: coordinates.subflowPath }),
      ...(coordinates.parentRuntimeStageId !== undefined && {
        parentRuntimeStageId: coordinates.parentRuntimeStageId,
      }),
    });
    return new RunFrame(this.leg, this.runtime, this.component, origin);
  }

  retire(): void {
    this.leg.active = false;
  }
}

// Native context registration is explicit. Scope registration captures the value once;
// an old scope never follows this map when the native context is reused on resume.
const contextFrames = new WeakMap<object, RunFrame>();

export function bindStageRunFrame(context: object, frame: RunFrame): void {
  contextFrames.set(context, frame);
}

export function stageRunFrameFor(context: object): RunFrame | undefined {
  return contextFrames.get(context);
}

// The carrier holds no state, context or executor. Only its exact weakly registered
// identity resolves a frame; a structural copy of the public origin grants nothing.
const mappingFrames = new WeakMap<object, RunFrame>();

/** @internal Construct only from the mount's frame captured before child execution. */
export function createNativeMappingBinding(frame: RunFrame | undefined): NativeMappingBinding {
  if (!frame || frame.origin.kind !== 'stage') {
    throw new TypeError('[footprint] Native mapper requires a captured parent stage frame');
  }
  const binding: NativeMappingBinding = Object.freeze({ origin: frame.origin });
  mappingFrames.set(binding, frame);
  return binding;
}

/** @internal Identity lookup only: do not inspect or enumerate host values. */
export function nativeMappingFrameFor(value: unknown): RunFrame | undefined {
  return (typeof value === 'object' && value !== null) || typeof value === 'function'
    ? mappingFrames.get(value)
    : undefined;
}
