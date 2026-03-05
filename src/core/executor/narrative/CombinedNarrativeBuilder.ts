/**
 * CombinedNarrativeBuilder — Merges flow-level narrative with step-level operations
 * ----------------------------------------------------------------------------
 * WHY: The NarrativeGenerator captures FLOW — what stages ran, which branches
 * were taken, how many loops occurred. The NarrativeRecorder captures DATA —
 * what values were read, written, updated, or deleted at each stage.
 *
 * These two systems produce separate outputs. CombinedNarrativeBuilder weaves
 * them together into a single unified narrative with the structure:
 *
 *   Stage 1: "Receive Application"
 *     Step 1: Write applicantName = 'Bob'
 *     Step 2: Write annualIncome = 42000
 *   Stage 2: "Pull Credit Report"
 *     Step 1: Read rawCreditScore = 580
 *     Step 2: Write creditTier = 'poor'
 *   [Condition]: risk tier is high → chose "Reject Application"
 *
 * This combined output lets any consumer (LLM, logger, UI) understand both
 * WHAT happened (flow) and WHY (data operations and conditions).
 *
 * @module core/executor/narrative/CombinedNarrativeBuilder
 */

import type { NarrativeRecorder, StageNarrativeData } from '../../../scope/recorders/NarrativeRecorder';

// ============================================================================
// Types
// ============================================================================

/**
 * A single entry in the combined narrative output.
 */
export interface CombinedNarrativeEntry {
  /** The type of entry: stage header, step operation, or condition */
  type: 'stage' | 'step' | 'condition' | 'fork' | 'subflow' | 'loop' | 'break' | 'error';
  /** The rendered text for this entry */
  text: string;
  /** The indentation depth (0 = top level) */
  depth: number;
  /** Optional stage name this entry belongs to */
  stageName?: string;
  /** For step entries: the step number within the stage */
  stepNumber?: number;
}

/**
 * Options for building combined narrative.
 */
export interface CombinedNarrativeOptions {
  /** Whether to include step numbers (default: true) */
  includeStepNumbers?: boolean;
  /** Whether to include value summaries (default: true) */
  includeValues?: boolean;
  /** Indent string for nested entries (default: '  ') */
  indent?: string;
}

// ============================================================================
// CombinedNarrativeBuilder
// ============================================================================

/**
 * Builds a unified narrative that combines flow-level sentences with
 * step-level scope operations and condition outcomes.
 *
 * @example
 * ```typescript
 * const flowSentences = narrativeGenerator.getSentences();
 * const recorder = narrativeRecorder;
 *
 * const builder = new CombinedNarrativeBuilder();
 * const combined = builder.build(flowSentences, recorder);
 *
 * for (const line of combined) {
 *   console.log(line);
 * }
 * // Stage 1: "Receive Application"
 * //   Step 1: Write applicantName = "Bob"
 * //   Step 2: Write annualIncome = 42000
 * // Stage 2: "Pull Credit Report"
 * //   Step 1: Read rawCreditScore = 580
 * //   Step 2: Write creditTier = "poor"
 * // [Condition]: risk tier is high → chose "Reject Application"
 * ```
 */
export class CombinedNarrativeBuilder {
  private options: Required<CombinedNarrativeOptions>;

  constructor(options?: CombinedNarrativeOptions) {
    this.options = {
      includeStepNumbers: options?.includeStepNumbers ?? true,
      includeValues: options?.includeValues ?? true,
      indent: options?.indent ?? '  ',
    };
  }

  /**
   * Builds a combined narrative from flow sentences and scope operation data.
   *
   * @param flowSentences - Sentences from NarrativeGenerator.getSentences()
   * @param recorder - The NarrativeRecorder with per-stage operation data
   * @returns Array of structured narrative entries
   */
  buildEntries(flowSentences: string[], recorder: NarrativeRecorder): CombinedNarrativeEntry[] {
    const entries: CombinedNarrativeEntry[] = [];
    const stageData = recorder.getStageData();
    const usedStages = new Set<string>();
    let stageCounter = 0;

    for (const sentence of flowSentences) {
      const parsed = this.parseSentence(sentence);

      if (parsed.type === 'stage') {
        stageCounter++;
        entries.push({
          type: 'stage',
          text: `Stage ${stageCounter}: ${sentence}`,
          depth: 0,
          stageName: parsed.stageName,
        });

        // Add step-level operations for this stage
        if (parsed.stageName) {
          const data = this.findStageData(parsed.stageName, stageData);
          if (data) {
            usedStages.add(data.stageName);
            this.addStepEntries(entries, data);
          }
        }
      } else if (parsed.type === 'condition') {
        entries.push({
          type: 'condition',
          text: `[Condition]: ${sentence}`,
          depth: 0,
        });

        // Add steps for the chosen branch if available
        if (parsed.stageName) {
          const data = this.findStageData(parsed.stageName, stageData);
          if (data) {
            usedStages.add(data.stageName);
            this.addStepEntries(entries, data);
          }
        }
      } else if (parsed.type === 'fork') {
        entries.push({
          type: 'fork',
          text: `[Parallel]: ${sentence}`,
          depth: 0,
        });
      } else if (parsed.type === 'subflow') {
        entries.push({
          type: 'subflow',
          text: sentence,
          depth: 0,
        });
      } else if (parsed.type === 'loop') {
        entries.push({
          type: 'loop',
          text: sentence,
          depth: 0,
        });
      } else if (parsed.type === 'break') {
        entries.push({
          type: 'break',
          text: sentence,
          depth: 0,
        });
      } else if (parsed.type === 'error') {
        entries.push({
          type: 'error',
          text: `[Error]: ${sentence}`,
          depth: 0,
        });
      }
    }

    // Add any stages that had operations but weren't referenced in flow sentences
    for (const [stageName, data] of stageData) {
      if (!usedStages.has(stageName) && data.operations.length > 0) {
        stageCounter++;
        entries.push({
          type: 'stage',
          text: `Stage ${stageCounter}: ${stageName}`,
          depth: 0,
          stageName,
        });
        this.addStepEntries(entries, data);
      }
    }

    return entries;
  }

