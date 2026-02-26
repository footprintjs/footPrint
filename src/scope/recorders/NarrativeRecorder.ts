/**
 * NarrativeRecorder — Scope-level recorder that captures per-stage reads and writes
 * for enriching narrative output with actual data values.
 * ----------------------------------------------------------------------------
 * WHY: The NarrativeGenerator (pipeline-level) captures FLOW — what stages ran,
 * which branches were taken, how many loops occurred. But it doesn't capture
 * DATA — what values were read, what was written, what changed.
 *
 * NarrativeRecorder bridges this gap. It observes scope operations (reads/writes)
 * and produces per-stage summaries that can be merged with NarrativeGenerator
 * sentences to give the FULL picture: what happened AND what was produced.
 *
 * THE FULL PICTURE:
 *   NarrativeGenerator (flow):  "CallLLM sent messages to the provider."
 *   NarrativeRecorder (data):   "  - Read: messages (3 items)"
 *                               "  - Wrote: lastResponse.model = 'gpt-4'"
 *                               "  - Wrote: lastResponse.usage.totalTokens = 847"
 *
 * Combined, a cheap LLM can answer follow-up questions from the trace alone,
 * without re-running the pipeline or making additional tool calls.
 *
 * DESIGN DECISIONS:
 * - Per-stage grouping: Reads/writes are grouped by stage name, matching
 *   NarrativeGenerator's per-stage sentence structure.
 * - Value summarization: Values are summarized (not raw-dumped) to keep
 *   narrative concise. Arrays show length, objects show key count, strings
 *   are truncated. This prevents token bloat when injecting into LLM context.
 * - Configurable detail: `detail` option controls verbosity. 'summary' mode
 *   shows read/write counts. 'full' mode shows individual operations with values.
 * - Chronological order: Operations are recorded in execution order within
 *   each stage, preserving the temporal narrative.
 *
 * RELATED:
 * - {@link NarrativeGenerator} — Pipeline-level flow narrative (what happened)
 * - {@link DebugRecorder} — Development-focused verbose logging
 * - {@link MetricRecorder} — Production-focused timing/counts
 * - {@link LLMRecorder} — LLM-specific call tracking (in agentFootprints)
 *
 * @module scope/recorders/NarrativeRecorder
 */

import type { ReadEvent, Recorder, WriteEvent, CommitEvent, StageEvent } from '../types';

// ============================================================================
// Types
// ============================================================================

/**
 * Detail level for NarrativeRecorder output.
 *
 * - 'summary': Per-stage read/write counts (compact, good for overview)
 * - 'full': Individual read/write operations with summarized values
 */
export type NarrativeDetail = 'summary' | 'full';

/**
 * A single recorded scope operation (read or write) within a stage.
 *
 * @property type - Whether this was a 'read' or 'write' operation
 * @property path - The namespace path (e.g., ['agent'], ['user'])
 * @property key - The key being accessed (e.g., 'lastResponse', 'name')
 * @property value - Summarized value string (not raw value — prevents token bloat)
 * @property operation - For writes: 'set' or 'update'
 */
export interface NarrativeOperation {
  /** Whether this was a 'read' or 'write' operation */
  type: 'read' | 'write';
  /** The namespace path for the operation */
  path: string[];
  /** The key being accessed */
  key: string;
  /** Summarized value string */
  valueSummary: string;
  /** For writes: the type of write operation */
  operation?: 'set' | 'update';
}

/**
 * Per-stage narrative data — all scope operations that occurred in one stage.
 *
 * @property stageName - The stage these operations belong to
 * @property reads - All read operations in execution order
 * @property writes - All write operations in execution order
 */
export interface StageNarrativeData {
  /** The stage these operations belong to */
  stageName: string;
  /** All read operations in execution order */
  reads: NarrativeOperation[];
  /** All write operations in execution order */
  writes: NarrativeOperation[];
}

/**
 * Options for creating a NarrativeRecorder instance.
 *
 * @property id - Optional unique identifier
 * @property detail - Detail level: 'summary' or 'full' (default: 'full')
 * @property maxValueLength - Max characters for value summaries (default: 80)
 */
export interface NarrativeRecorderOptions {
  /** Optional unique identifier */
  id?: string;
  /** Detail level: 'summary' or 'full' (default: 'full') */
  detail?: NarrativeDetail;
  /** Max characters for value summaries (default: 80) */
  maxValueLength?: number;
}

// ============================================================================
// NarrativeRecorder Implementation
// ============================================================================

