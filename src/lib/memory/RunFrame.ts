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

/** A captured leg/runtime pair. Stage views share its banks, never a mutable runtime lookup. */
export class RunFrame {
  private constructor(private readonly leg: NativeLeg, readonly runtime: RunBanks, readonly origin: NativeRunOrigin) {}

  static open(origin: NativeLegOrigin, legBanks = new RunBanks(), runtimeBanks = new RunBanks()): RunFrame {
    const stamp: NativeLegOrigin = Object.freeze({
      kind: 'leg',
      runId: origin.runId,
      startedAtMs: origin.startedAtMs,
      ...(origin.correlation && { correlation: Object.freeze({ ...origin.correlation }) }),
    });
    return new RunFrame({ origin: stamp, banks: legBanks, active: true }, runtimeBanks, stamp);
  }

  get retired(): boolean {
    return !this.leg.active;
  }

  bank(namespace: object, lifetime: 'leg' | 'runtime'): CellBank {
    return (lifetime === 'leg' ? this.leg.banks : this.runtime).bank(namespace);
  }

  mounted(): RunFrame {
    return new RunFrame(this.leg, new RunBanks(), this.leg.origin);
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
    return new RunFrame(this.leg, this.runtime, origin);
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
