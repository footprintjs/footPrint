/**
 * Runs a chart under a policy and collects every surface a decision's evidence reaches: live flow events, the
 * narrative, the redacted recorder rows, and the record on disk through `fileSink` (including `capture-history`).
 *
 * A check of "the secret is absent" means nothing if the surface was empty, so `capture` proves the
 * `capture-history` note was written and holds the control rows.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RedactionPolicy } from '../../../../src/index.js';
import { FlowChartExecutor } from '../../../../src/index.js';
import { fileSink, readRecordFile } from '../../../../src/sinks.js';
import { controlDepRecorder, readStoredCapture } from '../../../../src/trace.js';

export interface EvidenceSurfaces {
  /** The evidence objects `onDecision` / `onSelected` were handed, in order. */
  readonly evidence: readonly any[];
  /** Every `onBreak` event's reason, in order. */
  readonly reasons: readonly unknown[];
  readonly live: string;
  readonly narrative: string;
  readonly recorders: string;
  readonly disk: string;
  /** The `capture-history` note's text: empty if the run wrote none. */
  readonly capture: string;
  /** What the public stored-capture reader says about the file: a marker must not cost a reader the note. */
  readonly storedStatus: string;
}

export async function evidenceSurfaces(
  chart: any,
  policy: RedactionPolicy | undefined,
  input?: unknown,
): Promise<EvidenceSurfaces> {
  const directory = mkdtempSync(join(tmpdir(), 'fp-evidence-'));
  const file = join(directory, 'record.jsonl');
  const sink = fileSink(file);
  try {
    const executor = new FlowChartExecutor(chart, { captureCoverage: true, sink: { adapter: sink, capture: sink } });
    if (policy) executor.setRedactionPolicy(policy);
    executor.enableNarrative();
    executor.attachFlowRecorder(controlDepRecorder({ captureCoverage: true }));
    const evidence: any[] = [];
    const reasons: unknown[] = [];
    executor.attachFlowRecorder({
      id: 'evidence-surfaces',
      onDecision: (event: any) => {
        evidence.push(event.evidence);
      },
      onSelected: (event: any) => {
        // A selector that selected nothing fires this with no evidence.
        if (event.evidence) evidence.push(event.evidence);
      },
      onBreak: (event: any) => {
        reasons.push(event.reason);
      },
    });
    await executor.run(input === undefined ? undefined : { input });
    const narrative = JSON.stringify(executor.getNarrativeEntries().map((entry) => entry.text));
    const recorders = JSON.stringify(executor.getSnapshot({ redact: true }).recorders);
    const runId = executor.getSnapshot().runId;
    await sink.close();
    const disk = readFileSync(file, 'utf8');
    const stored = await readStoredCapture(readRecordFile(file).entries, { runId });
    const capture = disk.split('\n').filter((line) => line.includes('"capture-history"'));
    return {
      evidence,
      reasons,
      live: JSON.stringify({ evidence, reasons }),
      narrative,
      recorders,
      disk,
      capture: capture.join('\n'),
      storedStatus: stored.status,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The names of the surfaces that hold `secret`. Empty is the law. */
export function surfacesHolding(surfaces: EvidenceSurfaces, secret: string): string[] {
  const named: Array<[string, string]> = [
    ['live events', surfaces.live],
    ['narrative', surfaces.narrative],
    ['redacted recorders', surfaces.recorders],
    ['capture-history on disk', surfaces.capture],
    ['record on disk', surfaces.disk],
  ];
  return named.filter(([, text]) => text.includes(secret)).map(([name]) => name);
}

/** Every condition of every filter rule in the evidence a surface collected. */
export function conditionsOf(surfaces: EvidenceSurfaces): any[] {
  return surfaces.evidence.flatMap((evidence) => evidence.rules.flatMap((rule: any) => rule.conditions ?? []));
}
