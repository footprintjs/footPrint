import type { LogAddress } from 'foottrace';

import { applyExplainPrivacy } from './explainIdentity.js';
import type { ExplainCaptureWitness } from './explainWitness.js';
import type { CaptureChannelStatus, NativeCaptureNote } from './nativeCoverage.js';
import type { EngineReadSources } from './readSources.js';
import type { FanoutCollections } from './subflowHandoff.js';

type Mode = 'full' | 'summary' | 'delta' | 'reads-prefix' | 'on' | 'off' | 'unknown';
type Status = 'collected' | 'disabled' | 'partial' | 'failed' | 'unknown';

export type ExplainCaptureReason =
  | 'redacted'
  | 'budget-exhausted'
  | 'capture-failed'
  | 'missing-evidence'
  | 'missing-child'
  | 'unsupported-scope'
  | 'worker-boundary'
  | 'transport-boundary'
  | 'interval-incomplete'
  | 'unverified';

const channels = [
  'reads',
  'writes',
  'commitWrites',
  'writePrefixes',
  'nestedReads',
  'readSources',
  'inputHandoff',
  'outputHandoff',
  'fanoutHandoff',
  'attention',
  'control',
] as const;
type Channel = (typeof channels)[number];
const handoffs = ['inputHandoff', 'outputHandoff', 'fanoutHandoff'] as const;
const retainedValues = ['reads', 'writes', 'commitWrites', 'writePrefixes', 'nestedReads'] as const;

type ChannelNote = Readonly<{ mode: Mode; status: Status; reasons: readonly ExplainCaptureReason[] }>;

/** Memory-only observations for one admitted native log segment. */
export interface ExplainCaptureNote {
  readonly version: 3;
  readonly scope: 'log';
  readonly runId: string;
  readonly logAddress: LogAddress;
  readonly commits: { readonly from: number; readonly to: number };
  readonly boundary: NativeCaptureNote['boundary'];
  readonly persistence: 'memory-only';
  readonly channels: Readonly<Record<Channel, ChannelNote>>;
}

type GapStatus = Exclude<Status, 'collected' | 'disabled'>;
type Gap = { status: GapStatus; reasons: Set<ExplainCaptureReason> };
const strength: Record<GapStatus, number> = { partial: 1, unknown: 2, failed: 3 };

function addGap(
  observations: Map<Channel, Gap>,
  channel: Channel,
  reason: ExplainCaptureReason,
  status: GapStatus,
): void {
  const previous = observations.get(channel);
  if (!previous) {
    observations.set(channel, { status, reasons: new Set([reason]) });
    return;
  }
  if (strength[status] > strength[previous.status]) previous.status = status;
  previous.reasons.add(reason);
}

function handoffReason(limit: string): ExplainCaptureReason {
  if (limit === 'privacy-active') return 'redacted';
  if (limit === 'budget-exhausted' || limit === 'branches-truncated') return 'budget-exhausted';
  if (limit === 'missing-child-record') return 'missing-child';
  if (limit === 'failed-slot') return 'capture-failed';
  if (limit === 'resume-seed') return 'interval-incomplete';
  return 'missing-evidence';
}

const mode = (on: boolean): 'on' | 'off' | 'unknown' => (on === true ? 'on' : on === false ? 'off' : 'unknown');

interface Switches {
  readonly nestedReads: boolean;
  readonly readSources: boolean;
  readonly inputHandoff: boolean;
  readonly outputHandoff: boolean;
  readonly fanoutHandoff: boolean;
}

export type ExplainCaptureFactory = (switches: Switches) => ExplainCapture;

export function createExplainCapture(switches: Switches): ExplainCapture {
  return new ExplainCapture(switches);
}

/** @internal Bounded fixed-vocabulary facts, accumulated at the native owners of this log. */
export class ExplainCapture {
  declare onWitness?: (record: object, witness: ExplainCaptureWitness) => void;
  private readonly observations = new Map<Channel, Gap>();
  private readonly observedHandoffs = new Set<(typeof handoffs)[number]>();
  private untrackedNestedRead = false;

  /** One gap per log, regardless of how many stages or doors expose the values. */
  readonly noteUntrackedNestedRead = (): void => {
    if (this.untrackedNestedRead) return;
    this.untrackedNestedRead = true;
    this.mark('nestedReads', 'unsupported-scope');
  };

  constructor(private readonly switches: Switches) {}

  fork(): ExplainCapture {
    return new ExplainCapture(this.switches);
  }

  mark(channel: Channel, reason: ExplainCaptureReason, status: GapStatus = 'partial'): void {
    addGap(this.observations, channel, reason, status);
  }

  privacy(write: boolean, nested = false): void {
    if (write) {
      this.mark('writes', 'redacted');
      this.mark('commitWrites', 'redacted');
    } else {
      this.mark('reads', 'redacted');
    }
    if (nested) this.mark('nestedReads', 'redacted');
  }

  boundary(reason: 'worker-boundary' | 'transport-boundary' | 'missing-child'): void {
    for (const channel of handoffs) this.mark(channel, reason);
  }

  handoff(
    channel: (typeof handoffs)[number],
    descriptor: { readonly limitations: readonly string[] } | undefined,
  ): void {
    if (!descriptor) return;
    this.observedHandoffs.add(channel);
    for (const limit of descriptor.limitations) this.mark(channel, handoffReason(limit));
  }

