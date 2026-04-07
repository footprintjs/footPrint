/**
 * summarizeValue — Human-readable summary of a scope value for narrative output.
 *
 * Shared by NarrativeRecorder and CombinedNarrativeRecorder to ensure consistent
 * narrative formatting. Truncates strings, summarizes arrays/objects by count.
 */
export declare function summarizeValue(value: unknown, maxLen: number): string;
