/**
 * F8 (9.39.0) — the named record changes the byte-identity references
 * predate: the writer names a stage's continuation on its bundle
 * (`CommitBundle.phase`: a mount's `'exit'`, a fork child's `'repeat'`), and
 * a checkpoint carries its format (`checkpointVersion: 1`).
 *
 * A reference written by an older release has no such key, and it must never
 * be regenerated (it exists to be old). So a byte pin compares the build's
 * bytes with every recorded phase and checkpoint version taken back out — and
 * nothing else moved. What they ARE is pinned on its own, in
 * one-stage-one-record.test.ts and test/lib/pause/record.test.ts.
 */

const PHASES = new Set(['exit', 'repeat']);

/** Every object that is a commit bundle (it has a `runtimeStageId` and a `trace`) loses its `phase`. */
export function stripRecordedPhases(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripRecordedPhases(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const isBundle = Object.prototype.hasOwnProperty.call(record, 'runtimeStageId') && Array.isArray(record.trace);
  if (isBundle && PHASES.has(record.phase as string)) delete record.phase;
  const isCheckpoint = Object.prototype.hasOwnProperty.call(record, 'pausedStageId');
  if (isCheckpoint && record.checkpointVersion === 1) delete record.checkpointVersion;
  for (const key of Object.keys(record)) stripRecordedPhases(record[key]);
}

/** The JSON text `json` without its recorded phases and checkpoint versions, re-serialised in the same layout. */
export function withoutRecordedPhases(json: string): string {
  const space = json.includes('\n') ? 2 : undefined;
  const parsed = JSON.parse(json);
  // Without an edit the re-serialised text IS the input — so the only bytes this can move are phases.
  if (JSON.stringify(parsed, null, space) !== json)
    throw new Error('withoutRecordedPhases: the text does not round-trip');
  stripRecordedPhases(parsed);
  return JSON.stringify(parsed, null, space);
}