/**
 * NarrativeRecorder — captures per-stage scope operations for narrative enrichment.
 *
 * WHY: Bridges the gap between flow-level narrative (NarrativeGenerator) and
 * data-level detail. Produces structured per-stage data and text sentences
 * that can be merged with NarrativeGenerator output.
 *
 * @example
 * ```typescript
 * const recorder = new NarrativeRecorder();
 * scope.attachRecorder(recorder);
 *
 * // ... execute pipeline ...
 *
 * // Get structured per-stage data
 * const stageData = recorder.getStageData();
 * // → Map { 'CallLLM' => { reads: [...], writes: [...] }, ... }
 *
 * // Get text sentences for each stage
 * const sentences = recorder.toSentences();
 * // → Map { 'CallLLM' => ['  - Read: messages (3 items)', '  - Wrote: lastResponse.model = "gpt-4"'], ... }
 *
 * // Merge with NarrativeGenerator output
 * const narrative = narrativeGenerator.getSentences();
 * const enriched = mergeNarrative(narrative, sentences);
 * ```
 */
export class NarrativeRecorder implements Recorder {
  /**
   * Unique identifier for this recorder instance.
   */
  readonly id: string;

  /**
   * Per-stage narrative data, keyed by stage name.
   */
  private stages: Map<string, StageNarrativeData> = new Map();

  /**
   * Ordered list of stage names as they were first encountered.
   * WHY: Preserves execution order for toSentences() output.
   */
  private stageOrder: string[] = [];

  /**
   * Detail level for output generation.
   */
  private detail: NarrativeDetail;

  /**
   * Maximum characters for value summaries.
   */
  private maxValueLength: number;

  /**
   * Creates a new NarrativeRecorder instance.
   *
   * @param options - Optional configuration
   */
  constructor(options?: NarrativeRecorderOptions) {
    this.id = options?.id ?? `narrative-recorder-${Date.now()}`;
    this.detail = options?.detail ?? 'full';
    this.maxValueLength = options?.maxValueLength ?? 80;
  }

  // ==========================================================================
  // Recorder Hooks
  // ==========================================================================

  /**
   * Called when a value is read from scope.
   *
   * WHY: Captures what data each stage consumed. This tells the narrative
   * reader what inputs influenced the stage's behavior.
   *
   * @param event - Details about the read operation
   */
  onRead(event: ReadEvent): void {
    const stageData = this.getOrCreateStageData(event.stageName);
    stageData.reads.push({
      type: 'read',
      path: event.path,
      key: event.key ?? '',
      valueSummary: summarizeValue(event.value, this.maxValueLength),
    });
  }

  /**
   * Called when a value is written to scope.
   *
   * WHY: Captures what data each stage produced. This tells the narrative
   * reader what outputs the stage generated — the actual values, not just
   * "something was written."
   *
   * @param event - Details about the write operation
   */
  onWrite(event: WriteEvent): void {
    const stageData = this.getOrCreateStageData(event.stageName);
    stageData.writes.push({
      type: 'write',
      path: event.path,
      key: event.key,
      valueSummary: summarizeValue(event.value, this.maxValueLength),
      operation: event.operation,
    });
  }

  // ==========================================================================
  // Access Methods
  // ==========================================================================

  /**
   * Returns structured per-stage narrative data.
   *
   * WHY: Structured data allows consumers to build custom narrative formats,
   * filter by stage, or combine with other data sources.
   *
   * @returns Map of stage names to their narrative data (defensive copy)
   *
   * @example
   * ```typescript
   * const stageData = recorder.getStageData();
   * const callLLM = stageData.get('CallLLM');
   * if (callLLM) {
   *   console.log(`CallLLM read ${callLLM.reads.length} values`);
   *   console.log(`CallLLM wrote ${callLLM.writes.length} values`);
   * }
   * ```
   */
  getStageData(): Map<string, StageNarrativeData> {
    const copy = new Map<string, StageNarrativeData>();
    for (const [name, data] of this.stages) {
      copy.set(name, {
        stageName: data.stageName,
        reads: [...data.reads],
        writes: [...data.writes],
      });
    }
    return copy;
  }

  /**
   * Returns narrative data for a specific stage.
   *
   * @param stageName - The stage to get data for
   * @returns The stage's narrative data, or undefined if no data recorded
   */
  getStageDataFor(stageName: string): StageNarrativeData | undefined {
    const data = this.stages.get(stageName);
    if (!data) return undefined;
    return {
      stageName: data.stageName,
      reads: [...data.reads],
      writes: [...data.writes],
    };
  }

