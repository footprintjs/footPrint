import type { CaptureHistoryReceipt, CaptureHistoryTarget } from './historyTypes.js';
import { captureIdentifier, copyIdentity, ownData } from './noteShape.js';

/** @internal Bounded own-data root identity. Does not execute stored accessors. */
export function copyHistoryTarget(value: unknown): CaptureHistoryTarget | undefined {
  try {
    const identity = copyIdentity(value);
    const evidenceId = ownData(value, 'evidenceId');
    const digest = ownData(value, 'digest');
    if (!identity || !captureIdentifier(evidenceId) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
      return undefined;
    return Object.freeze({
      version: 1,
      evidenceId,
      runId: identity.runId,
      digest,
      logAddress: identity.logAddress,
      commits: identity.commits,
    });
  } catch {
    return undefined;
  }
}

/** @internal Fixed fields only; an adapter cannot leak its additional receipt data into saved metadata. */
export function copyHistoryReceipt(value: unknown, target: CaptureHistoryTarget): CaptureHistoryReceipt | undefined {
  try {
    const copied = copyHistoryTarget(value);
    if (!copied || ownData(value, 'durability') !== 'durable' || JSON.stringify(copied) !== JSON.stringify(target))
      return undefined;
    return Object.freeze({ ...copied, durability: 'durable' });
  } catch {
    return undefined;
  }
}
