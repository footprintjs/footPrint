import { historyData } from './historyData.js';
import type { CaptureHistoryReceipt, CaptureHistoryTarget } from './historyTypes.js';

/** @internal Bounded own-data root identity. Does not execute stored accessors. */
export function copyHistoryTarget(value: unknown): CaptureHistoryTarget | undefined {
  try {
    const evidenceId = historyData(value, 'evidenceId');
    const runId = historyData(value, 'runId');
    const digest = historyData(value, 'digest');
    const address = historyData(value, 'logAddress');
    const logRunId = historyData(address, 'logRunId');
    const drillPath = historyData(address, 'drillPath');
    const commits = historyData(value, 'commits');
    const from = historyData(commits, 'from');
    const to = historyData(commits, 'to');
    if (
      historyData(value, 'version') !== 1 ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      ![evidenceId, runId, logRunId].every((v) => typeof v === 'string' && v.length > 0 && v.length <= 2048) ||
      !Array.isArray(drillPath) ||
      Object.getPrototypeOf(drillPath) !== Array.prototype ||
      Object.getOwnPropertyDescriptor(drillPath, 'length')?.value !== 0 ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      (from as number) < 0 ||
      (to as number) < (from as number)
    )
      return undefined;
    return Object.freeze({
      version: 1,
      evidenceId: evidenceId as string,
      runId: runId as string,
      digest,
      logAddress: Object.freeze({ logRunId: logRunId as string, drillPath: Object.freeze([]) }),
      commits: Object.freeze({ from: from as number, to: to as number }),
    });
  } catch {
    return undefined;
  }
}

/** @internal Fixed fields only; an adapter cannot leak its additional receipt data into saved metadata. */
export function copyHistoryReceipt(value: unknown, target: CaptureHistoryTarget): CaptureHistoryReceipt | undefined {
  try {
    const copied = copyHistoryTarget(value);
    if (!copied || historyData(value, 'durability') !== 'durable' || JSON.stringify(copied) !== JSON.stringify(target))
      return undefined;
    return Object.freeze({ ...copied, durability: 'durable' });
  } catch {
    return undefined;
  }
}