  /**
   * Returns text sentences per stage, suitable for merging with NarrativeGenerator output.
   *
   * WHY: Produces human-readable lines that can be nested under each
   * NarrativeGenerator sentence to show what data flowed through the stage.
   *
   * In 'summary' mode: "  - Read 3 values, wrote 2 values"
   * In 'full' mode:     "  - Read: messages (3 items)"
   *                     "  - Wrote: lastResponse.model = 'gpt-4'"
   *
   * @returns Map of stage names to arrays of text lines, in execution order
   *
   * @example
   * ```typescript
   * const sentences = recorder.toSentences();
   * for (const [stageName, lines] of sentences) {
   *   console.log(`${stageName}:`);
   *   for (const line of lines) {
   *     console.log(line);
   *   }
   * }
   * ```
   */
  toSentences(): Map<string, string[]> {
    const result = new Map<string, string[]>();

    for (const stageName of this.stageOrder) {
      const data = this.stages.get(stageName);
      if (!data) continue;

      const lines: string[] = [];

      if (this.detail === 'summary') {
        // Compact summary mode
        const parts: string[] = [];
        if (data.reads.length > 0) {
          parts.push(`read ${data.reads.length} value${data.reads.length > 1 ? 's' : ''}`);
        }
        if (data.writes.length > 0) {
          parts.push(`wrote ${data.writes.length} value${data.writes.length > 1 ? 's' : ''}`);
        }
        if (parts.length > 0) {
          lines.push(`  - ${capitalize(parts.join(', '))}`);
        }
      } else {
        // Full detail mode — individual operations
        for (const read of data.reads) {
          const path = formatPath(read.path, read.key);
          if (read.valueSummary) {
            lines.push(`  - Read: ${path} = ${read.valueSummary}`);
          } else {
            lines.push(`  - Read: ${path}`);
          }
        }
        for (const write of data.writes) {
          const path = formatPath(write.path, write.key);
          lines.push(`  - Wrote: ${path} = ${write.valueSummary}`);
        }
      }

      if (lines.length > 0) {
        result.set(stageName, lines);
      }
    }

    return result;
  }

  /**
   * Returns a flat array of all narrative lines across all stages, in execution order.
   *
   * WHY: For simple consumption where per-stage grouping isn't needed.
   * Each line is prefixed with the stage name for context.
   *
   * @returns Array of narrative lines in execution order
   *
   * @example
   * ```typescript
   * const lines = recorder.toFlatSentences();
   * // → [
   * //   "Initialize: Read config.apiKey",
   * //   "Initialize: Wrote agent.model = 'gpt-4'",
   * //   "CallLLM: Read messages (3 items)",
   * //   "CallLLM: Wrote lastResponse.content = 'Hello...'",
   * // ]
   * ```
   */
  toFlatSentences(): string[] {
    const result: string[] = [];
    const perStage = this.toSentences();
    for (const [stageName, lines] of perStage) {
      for (const line of lines) {
        // Remove the leading "  - " indent and prefix with stage name
        const cleaned = line.replace(/^\s+-\s+/, '');
        result.push(`${stageName}: ${cleaned}`);
      }
    }
    return result;
  }

  /**
   * Clears all recorded data.
   *
   * Use this to reset the recorder for a new execution run.
   */
  clear(): void {
    this.stages.clear();
    this.stageOrder = [];
  }

  /**
   * Sets the detail level for output generation.
   *
   * Note: Changing detail only affects future toSentences() calls.
   * Recorded data is always captured at full detail.
   *
   * @param level - The new detail level
   */
  setDetail(level: NarrativeDetail): void {
    this.detail = level;
  }

  /**
   * Returns the current detail level.
   */
  getDetail(): NarrativeDetail {
    return this.detail;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Gets or creates stage narrative data for the given stage name.
   */
  private getOrCreateStageData(stageName: string): StageNarrativeData {
    let data = this.stages.get(stageName);
    if (!data) {
      data = {
        stageName,
        reads: [],
        writes: [],
      };
      this.stages.set(stageName, data);
      this.stageOrder.push(stageName);
    }
    return data;
  }
}

// ============================================================================
// Private Helpers
// ============================================================================

/**
 * Summarizes a value for narrative display.
 *
 * WHY: Raw values can be huge (full LLM responses, large arrays). Summaries
 * keep the narrative concise while conveying the essential information.
 *
 * Rules:
 * - null/undefined → "undefined"
 * - string → truncated to maxLen with "..." suffix
 * - number/boolean → string representation
 * - array → "({length} items)" or first few values if short
 * - object → "{key1, key2, ...}" showing top-level keys
 *
 * @param value - The value to summarize
 * @param maxLen - Maximum characters for the summary
 * @returns A concise string representation
 */
function summarizeValue(value: unknown, maxLen: number): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';

  if (typeof value === 'string') {
    if (value.length <= maxLen) return `"${value}"`;
    return `"${value.slice(0, maxLen - 3)}..."`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `(${value.length} item${value.length > 1 ? 's' : ''})`;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return '{}';
    const preview = keys.slice(0, 4).join(', ');
    const suffix = keys.length > 4 ? `, ... (${keys.length} keys)` : '';
    const result = `{${preview}${suffix}}`;
    if (result.length <= maxLen) return result;
    return `{${keys.length} keys}`;
  }

  return String(value);
}

/**
 * Formats a path + key into a readable dotted string.
 *
 * @example
 * formatPath(['agent'], 'lastResponse') → "agent.lastResponse"
 * formatPath(['user', 'profile'], 'name') → "user.profile.name"
 * formatPath([], 'root') → "root"
 */
function formatPath(path: string[], key: string): string {
  if (path.length === 0) return key;
  return `${path.join('.')}.${key}`;
}

/**
 * Capitalizes the first letter of a string.
 */
function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
