/** Observe dispatch and the one ordered parent write; never infer item/key dependencies. */
import type { CommitBundle } from 'foottrace';
import { normaliseStateKey } from 'foottrace/paths';

import { keepCollection } from '../../../capture/fanoutCollections.js';
import { observeRootReads } from '../../../capture/nativeRootReads.js';
import {
  type FanoutLimitation,
  type FanoutSlot,
  frozenLogAddress,
  referenceBytes,
} from '../../../capture/subflowHandoff.js';
import type { StageContext } from '../../../memory/StageContext.js';
import type { IExecutionRuntime } from '../../types.js';
import { registerGenerated } from './generated.js';
import { ReadPrefix } from './prefix.js';

export class FanoutCapture {
  readonly prefix = new ReadPrefix();
  private readonly slots = new Map<number, FanoutSlot>();
  private readonly limits = new Set<FanoutLimitation>();
  private readonly cutoff: number;
  private readonly parent;
  private target?: string;
  private writeIdx?: number;
  private observed = 0;
  private stopWrites?: () => void;
  private total = 0;
  private branches = 0;
  constructor(private readonly runtime: IExecutionRuntime, private readonly context: StageContext) {
    this.cutoff = runtime.executionHistory.length!;
    this.parent = runtime.executionHistory.address;
  }

  observeSelector(native: boolean): () => void {
    if (!native || this.context.branchId) this.prefix.unavailable = true;
    return observeRootReads(this.context, (key) => {
      const rule = this.context.getPolicy().redaction;
      if (!rule || rule.isInert()) this.prefix.read(key);
    });
  }

  count(total: number, branches: number): void {
    this.total = total;
    this.branches = branches;
    if (total > branches) this.limits.add('branches-truncated');
  }

  register(options: object, index: number, enabled: boolean): void {
    registerGenerated(options, {
      cutoff: this.cutoff,
      parent: this.parent,
      prefix: enabled ? this.prefix : undefined,
      advanced: () => this.runtime.executionHistory.length !== this.cutoff,
      settled: (address, beforeCommitIdx, failed, explicit) => {
        this.observed++;
        if (failed) this.limits.add('failed-slot');
        if (explicit) this.limits.add('explicit-output');
        const rule = this.context.getPolicy().redaction;
        if (rule && !rule.isInert()) {
          this.limits.add('privacy-active');
          return;
        }
        if (!address) {
          this.limits.add('missing-child-record');
          return;
        }
        if (
          !this.prefix.spend(
            referenceBytes(address.logRunId) + address.drillPath.reduce((n, p) => n + referenceBytes(p), 0),
            1,
          )
        ) {
          this.limits.add('budget-exhausted');
          return;
        }
        this.slots.set(
          index,
          Object.freeze({
            index,
            child: Object.freeze({ address: frozenLogAddress(address), beforeCommitIdx }),
            observation: failed ? 'failed-slot' : explicit ? 'explicit-output' : 'scope-snapshot',
          }),
        );
      },
    });
  }

  watchWrite(): void {
    this.writeIdx = this.runtime.executionHistory.length;
    this.stopWrites = this.context.observeStagedWrites((path) => {
      this.target = normaliseStateKey(path);
    });
  }

  close(): void {
    this.stopWrites?.();
    this.stopWrites = undefined;
  }

  finish(bundle: CommitBundle | undefined): void {
    this.close();
    if (
      !this.parent ||
      !bundle ||
      bundle.idx === undefined ||
      bundle.idx !== this.writeIdx ||
      bundle.runtimeStageId !== this.context.runtimeStageId ||
      !this.target ||
      !bundle.trace.some((row) => row.path === this.target)
    )
      return;
    if (this.observed !== this.branches) this.limits.add('missing-child-record');
    if (this.prefix.exhausted) this.limits.add('budget-exhausted');
    const rule = this.context.getPolicy().redaction;
    if (rule && !rule.isInert()) this.limits.add('privacy-active');
    const slots = this.limits.has('privacy-active') ? [] : [...this.slots.values()].sort((a, b) => a.index - b.index);
    keepCollection(
      this.runtime,
      Object.freeze({
        version: 1,
        attribution: 'observed-scope-collection',
        parent: Object.freeze({
          address: frozenLogAddress(this.parent),
          runtimeStageId: bundle.runtimeStageId,
          commitIdx: bundle.idx,
          path: this.target,
        }),
        totalItems: this.total,
        branchCount: this.branches,
        slots: Object.freeze(slots),
        status: this.limits.size ? 'partial' : 'captured',
        limitations: Object.freeze([...this.limits]),
      }),
    );
  }
}
