/** A logical runner or native executor already owns an unfinished execution. */
export class RunInFlightError extends Error {
  readonly code = 'ERR_RUN_IN_FLIGHT' as const;
  declare readonly activeRunId?: string;

  constructor(readonly runnerId: string, activeRunId?: string) {
    super(`Runner ${runnerId} already has an in-flight execution`);
    this.name = 'RunInFlightError';
    if (activeRunId !== undefined) this.activeRunId = activeRunId;
  }
}
