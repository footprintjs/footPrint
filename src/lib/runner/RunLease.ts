import { RunInFlightError } from '../errors/RunInFlightError.js';

/** Internal ownership capability. A stale release can never release another admission. */
export interface RunAdmission {
  bindRunId(runId: string): void;
  release(): void;
}

/** One synchronous admission boundary, reused by executors and logical runners. */
export class RunLease {
  private active?: { runId?: string };

  constructor(private readonly runnerId: string) {}

  acquire(): RunAdmission {
    if (this.active) throw new RunInFlightError(this.runnerId, this.active.runId);
    const admission: { runId?: string } = {};
    this.active = admission;
    return {
      bindRunId: (runId) => {
        if (this.active !== admission) throw new TypeError('Run admission has ended');
        admission.runId = runId;
      },
      release: () => {
        if (this.active === admission) this.active = undefined;
      },
    };
  }
}
