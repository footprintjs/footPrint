/** Observe a mapper before its actual child seed lands. No projected or restored success. */
import type { CommitBundle, LogAddress } from 'foottrace';

import {
  type InputHandoff,
  type InputLimitation,
  frozenLogAddress,
  referenceBytes,
} from '../../../capture/subflowHandoff.js';
import type { StageContext } from '../../../memory/StageContext.js';
import type { IExecutionRuntime, SubflowMountOptions } from '../../types.js';
import { watchMapperReads } from '../mapperScope.js';
import { type GeneratedInput, generatedInput } from './generated.js';
import { ReadPrefix } from './prefix.js';

export class InputCapture {
  private readonly prefix: ReadPrefix;
  private readonly cutoff: number;
  private readonly parent: LogAddress;
  private readonly origin?: GeneratedInput;
  private readonly limits = new Set<InputLimitation>();
  private constructor(
    private readonly runtime: IExecutionRuntime,
    private readonly context: StageContext,
    origin?: GeneratedInput,
  ) {
    this.origin = origin;
    this.prefix = new ReadPrefix();
    const address = origin?.parent ?? runtime.executionHistory.address!;
    const fixed = addressBudget(address, context.runtimeStageId);
    this.prefix.spend(fixed.bytes, fixed.items);
    if (origin?.prefix) {
      for (const key of origin.prefix.snapshot()) this.prefix.read(key);
      this.prefix.exhausted ||= origin.prefix.exhausted;
      this.prefix.unavailable = origin.prefix.unavailable;
    }
    this.cutoff = origin?.cutoff ?? runtime.executionHistory.length!;
    this.parent = frozenLogAddress(origin?.parent ?? runtime.executionHistory.address!);
    if (origin && !origin.prefix) this.limits.add('selector-reads-unavailable');
  }

  static begin(
    runtime: IExecutionRuntime,
    context: StageContext,
    options: SubflowMountOptions | undefined,
    selected = { input: true, fanout: true },
  ): InputCapture | undefined {
    const origin = generatedInput(options);
    if (!options?.inputMapper || !(origin ? selected.input || selected.fanout : selected.input)) return;
    if (!runtime.executionHistory.address || runtime.executionHistory.length === undefined) return;
    const fixed = addressBudget(origin?.parent ?? runtime.executionHistory.address, context.runtimeStageId);
    if (fixed.bytes > 64 * 1024 || fixed.items > 4096) return;
    return new InputCapture(runtime, context, origin);
  }

  watch(view: object): void {
    if (!this.origin)
      watchMapperReads(view, (key, value) => {
        if (!this.context.getPolicy().redaction || this.context.getPolicy().redaction!.isInert()) this.prefix.read(key);
        return value;
      });
  }

  finish(child: LogAddress | undefined, bundle: CommitBundle | undefined, resume: boolean): InputHandoff | undefined {
    if (
      !child ||
      !bundle ||
      bundle.idx !== 0 ||
      bundle.runtimeStageId !== this.context.runtimeStageId ||
      bundle.trace.length === 0
    )
      return;
    if (
      child.logRunId !== this.parent.logRunId ||
      child.drillPath.length !== this.parent.drillPath.length + 1 ||
      !this.parent.drillPath.every((part, index) => part === child.drillPath[index]) ||
      child.drillPath.at(-1) !== bundle.runtimeStageId
    )
      return;
    if (this.runtime.executionHistory.length !== this.cutoff || this.origin?.advanced())
      this.limits.add('parent-log-advanced');
    if (this.context.getPolicy().redaction && !this.context.getPolicy().redaction!.isInert())
      this.limits.add('privacy-active');
    if (resume) this.limits.add('resume-seed');
    if (this.prefix.unavailable) this.limits.add('selector-reads-unavailable');
    const reads = this.prefix.snapshot();
    const writes: Array<InputHandoff['writes'][number]> = [];
    const withheld =
      resume ||
      this.limits.has('privacy-active') ||
      this.limits.has('parent-log-advanced') ||
      this.limits.has('selector-reads-unavailable');
    const seen = new Set<string>();
    if (!resume)
      for (const row of bundle.trace) {
        if (seen.has(row.path)) continue;
        seen.add(row.path);
        if (writes.length === 256 || !this.prefix.spend(referenceBytes(row.path), 1)) {
          this.limits.add('budget-exhausted');
          break;
        }
        const kept =
          !withheld &&
          this.prefix.spend(
            reads.reduce((sum, key) => sum + referenceBytes(key), 0),
            reads.length,
          )
            ? reads
            : Object.freeze([]);
        writes.push(Object.freeze({ path: row.path, reads: kept }));
      }
    if (this.prefix.exhausted) this.limits.add('budget-exhausted');
    return Object.freeze({
      version: 1,
      attribution: 'observed-read-prefix',
      parent: Object.freeze({ address: this.parent, beforeCommitIdx: this.cutoff }),
      child: Object.freeze({ address: frozenLogAddress(child), runtimeStageId: bundle.runtimeStageId, commitIdx: 0 }),
      writes: Object.freeze(writes),
      status: this.limits.size ? 'partial' : 'captured',
      limitations: Object.freeze([...this.limits]),
    });
  }
}

/** Budget both actual addresses and the child's repeated mount ID before retaining any source name. */
function addressBudget(parent: LogAddress, mount: string): { bytes: number; items: number } {
  return {
    bytes:
      2 * (referenceBytes(parent.logRunId) + parent.drillPath.reduce((n, part) => n + referenceBytes(part), 0)) +
      2 * referenceBytes(mount),
    items: 2 * (1 + parent.drillPath.length) + 2,
  };
}
