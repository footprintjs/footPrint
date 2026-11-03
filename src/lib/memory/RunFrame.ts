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

/** A native occurrence coordinate only; never application identity or authorization. */
export interface NativeComponentEntry {
  readonly runId: string;
  readonly ordinal: number;
}

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
  nextComponentOrdinal: number;
}

interface NativeComponent {
  readonly root: object | undefined;
  readonly banks: RunBanks;
  readonly entry: NativeComponentEntry;
  readonly origin: NativeRunOrigin;
  active: boolean;
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
      { origin: stamp, banks: legBanks, active: true, nextComponentOrdinal: 1 },
      runtimeBanks,
      {
        root: componentRoot,
        banks: componentBanks,
        active: true,
        origin: stamp,
        entry: Object.freeze({ runId: stamp.runId, ordinal: 0 }),
      },
      stamp,
    );
  }

  get retired(): boolean {
    return !this.leg.active || !this.component.active;
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

  get legKey(): object {
    return this.leg.banks;
  }

  get componentKey(): object {
    return this.component.banks;
  }

  get componentRoot(): object | undefined {
    return this.component.root;
  }

  get componentEntry(): NativeComponentEntry {
    return this.component.entry;
  }

  get componentOrigin(): NativeRunOrigin {
    return this.component.origin;
  }

  mounted(componentRoot?: object, origin: NativeRunOrigin = this.leg.origin): RunFrame {
    if (this.retired) throw new TypeError('Native component parent binding has retired');
    let component = this.component;
    if (componentRoot !== undefined) {
      const ordinal = this.leg.nextComponentOrdinal;
      if (!Number.isSafeInteger(ordinal) || ordinal >= Number.MAX_SAFE_INTEGER) {
        throw new TypeError('Native component entry ordinal is exhausted');
      }
      this.leg.nextComponentOrdinal = ordinal + 1;
      component = {
        root: componentRoot,
        banks: new RunBanks(),
        active: true,
        origin,
        entry: Object.freeze({ runId: this.leg.origin.runId, ordinal }),
      };
    }
    return new RunFrame(this.leg, new RunBanks(), component, this.leg.origin);
  }

  retireComponent(): void {
    this.component.active = false;
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
