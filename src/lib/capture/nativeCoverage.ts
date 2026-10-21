import type { LogAddress } from 'foottrace';

import type { TerminalFailureContext } from '../errors/terminalFailure.js';

export type CaptureChannelStatus = 'captured' | 'disabled' | 'partial' | 'failed' | 'unknown';
/** @internal Limitations inherent in every version-1 observation. */
export const CAPTURE_BASE_LIMITATIONS = Object.freeze([
  'tracked-state-only',
  'final-attempt-views',
  'read-sources-not-collected',
  'child-scopes-not-attested',
  'storage-not-attested',
] as const);

/** @internal One vocabulary for native observation and its stored checkpoint codec. */
export const CAPTURE_LIMITATIONS = Object.freeze([
  ...CAPTURE_BASE_LIMITATIONS,
  'resumed-segment',
  'redacted-export',
  'redaction-active',
  'custom-scope',
  'read-retention-failed',
  'commit-retention-failed',
  'attention-omitted',
  'recorder-snapshot-failed',
  'identity-omitted',
  'execution-broken',
  'modes-unavailable',
  'checkpoint-history-not-included',
] as const);
export type CaptureLimitation = (typeof CAPTURE_LIMITATIONS)[number];

/** A producer acknowledgement, not engine inspection of a recorder's implementation. */
export interface RecorderCaptureAcknowledgement {
  readonly version: 1;
  readonly runId: string;
  readonly control: 'captured' | 'partial' | 'unknown';
}

/** Engine observation of ONE root-log segment. Never a durable or whole-workflow completeness claim. */
export interface NativeCaptureNote {
  readonly version: 1;
  readonly runId: string;
  readonly scope: 'root-log';
  readonly logAddress: LogAddress;
  /** Half-open offsets in this log. A same-executor resume starts at the previous end. */
  readonly commits: { readonly from: number; readonly to: number };
  readonly boundary: {
    readonly status: 'running' | 'completed' | 'paused' | 'failed' | 'cancelled';
    readonly failure?: TerminalFailureContext;
  };
  readonly modes: {
    readonly readTracking: 'full' | 'summary' | 'off' | 'unknown';
    readonly writeTracking: 'full' | 'summary' | 'off' | 'unknown';
    readonly commitValues: 'full' | 'delta' | 'unknown';
    readonly writeProvenance: 'off' | 'reads-prefix' | 'unknown';
  };
  readonly channels: {
    readonly reads: CaptureChannelStatus;
    readonly writes: CaptureChannelStatus;
    readonly attention: CaptureChannelStatus;
    readonly control: CaptureChannelStatus;
    readonly readSources: 'not-collected';
  };
  readonly persistence: 'memory-only';
  readonly limitations: readonly CaptureLimitation[];
}

/** @internal Bounded facts collected at native funnels; no values, key names, recorder discovery or tree walk. */
export class NativeCapture {
  private readonly gaps = new Set<CaptureLimitation>(CAPTURE_BASE_LIMITATIONS);

  private boundary: NativeCaptureNote['boundary'] = { status: 'running' };
  private readonly modes: NativeCaptureNote['modes'];

  constructor(
    readonly runId: string,
    readonly logAddress: LogAddress,
    readonly from: number,
    modes: NativeCaptureNote['modes'],
  ) {
    const retention = (value: unknown) =>
      value === 'full' || value === 'summary' || value === 'off' ? value : 'unknown';
    this.modes = {
      readTracking: retention(modes.readTracking),
      writeTracking: retention(modes.writeTracking),
      commitValues: modes.commitValues === 'full' || modes.commitValues === 'delta' ? modes.commitValues : 'unknown',
      writeProvenance:
        modes.writeProvenance === 'off' || modes.writeProvenance === 'reads-prefix' ? modes.writeProvenance : 'unknown',
    };
    if (Object.values(this.modes).includes('unknown')) this.limit('modes-unavailable');
  }

  limit(gap: CaptureLimitation): void {
    this.gaps.add(gap);
  }

  end(status: NativeCaptureNote['boundary']['status'], failure?: TerminalFailureContext): void {
    if (this.boundary.status !== 'running') return;
    if (failure?.stage && failure.stage.runtimeStageId.length > 1024) {
      this.limit('identity-omitted');
      failure = Object.freeze({ category: failure.category });
    }
    this.boundary = { status, ...(failure && { failure }) };
  }

  snapshot(to: number, control: CaptureChannelStatus = 'unknown', redacted = false): NativeCaptureNote {
    const gaps = new Set(this.gaps);
    if (redacted) gaps.add('redacted-export');
    const failed = gaps.has('commit-retention-failed');
    const custom = gaps.has('custom-scope') || gaps.has('modes-unavailable');
    return Object.freeze({
      version: 1,
      runId: this.runId,
      scope: 'root-log',
      logAddress: Object.freeze({
        logRunId: this.logAddress.logRunId,
        drillPath: Object.freeze([...this.logAddress.drillPath]),
      }),
      commits: Object.freeze({ from: this.from, to }),
      boundary: Object.freeze({ ...this.boundary }),
      modes: Object.freeze({
        readTracking: this.modes.readTracking,
        writeTracking: this.modes.writeTracking,
        commitValues: this.modes.commitValues,
        writeProvenance: this.modes.writeProvenance,
      }),
      channels: Object.freeze({
        reads:
          this.modes.readTracking === 'off'
            ? 'disabled'
            : gaps.has('read-retention-failed')
            ? 'failed'
            : custom
            ? 'unknown'
            : 'captured',
        writes: this.modes.writeTracking === 'off' ? 'disabled' : failed ? 'failed' : custom ? 'unknown' : 'captured',
        attention: failed || gaps.has('attention-omitted') ? 'partial' : custom ? 'unknown' : 'captured',
        control: gaps.has('recorder-snapshot-failed') ? 'failed' : control,
        readSources: 'not-collected',
      }),
      persistence: 'memory-only',
      limitations: Object.freeze([...gaps]),
    });
  }
}

/** Stored/recorder metadata is untrusted. Read data properties only, never getters or arbitrary strings. */
export function copyCaptureAcknowledgement(value: unknown): RecorderCaptureAcknowledgement | undefined {
  try {
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const data = (key: string) => Object.getOwnPropertyDescriptor(value, key)?.value;
    const version = data('version');
    const runId = data('runId');
    const control = data('control');
    if (
      version !== 1 ||
      typeof runId !== 'string' ||
      runId.length === 0 ||
      runId.length > 2048 ||
      !['captured', 'partial', 'unknown'].includes(control)
    )
      return undefined;
    return Object.freeze({ version, runId, control });
  } catch {
    return undefined;
  }
}
