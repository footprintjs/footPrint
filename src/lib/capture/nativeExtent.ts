import type { LogAddress } from 'foottrace';

import {
  type NativeCaptureExtent,
  type NativeCaptureExtentLimitation,
  BASE_LIMITATIONS,
  NATIVE_EXTENT_MAX_INVOCATIONS,
  RUNNING_STATUS,
  TERMINAL_STATUS,
} from './nativeExtentFormat.js';

/** @internal Captures only its own book; no stage, scope, business value or exception is retained. */
export interface NativeInvocationObservation {
  /** Called where an existing native continuation observes settlement. */
  settle(): void;
  abandon(): void;
}

/** @internal One bounded native book per explicitly enabled root leg, never shared into a child runtime. */
export class NativeExtent {
  private started = 0;
  private settled = 0;
  private pending = 0;
  private abandoned = 0;
  private readonly gaps = new Set<NativeCaptureExtentLimitation>(BASE_LIMITATIONS);
  private terminal?: NativeCaptureExtent;

  constructor(private readonly runId: string, private readonly address: LogAddress, private readonly from: number) {}

  limit(gap: NativeCaptureExtentLimitation): void {
    if (!this.terminal) this.gaps.add(gap);
  }

  begin(): NativeInvocationObservation | undefined {
    if (this.terminal) return;
    if (this.started >= NATIVE_EXTENT_MAX_INVOCATIONS) {
      this.limit('counter-saturated');
      return;
    }
    this.started++;
    this.pending++;
    let pending = true;
    let abandoned = false;
    return {
      settle: () => {
        if (!pending) return;
        pending = false;
        if (this.terminal) return;
        this.pending--;
        this.settled++;
      },
      abandon: () => {
        if (!pending || abandoned || this.terminal) return;
        abandoned = true;
        this.abandoned++;
      },
    };
  }

  seal(to: number): void {
    this.terminal ??= this.view(to, TERMINAL_STATUS);
  }

  snapshot(to: number): NativeCaptureExtent {
    return this.terminal ?? this.view(to, RUNNING_STATUS);
  }

  private view(to: number, status: NativeCaptureExtent['status']): NativeCaptureExtent {
    const gaps = new Set(this.gaps);
    if (this.pending) gaps.add('pending-native-invocations');
    if (this.abandoned) gaps.add('abandoned-native-invocations');
    return Object.freeze({
      version: 1,
      extentId: this.runId,
      runId: this.runId,
      scope: 'root-log',
      logAddress: Object.freeze({ logRunId: this.address.logRunId, drillPath: Object.freeze([]) }),
      commits: Object.freeze({ from: this.from, to }),
      status,
      invocations: Object.freeze({
        started: this.started,
        settled: this.settled,
        pending: this.pending,
        abandoned: this.abandoned,
      }),
      persistence: 'memory-only',
      limitations: Object.freeze([...gaps]),
    });
  }
}
