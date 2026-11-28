import { type SubflowCapturePort, subflowCaptureFor } from '../capture/subflowCapability.js';
import { canServeRetainedChild, childEvidencePolicy } from '../engine/handlers/childEvidencePolicy.js';
import { servedSubflowResults } from '../engine/handlers/servedSubflowResults.js';
import type { FlowchartTraverser } from '../engine/traversal/FlowchartTraverser.js';
import type { StageNode, SubflowResult } from '../engine/types.js';
import type { RunPolicy } from '../memory/runPolicy.js';
import type { ExecutionRuntime } from './ExecutionRuntime.js';

interface ChildArchive {
  readonly entries: Map<string, SubflowResult>;
  policy: string | object;
  capture: SubflowCapturePort | undefined;
  withheld: boolean;
}

const archives = new WeakMap<ExecutionRuntime, ChildArchive>();

/** Only the executor's latest-pause reuse path supplies settled results. */
function admitArchive(runtime: ExecutionRuntime, settled?: ReadonlyMap<string, SubflowResult>) {
  let archive = archives.get(runtime);
  if (!archive && !settled?.size) return undefined;
  const settings = runtime.rootStageContext.getPolicy();
  const policy = childEvidencePolicy(settings.redaction);
  const capture = subflowCaptureFor(settings);
  if (!archive || archive.policy !== policy || archive.capture !== capture) {
    archive = {
      entries: new Map(),
      policy,
      capture,
      withheld: Boolean(archive?.withheld || archive?.entries.size),
    };
    archives.set(runtime, archive);
  }
  for (const [key, result] of settled ?? []) {
    if (canServeRetainedChild(result, policy, capture)) {
      archive.entries.set(key, result);
    } else {
      archive.entries.delete(key);
      archive.withheld = true;
    }
  }
  return archive;
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

/** Resume the old tree at its leaf while starting a fresh execution map for the new leg. */
export function continueRuntime(
  runtime: ExecutionRuntime,
  settled: ReadonlyMap<string, SubflowResult>,
  root: StageNode,
  policy: RunPolicy,
  runId: string,
): ExecutionRuntime {
  admitArchive(runtime, settled);
  runtime.preserveSnapshotRoot();
  let leaf = runtime.rootStageContext;
  while (leaf.next) leaf = leaf.next;
  runtime.rootStageContext = leaf.createNext('', root.name, root.id);
  runtime.usePolicy(policy);
  admitArchive(runtime);
  runtime.resumeReadSources(runId);
  return runtime;
}

export function inspectChildResults(traverser: Pick<FlowchartTraverser, 'getRuntime' | 'getSubflowResults'>) {
  const current = traverser.getSubflowResults();
  const retained = readRetainedChildren(traverser.getRuntime() as ExecutionRuntime);
  return retained ? new Map([...Object.entries(retained.results), ...current]) : current;
}
