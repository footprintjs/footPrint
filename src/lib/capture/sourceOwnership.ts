import type { LogAddress } from 'foottrace';
import { buildAttemptId } from 'foottrace';

import type { SourceOwnershipGap, SourceOwnershipWitness } from './sourceOwnershipFormat.js';
import { isNativeSourceExecution, SOURCE_OWNERSHIP_GAPS, SOURCE_OWNERSHIP_V1_LIMITS } from './sourceOwnershipFormat.js';

type MutableOwner = {
  runtimeStageId: string;
  stateAddress: readonly string[];
  firstCommit?: number;
  attemptIds: string[];
};

/** Collect at the existing native funnels, independently of source rows and retained read values. */
export class SourceOwnershipCollector {
  private readonly executions = new Map<string, MutableOwner>();
  private readonly gaps = new Set<SourceOwnershipGap>();
  private attempts = 0;
  private bytes = 0;

  constructor(private readonly runId: string, private readonly logAddress: LogAddress, private readonly from: number) {
    // Reserve the largest header before entries. Native identifiers may need JSON escapes.
    this.bytes = encodedBytes({
      version: 1,
      runId,
      logAddress,
      segment: Number.MAX_SAFE_INTEGER,
      commits: { from, to: Number.MAX_SAFE_INTEGER },
      status: 'captured',
      limitations: SOURCE_OWNERSHIP_GAPS,
      executions: [],
    });
    if (this.bytes > SOURCE_OWNERSHIP_V1_LIMITS.bytes) this.limit('bytes-limit');
  }

  limit(gap: SourceOwnershipGap): void {
    this.gaps.add(gap);
  }

  begin(runId: string, runtimeStageId: string, stateAddress: readonly string[]): void {
    if (
      runId !== this.runId ||
      runtimeStageId.length > SOURCE_OWNERSHIP_V1_LIMITS.name ||
      !isNativeSourceExecution(runtimeStageId)
    ) {
      this.limit('identity-unavailable');
      return;
    }
    if (this.executions.has(runtimeStageId)) {
      this.limit('identity-unavailable');
      return;
    }
    if (this.executions.size >= SOURCE_OWNERSHIP_V1_LIMITS.executions) {
      this.limit('execution-limit');
      return;
    }
    if (
      stateAddress.length > SOURCE_OWNERSHIP_V1_LIMITS.depth ||
      stateAddress.some((part) => typeof part !== 'string' || part.length > SOURCE_OWNERSHIP_V1_LIMITS.name)
    ) {
      this.limit('identity-unavailable');
      return;
    }
    if (
      !this.charge(
        encodedBytes({ runtimeStageId, stateAddress, firstCommit: Number.MAX_SAFE_INTEGER, attemptIds: [] }) + 1,
      )
    )
      return;
    this.executions.set(runtimeStageId, {
      runtimeStageId,
      stateAddress: Object.freeze([...stateAddress]),
      attemptIds: [],
    });
  }

  attempt(runtimeStageId: string, attempt: number): string | undefined {
    const owner = this.executions.get(runtimeStageId);
    if (!owner || !Number.isSafeInteger(attempt) || attempt < 1 || attempt !== owner.attemptIds.length + 1) {
      this.limit('attempt-unavailable');
      return undefined;
    }
    if (this.attempts >= SOURCE_OWNERSHIP_V1_LIMITS.attempts) {
      this.limit('attempt-limit');
      return undefined;
    }
    const id = buildAttemptId(runtimeStageId, attempt);
    if (id.length > SOURCE_OWNERSHIP_V1_LIMITS.name) {
      this.limit('attempt-unavailable');
      return undefined;
    }
    if (!this.charge(encodedBytes(id) + 1)) return undefined;
    owner.attemptIds.push(id);
    this.attempts++;
    return id;
  }

  commit(runtimeStageId: string, index: number): void {
    const owner = this.executions.get(runtimeStageId);
    if (!owner || !Number.isSafeInteger(index) || index < this.from) {
      this.limit('commit-unavailable');
      return;
    }
    owner.firstCommit ??= index;
  }

  checkSelectedAddress(runtimeStageId: string, selected: readonly string[]): void {
    const address = this.executions.get(runtimeStageId)?.stateAddress;
    // A native fallback is real evidence, but it cannot authorize its own address.
    if (address && (address.length !== selected.length || address.some((part, index) => part !== selected[index])))
      this.limit('source-address-unproven');
  }

  snapshot(to: number, segment: number): SourceOwnershipWitness {
    return Object.freeze({
      version: 1,
      runId: this.runId,
      logAddress: this.logAddress,
      segment,
      commits: Object.freeze({ from: this.from, to }),
      status: this.gaps.size ? 'unknown' : 'captured',
      limitations: Object.freeze([...this.gaps]),
      executions: Object.freeze(
        [...this.executions.values()].map((owner) =>
          Object.freeze({
            runtimeStageId: owner.runtimeStageId,
            stateAddress: owner.stateAddress,
            ...(owner.firstCommit !== undefined && { firstCommit: owner.firstCommit }),
            attemptIds: Object.freeze([...owner.attemptIds]),
          }),
        ),
      ),
    });
  }

  private charge(bytes: number): boolean {
    if (bytes > SOURCE_OWNERSHIP_V1_LIMITS.bytes - this.bytes) {
      this.limit('bytes-limit');
      return false;
    }
    this.bytes += bytes;
    return true;
  }
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function redactSourceOwnership(witness: SourceOwnershipWitness): SourceOwnershipWitness {
  return Object.freeze({
    ...witness,
    status: 'unknown',
    executions: Object.freeze([]),
    limitations: Object.freeze(['redacted-export' as const]),
  });
}