  snapshot(
    note: NativeCaptureNote,
    sources: EngineReadSources | undefined,
    fanout: FanoutCollections | undefined,
    control: CaptureChannelStatus,
    serving: Readonly<{ redact: boolean; activePrivacy: boolean; hideFailureStage: boolean }>,
  ): ExplainCaptureNote {
    const modes: Record<Channel, Mode> = {
      reads: note.modes.readTracking,
      writes: note.modes.writeTracking,
      commitWrites: note.modes.commitValues,
      writePrefixes: note.modes.writeProvenance,
      nestedReads: mode(this.switches.nestedReads),
      readSources: mode(this.switches.readSources),
      inputHandoff: mode(this.switches.inputHandoff),
      outputHandoff: mode(this.switches.outputHandoff),
      fanoutHandoff: mode(this.switches.fanoutHandoff),
      attention: 'on',
      control: control === 'unknown' ? 'unknown' : 'on',
    };
    const gaps = new Map([...this.observations].map(([key, gap]) => [key, { ...gap, reasons: new Set(gap.reasons) }]));
    const add = (key: Channel, reason: ExplainCaptureReason, status: GapStatus = 'partial') =>
      addGap(gaps, key, reason, status);
    const limits = note.limitations;
    if (limits.includes('custom-scope')) {
      for (const key of [...retainedValues, 'readSources', 'attention', ...handoffs] as const)
        add(key, 'unsupported-scope', 'unknown');
    }
    if (limits.includes('read-retention-failed')) add('reads', 'capture-failed', 'failed');
    if (limits.includes('commit-retention-failed')) {
      for (const key of ['writes', 'commitWrites', 'writePrefixes'] as const) add(key, 'capture-failed', 'failed');
      for (const key of ['readSources', ...handoffs] as const) add(key, 'missing-evidence', 'unknown');
      add('attention', 'missing-evidence');
    }
    if (limits.includes('attention-omitted') || limits.includes('identity-omitted') || serving.hideFailureStage)
      add('attention', 'missing-evidence');
    if (limits.includes('modes-unavailable')) {
      for (const key of ['reads', 'writes', 'attention'] as const) add(key, 'unverified', 'unknown');
    }
    if (limits.includes('recorder-snapshot-failed')) add('control', 'capture-failed', 'failed');
    if (control === 'partial') add('control', 'missing-evidence');
    if (this.switches.nestedReads && modes.reads === 'off' && modes.writePrefixes === 'off')
      add('nestedReads', 'missing-evidence');
    if (note.boundary.status !== 'completed' || limits.includes('execution-broken')) {
      for (const key of channels) add(key, 'interval-incomplete');
    }
    if (this.switches.readSources && sources?.status !== 'captured') {
      const status = sources?.status === 'failed' ? 'failed' : sources?.status === 'partial' ? 'partial' : 'unknown';
      const limitations = sources?.limitations ?? [];
      for (const limitation of limitations) {
        const reason =
          limitation === 'privacy-active' || limitation === 'redacted-source-export'
            ? 'redacted'
            : limitation === 'source-capture-failed'
            ? 'capture-failed'
            : limitation === 'custom-scope'
            ? 'unsupported-scope'
            : limitation === 'resumed-source-ownership'
            ? 'interval-incomplete'
            : 'missing-evidence';
        add('readSources', reason, status);
      }
      const sourceGaps = sources?.record?.gaps ?? [];
      for (const { reason } of sourceGaps) {
        const mapped =
          reason === 'redacted' || reason === 'budget-exhausted' || reason === 'capture-failed'
            ? reason
            : 'missing-evidence';
        add('readSources', mapped, status);
      }
      if (limitations.length === 0 && sourceGaps.length === 0)
        add('readSources', status === 'failed' ? 'capture-failed' : 'unverified', status);
    }
    if (fanout?.status === 'partial') {
      for (const { limitations } of fanout.collections)
        for (const limit of limitations) add('fanoutHandoff', handoffReason(limit));
      if (!gaps.has('fanoutHandoff')) add('fanoutHandoff', 'missing-evidence');
    }
    if (serving.redact) {
      if (sources?.record) add('readSources', 'redacted', 'unknown');
      for (const channel of this.observedHandoffs) add(channel, 'redacted');
      if (fanout?.collections.length) add('fanoutHandoff', 'redacted');
    }
    if (limits.includes('checkpoint-history-not-included')) {
      for (const key of channels) {
        const gap = gaps.get(key);
        if (gap?.status === 'partial' || gap?.status === 'failed') gap.reasons.add('missing-evidence');
        else add(key, 'missing-evidence', 'unknown');
      }
    }
    const records = Object.fromEntries(
      channels.map((key) => {
        const currentMode = modes[key];
        const gap = gaps.get(key);
        const status: Status =
          currentMode === 'off' ? 'disabled' : currentMode === 'unknown' ? 'unknown' : gap?.status ?? 'collected';
        const reasons =
          status === 'disabled' || status === 'collected' ? [] : gap ? [...gap.reasons] : (['unverified'] as const);
        return [key, Object.freeze({ mode: currentMode, status, reasons: Object.freeze(reasons) })] as const;
      }),
    ) as Record<Channel, ChannelNote>;
    const status = note.boundary.status;
    const failure = status === 'failed' || status === 'cancelled' ? note.boundary.failure : undefined;
    const stage = failure?.stage;
    const safeStage =
      !serving.hideFailureStage && stage?.runId === note.runId && stage.runtimeStageId.length <= 1024
        ? Object.freeze({ runId: stage.runId, runtimeStageId: stage.runtimeStageId })
        : undefined;
    const capture: ExplainCaptureNote = Object.freeze({
      version: 3,
      scope: 'log',
      runId: note.runId,
      logAddress: note.logAddress,
      commits: note.commits,
      boundary: Object.freeze({
        status,
        ...(failure && {
          failure: Object.freeze({ category: failure.category, ...(safeStage && { stage: safeStage }) }),
        }),
      }),
      persistence: 'memory-only',
      channels: Object.freeze(records),
    });
    return serving.activePrivacy ? applyExplainPrivacy(capture) : capture;
  }
}
