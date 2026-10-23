import type { ReadSourceRecord, ReadSourceSnapshot } from 'foottrace/write';

import type { CaptureChannelStatus, NativeCaptureNote } from './nativeCoverage.js';

/** Engine coverage only. Source descriptors and their codec belong to foottrace/write. */
export const SOURCE_LIMITATIONS = Object.freeze([
  'privacy-active',
  'identity-unavailable',
  'untracked-read',
  'custom-scope',
  'child-source-ownership',
  'resumed-source-ownership',
  'sink-source-unsupported',
  'source-history-not-included',
  'source-capture-failed',
  'redacted-source-export',
] as const);
export type SourceLimitation = (typeof SOURCE_LIMITATIONS)[number];

/** Packet 3 is an in-memory observation, not a stored-history acknowledgement. */
export interface EngineReadSources {
  readonly version: 1;
  readonly runId: string;
  readonly persistence: 'memory-only';
  readonly commits: { readonly from: number; readonly to: number };
  readonly status: CaptureChannelStatus;
  readonly limitations: readonly SourceLimitation[];
  /** Absent means unknown ownership, never an observed-empty book. */
  readonly record?: ReadSourceSnapshot;
}

/** A new discriminant prevents strict v1 readers from accepting new completeness claims. */
export interface NativeReadCaptureNote extends Omit<NativeCaptureNote, 'version' | 'channels'> {
  readonly version: 2;
  readonly channels: Omit<NativeCaptureNote['channels'], 'readSources'> & {
    readonly readSources: CaptureChannelStatus;
  };
}
export type NativeCaptureObservation = NativeCaptureNote | NativeReadCaptureNote;

/** One owner per runtime/leg; propagated only to frames in that log. Never reads values or scans commits. */
export class ReadSourceCapture {
  private readonly gaps = new Set<SourceLimitation>();
  private sealed?: EngineReadSources;
  get observing(): boolean {
    return this.book !== undefined;
  }

  constructor(
    readonly runId: string,
    private readonly book?: ReadSourceRecord,
    gap?: SourceLimitation,
    readonly from = 0,
  ) {
    if (gap) this.gaps.add(gap);
  }

  limit(gap: SourceLimitation): void {
    if (!this.sealed) this.gaps.add(gap);
  }

  retire(): void {
    this.book?.retire();
  }

  seal(to: number): void {
    if (this.sealed) return;
    this.sealed = this.snapshot(to);
    this.retire();
  }

  snapshot(to: number, redact = false): EngineReadSources {
    if (this.sealed && !redact) return this.sealed;
    const gaps = new Set(this.gaps);
    if (redact) gaps.add('redacted-source-export');
    const record = redact ? undefined : this.book?.snapshot();
    const status = !record
      ? 'unknown'
      : record.status === 'failed'
      ? 'failed'
      : record.status !== 'captured' || gaps.size > 0
      ? 'partial'
      : 'captured';
    return Object.freeze({
      version: 1,
      runId: this.runId,
      persistence: 'memory-only',
      commits: Object.freeze({ from: this.from, to }),
      status,
      limitations: Object.freeze([...gaps]),
      ...(record && { record }),
    });
  }
}

/** Keep the v1 producer unchanged. Only explicitly enabled source observations acquire v2. */
export function withReadSources(note: NativeCaptureNote, sources: EngineReadSources): NativeReadCaptureNote {
  return Object.freeze({
    ...note,
    version: 2,
    channels: Object.freeze({ ...note.channels, readSources: sources.status }),
    limitations: Object.freeze(note.limitations.filter((gap) => gap !== 'read-sources-not-collected')),
  });
}
