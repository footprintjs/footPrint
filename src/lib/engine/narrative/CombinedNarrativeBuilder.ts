/**
 * CombinedNarrativeBuilder — Merges flow-level narrative with data-level operations.
 *
 * ControlFlowNarrativeGenerator captures FLOW — what stages ran, which branches were taken.
 * NarrativeRecorder (scope/) captures DATA — what values were read, written, updated.
 *
 * This builder weaves both into a single unified narrative:
 *   Stage 1: "Receive Application"
 *     Step 1: Write applicantName = 'Bob'
 *   [Condition]: risk tier is high → chose "Reject Application"
 */

import type { NarrativeRecorder, StageNarrativeData } from '../../scope/recorders/NarrativeRecorder';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CombinedNarrativeEntry {
  type: 'stage' | 'step' | 'condition' | 'fork' | 'subflow' | 'loop' | 'break' | 'error';
  text: string;
  depth: number;
  stageName?: string;
  stepNumber?: number;
}

export interface CombinedNarrativeOptions {
  includeStepNumbers?: boolean;
  includeValues?: boolean;
  indent?: string;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class CombinedNarrativeBuilder {
  private options: Required<CombinedNarrativeOptions>;

  constructor(options?: CombinedNarrativeOptions) {
    this.options = {
      includeStepNumbers: options?.includeStepNumbers ?? true,
      includeValues: options?.includeValues ?? true,
      indent: options?.indent ?? '  ',
    };
  }

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
        if (parsed.stageName) {
          const data = this.findStageData(parsed.stageName, stageData);
          if (data) {
            usedStages.add(data.stageName);
            this.addStepEntries(entries, data);
          }
        }
      } else if (parsed.type === 'condition') {
        entries.push({ type: 'condition', text: `[Condition]: ${sentence}`, depth: 0 });
        if (parsed.stageName) {
          const data = this.findStageData(parsed.stageName, stageData);
          if (data) {
            usedStages.add(data.stageName);
            this.addStepEntries(entries, data);
          }
        }
      } else if (parsed.type === 'fork') {
        entries.push({ type: 'fork', text: `[Parallel]: ${sentence}`, depth: 0 });
      } else if (parsed.type === 'subflow') {
        entries.push({ type: 'subflow', text: sentence, depth: 0 });
      } else if (parsed.type === 'loop') {
        entries.push({ type: 'loop', text: sentence, depth: 0 });
      } else if (parsed.type === 'break') {
        entries.push({ type: 'break', text: sentence, depth: 0 });
      } else if (parsed.type === 'error') {
        entries.push({ type: 'error', text: `[Error]: ${sentence}`, depth: 0 });
      }
    }

    // Add stages with operations that weren't referenced in flow sentences
    for (const [stageName, data] of Array.from(stageData.entries())) {
      if (!usedStages.has(stageName) && data.operations.length > 0) {
        stageCounter++;
        entries.push({ type: 'stage', text: `Stage ${stageCounter}: ${stageName}`, depth: 0, stageName });
        this.addStepEntries(entries, data);
      }
    }

    return entries;
  }

  build(flowSentences: string[], recorder: NarrativeRecorder): string[] {
    return this.buildEntries(flowSentences, recorder).map((entry) => {
      const indent = this.options.indent.repeat(entry.depth);
      return `${indent}${entry.text}`;
    });
  }

  // ── Private helpers ──

  private addStepEntries(entries: CombinedNarrativeEntry[], data: StageNarrativeData): void {
    for (const op of data.operations) {
      const stepPrefix = this.options.includeStepNumbers && op.stepNumber ? `Step ${op.stepNumber}: ` : '';

      let text: string;
      if (op.type === 'read') {
        text =
          this.options.includeValues && op.valueSummary
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

      entries.push({ type: 'step', text, depth: 1, stageName: data.stageName, stepNumber: op.stepNumber });
    }
  }

  private findStageData(name: string, stageData: Map<string, StageNarrativeData>): StageNarrativeData | undefined {
    if (stageData.has(name)) return stageData.get(name);
    for (const [stageName, data] of Array.from(stageData.entries())) {
      if (
        stageName.toLowerCase().includes(name.toLowerCase()) ||
        name.toLowerCase().includes(stageName.toLowerCase())
      ) {
        return data;
      }
    }
    return undefined;
  }

  private parseSentence(sentence: string): { type: string; stageName?: string } {
    if (sentence.startsWith('The process began')) {
      const match = sentence.match(/The process began(?:: (.+)| with (.+))\./);
      return { type: 'stage', stageName: match?.[2]?.trim() };
    }
    if (sentence.startsWith('Next')) {
      const match = sentence.match(/Next(?:,? it moved on to (.+)| step: (.+))\./);
      return { type: 'stage', stageName: match?.[1]?.trim() };
    }
    if (sentence.includes('decision was made') || sentence.includes('it chose') || sentence.includes('so it chose')) {
      const match = sentence.match(/chose (.+)\./);
      return { type: 'condition', stageName: match?.[1]?.trim() };
    }
    if (sentence.startsWith('It ') && sentence.includes('chose')) {
      const match = sentence.match(/chose (.+)\./);
      return { type: 'condition', stageName: match?.[1]?.trim() };
    }
    if (sentence.includes('paths were executed in parallel') || sentence.includes('paths were selected'))
      return { type: 'fork' };
    if (sentence.startsWith('Entering') || sentence.startsWith('Exiting')) return { type: 'subflow' };
    if (sentence.startsWith('On pass')) return { type: 'loop' };
    if (sentence.startsWith('Execution stopped')) return { type: 'break' };
    if (sentence.startsWith('An error occurred')) return { type: 'error' };
    return { type: 'stage' };
  }
}
