/** How many late writes a stage keeps — an abandoned attempt that loops must not grow the record without bound. */
export const MAX_LATE_WRITES = 100;

/**
 * How many call and observed attempt records one stage execution keeps (P2) — a stage that calls in a loop must
 * not grow the execution tree without bound. The rest are counted (`StageSnapshot.attemptsDropped`) and still
 * fired on `onAttempt`. A stage's OWN attempt records are never displaced: its policy's ceiling bounds them.
 */
export const MAX_CALL_RECORDS = 1000;
