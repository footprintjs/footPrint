import { type SubflowCapturePort, subflowCaptureFor } from '../capture/subflowCapability.js';
import { canServeRetainedChild, childEvidencePolicy } from '../engine/handlers/childEvidencePolicy.js';
import { servedSubflowResults } from '../engine/handlers/servedSubflowResults.js';
import type { SubflowResult } from '../engine/types.js';
import type { ExecutionRuntime } from './ExecutionRuntime.js';

interface ChildArchive {
  readonly entries: Map<string, SubflowResult>;
  policy: string;
  capture: SubflowCapturePort | undefined;
  withheld: boolean;
}

const archives = new WeakMap<ExecutionRuntime, ChildArchive>();

function admitArchive(runtime: ExecutionRuntime, create = false): ChildArchive | undefined {
  const prior = archives.get(runtime);
  if (!prior && !create) return undefined;

  const settings = runtime.rootStageContext.getPolicy();
  const policy = childEvidencePolicy(settings.redaction);
  const capture = subflowCaptureFor(settings);
  if (prior) {
    if (prior.policy !== policy || prior.capture !== capture) {
      prior.withheld ||= prior.entries.size !== 0;
      prior.entries.clear();
      prior.policy = policy;
      prior.capture = capture;
    }
    return prior;
  }

  const archive = { entries: new Map<string, SubflowResult>(), policy, capture, withheld: false };
  archives.set(runtime, archive);
  return archive;
}

/** Only the executor's latest-pause reuse path can move child evidence between legs. */
export function retainChildEvidence(runtime: ExecutionRuntime, settled?: ReadonlyMap<string, SubflowResult>): void {
  const archive = admitArchive(runtime, Boolean(settled?.size));
  if (!archive || !settled) return;
  for (const [key, result] of settled) {
    if (canServeRetainedChild(result, archive.policy, archive.capture)) {
      archive.entries.set(key, result);
    } else {
      archive.entries.delete(key);
      archive.withheld = true;
    }
  }
}

export function readRetainedChildren(runtime: ExecutionRuntime) {
  const archive = admitArchive(runtime);
  if (!archive) return undefined;
  return {
    // Historical evidence always uses its retained projection, even in a plain snapshot.
    results: servedSubflowResults(
      archive.entries,
      true,
      archive.capture,
      runtime.rootStageContext.getPolicy().redaction,
      runtime.capture?.explanation !== undefined,
      true,
    ),
    withheld: archive.withheld,
  };
}
