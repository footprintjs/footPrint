/**
 * NarrativeRecorder — Captures per-stage scope reads/writes for narrative enrichment
 *
 * Bridges the gap between flow-level narrative (NarrativeGenerator) and data-level
 * detail. Produces structured per-stage data and text sentences that can be merged
 * with NarrativeGenerator output for the full picture: what happened AND what was produced.
 */

import type { ReadEvent, Recorder, WriteEvent } from '../types';

export type NarrativeDetail = 'summary' | 'full';

export interface NarrativeOperation {
  type: 'read' | 'write';
  key: string;
  valueSummary: string;
  operation?: 'set' | 'update' | 'delete';
  stepNumber?: number;
}

export interface StageNarrativeData {
  stageName: string;
  reads: NarrativeOperation[];
  writes: NarrativeOperation[];
  operations: NarrativeOperation[];
}

export interface NarrativeRecorderOptions {
  id?: string;
  detail?: NarrativeDetail;
  maxValueLength?: number;
}

export class NarrativeRecorder implements Recorder {
  readonly id: string;
  private stages: Map<string, StageNarrativeData> = new Map();
  private stageOrder: string[] = [];
  private detail: NarrativeDetail;
  private maxValueLength: number;

  constructor(options?: NarrativeRecorderOptions) {
    this.id = options?.id ?? `narrative-recorder-${Date.now()}`;
    this.detail = options?.detail ?? 'full';
    this.maxValueLength = options?.maxValueLength ?? 80;
  }

  onRead(event: ReadEvent): void {
    const stageData = this.getOrCreateStageData(event.stageName);
    const op: NarrativeOperation = {
      type: 'read',
      key: event.key ?? '',
      valueSummary: summarizeValue(event.value, this.maxValueLength),
      stepNumber: stageData.operations.length + 1,
    };
    stageData.reads.push(op);
    stageData.operations.push(op);
  }

  onWrite(event: WriteEvent): void {
    const stageData = this.getOrCreateStageData(event.stageName);
    const op: NarrativeOperation = {
      type: 'write',
      key: event.key,
      valueSummary: summarizeValue(event.value, this.maxValueLength),
      operation: event.operation,
      stepNumber: stageData.operations.length + 1,
    };
    stageData.writes.push(op);
    stageData.operations.push(op);
  }

  getStageData(): Map<string, StageNarrativeData> {
    const copy = new Map<string, StageNarrativeData>();
    for (const [name, data] of this.stages) {
      copy.set(name, {
        stageName: data.stageName,
        reads: [...data.reads],
        writes: [...data.writes],
        operations: [...data.operations],
      });
    }
    return copy;
  }

  getStageDataFor(stageName: string): StageNarrativeData | undefined {
    const data = this.stages.get(stageName);
    if (!data) return undefined;
    return {
      stageName: data.stageName,
      reads: [...data.reads],
      writes: [...data.writes],
      operations: [...data.operations],
    };
  }

  toSentences(): Map<string, string[]> {
    const result = new Map<string, string[]>();

    for (const stageName of this.stageOrder) {
      const data = this.stages.get(stageName);
      if (!data) continue;

      const lines: string[] = [];

      if (this.detail === 'summary') {
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
        for (const op of data.operations) {
          const stepPrefix = op.stepNumber ? `Step ${op.stepNumber}: ` : '';
          if (op.type === 'read') {
            lines.push(
              op.valueSummary
                ? `  - ${stepPrefix}Read: ${op.key} = ${op.valueSummary}`
                : `  - ${stepPrefix}Read: ${op.key}`,
            );
          } else if (op.operation === 'delete') {
            lines.push(`  - ${stepPrefix}Delete: ${op.key}`);
          } else if (op.operation === 'update') {
            lines.push(`  - ${stepPrefix}Update: ${op.key} = ${op.valueSummary}`);
          } else {
            lines.push(`  - ${stepPrefix}Write: ${op.key} = ${op.valueSummary}`);
          }
        }
      }

      if (lines.length > 0) {
        result.set(stageName, lines);
      }
    }

    return result;
  }

  toFlatSentences(): string[] {
    const result: string[] = [];
    const perStage = this.toSentences();
    for (const [stageName, lines] of perStage) {
      for (const line of lines) {
        const cleaned = line.replace(/^\s+-\s+/, '');
        result.push(`${stageName}: ${cleaned}`);
      }
    }
    return result;
  }

  clear(): void {
    this.stages.clear();
    this.stageOrder = [];
  }

  setDetail(level: NarrativeDetail): void {
    this.detail = level;
  }

  getDetail(): NarrativeDetail {
    return this.detail;
  }

  private getOrCreateStageData(stageName: string): StageNarrativeData {
    let data = this.stages.get(stageName);
    if (!data) {
      data = { stageName, reads: [], writes: [], operations: [] };
      this.stages.set(stageName, data);
      this.stageOrder.push(stageName);
    }
    return data;
  }
}

// ── Private Helpers ──────────────────────────────────────────────────────────

function summarizeValue(value: unknown, maxLen: number): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.length <= maxLen ? `"${value}"` : `"${value.slice(0, maxLen - 3)}..."`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `(${value.length} item${value.length > 1 ? 's' : ''})`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return '{}';
    const preview = keys.slice(0, 4).join(', ');
    const suffix = keys.length > 4 ? `, ... (${keys.length} keys)` : '';
    const result = `{${preview}${suffix}}`;
    return result.length <= maxLen ? result : `{${keys.length} keys}`;
  }
  return String(value);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}
