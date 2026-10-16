/** Logical identity of an explicit retry workflow. Physical attempt identities remain unchanged. */
export interface RetryLoopIdentity {
  readonly id: string;
  readonly series: string;
  readonly attempt: number;
  readonly of: number;
}

/** The role of one physical call inside a logical pass. */
export interface RetryLoopCall extends RetryLoopIdentity {
  readonly phase: 'attempt' | 'reconcile';
}

/** The explicit chart decision, after reconciliation; never rewrites a physical call's outcome. */
export interface RetryLoopDecision extends RetryLoopIdentity {
  readonly effect: 'applied' | 'none' | 'unknown';
  readonly reconciled: boolean;
  readonly next: 'retry' | 'done' | 'stop';
  readonly reason: string;
}