  /**
   * Builds a combined narrative and returns it as formatted text lines.
   *
   * @param flowSentences - Sentences from NarrativeGenerator.getSentences()
   * @param recorder - The NarrativeRecorder with per-stage operation data
   * @returns Array of formatted text lines
   */
  build(flowSentences: string[], recorder: NarrativeRecorder): string[] {
    const entries = this.buildEntries(flowSentences, recorder);
    return entries.map((entry) => {
      const indent = this.options.indent.repeat(entry.depth);
      return `${indent}${entry.text}`;
    });
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private addStepEntries(entries: CombinedNarrativeEntry[], data: StageNarrativeData): void {
    for (const op of data.operations) {
      const stepPrefix = this.options.includeStepNumbers && op.stepNumber
        ? `Step ${op.stepNumber}: `
        : '';

      let text: string;
      if (op.type === 'read') {
        text = this.options.includeValues && op.valueSummary
          ? `${stepPrefix}Read ${op.key} = ${op.valueSummary}`
          : `${stepPrefix}Read ${op.key}`;
      } else if (op.operation === 'delete') {
        text = `${stepPrefix}Delete ${op.key}`;
      } else if (op.operation === 'update') {
        text = this.options.includeValues
          ? `${stepPrefix}Update ${op.key} = ${op.valueSummary}`
          : `${stepPrefix}Update ${op.key}`;
      } else {
        text = this.options.includeValues
          ? `${stepPrefix}Write ${op.key} = ${op.valueSummary}`
          : `${stepPrefix}Write ${op.key}`;
      }

      entries.push({
        type: 'step',
        text,
        depth: 1,
        stageName: data.stageName,
        stepNumber: op.stepNumber,
      });
    }
  }

  /**
   * Finds stage data by name, with fuzzy matching for display names.
   */
  private findStageData(
    name: string,
    stageData: Map<string, StageNarrativeData>,
  ): StageNarrativeData | undefined {
    // Direct match
    if (stageData.has(name)) return stageData.get(name);

    // Fuzzy match: check if any stage name contains the search name or vice versa
    for (const [stageName, data] of stageData) {
      if (
        stageName.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(stageName.toLowerCase())
      ) {
        return data;
      }
    }

    return undefined;
  }

  /**
   * Parses a NarrativeGenerator sentence to determine its type and extract stage name.
   */
  private parseSentence(sentence: string): { type: string; stageName?: string } {
    // "The process began: {description}." or "The process began with {name}."
    if (sentence.startsWith('The process began')) {
      const match = sentence.match(/The process began(?:: (.+)| with (.+))\./);
      const stageName = match?.[2]?.trim();
      return { type: 'stage', stageName };
    }

    // "Next step: {description}." or "Next, it moved on to {name}."
    if (sentence.startsWith('Next')) {
      const match = sentence.match(/Next(?:,? it moved on to (.+)| step: (.+))\./);
      const stageName = match?.[1]?.trim();
      return { type: 'stage', stageName };
    }

    // Decision sentences
    if (sentence.includes('decision was made') || sentence.includes('it chose') || sentence.includes('so it chose')) {
      const match = sentence.match(/chose (.+)\./);
      const stageName = match?.[1]?.trim();
      return { type: 'condition', stageName };
    }

    // "It {description}: {rationale}, so it chose {branch}."
    if (sentence.startsWith('It ') && sentence.includes('chose')) {
      const match = sentence.match(/chose (.+)\./);
      const stageName = match?.[1]?.trim();
      return { type: 'condition', stageName };
    }

    // Fork
    if (sentence.includes('paths were executed in parallel') || sentence.includes('paths were selected')) {
      return { type: 'fork' };
    }

    // Subflow
    if (sentence.startsWith('Entering') || sentence.startsWith('Exiting')) {
      return { type: 'subflow' };
    }

    // Loop
    if (sentence.startsWith('On pass')) {
      return { type: 'loop' };
    }

    // Break
    if (sentence.startsWith('Execution stopped')) {
      return { type: 'break' };
    }

    // Error
    if (sentence.startsWith('An error occurred')) {
      return { type: 'error' };
    }

    // Default — treat as a stage
    return { type: 'stage' };
  }
}
