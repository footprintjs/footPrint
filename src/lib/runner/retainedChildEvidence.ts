import { type SubflowCapturePort, subflowCaptureFor } from '../capture/subflowCapability.js';
import { canServeRetainedChild, servedSubflowResults } from '../engine/handlers/servedSubflowResults.js';
import type { FlowchartTraverser } from '../engine/traversal/FlowchartTraverser.js';
import type { StageNode, SubflowResult } from '../engine/types.js';
import { observeRedactionDisclosure } from '../memory/readAuthority/disclosure.js';
import type { RunPolicy } from '../memory/runPolicy.js';
import type { ExecutionRuntime, RuntimeSnapshot } from './ExecutionRuntime.js';

interface ChildArchive {
  readonly entries: Map<string, SubflowResult>;
  policy: string | undefined;
  capture: SubflowCapturePort | undefined;
  withheld: boolean;
}

const archives = new WeakMap<ExecutionRuntime, ChildArchive>();

/** Only the executor's latest-pause reuse path supplies settled results. */
function admitArchive(runtime: ExecutionRuntime, settings: RunPolicy, settled?: ReadonlyMap<string, SubflowResult>) {
  let archive = archives.get(runtime);
  if (!archive && !settled?.size) return undefined;
  const policy = observeRedactionDisclosure(settings.redaction);
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

function projectRetainedChildren(archive: ChildArchive, settings: RunPolicy, explain: boolean) {
  // Historical evidence always uses its retained projection, even in a plain snapshot.
  return servedSubflowResults(archive.entries, true, archive.capture, settings.redaction, explain, true);
}

export function snapshotChildResults(
  snapshot: RuntimeSnapshot,
  traverser: Pick<FlowchartTraverser, 'getRuntime' | 'getSubflowResults'>,
  redact: boolean,
): void {
  const runtime = traverser.getRuntime() as ExecutionRuntime;
  const settings = runtime.rootStageContext.getPolicy();
  const archive = admitArchive(runtime, settings);
  const current = traverser.getSubflowResults();
  const explain = runtime.capture?.explanation !== undefined;
  if (archive?.withheld) snapshot.subflowEvidenceGap = 'retained-child-evidence-withheld';
  if (archive?.entries.size) snapshot.subflowResults = projectRetainedChildren(archive, settings, explain);
  if (current.size) {
    snapshot.subflowResults = {
      ...snapshot.subflowResults,
      ...servedSubflowResults(current, redact, subflowCaptureFor(settings), settings.redaction, explain),
    };
  }
}

/** Resume the old tree at its leaf while starting a fresh execution map for the new leg. */
export function continueRuntime(
  runtime: ExecutionRuntime,
  settled: ReadonlyMap<string, SubflowResult>,
  root: StageNode,
  policy: RunPolicy,
  runId: string,
): ExecutionRuntime {
  admitArchive(runtime, runtime.rootStageContext.getPolicy(), settled);
  runtime.preserveSnapshotRoot();
  let leaf = runtime.rootStageContext;
  while (leaf.next) leaf = leaf.next;
  runtime.rootStageContext = leaf.createNext('', root.name, root.id);
  runtime.usePolicy(policy);
  admitArchive(runtime, policy);
  runtime.resumeReadSources(runId);
  return runtime;
}

export function inspectChildResults(traverser: Pick<FlowchartTraverser, 'getRuntime' | 'getSubflowResults'>) {
  const current = traverser.getSubflowResults();
  const runtime = traverser.getRuntime() as ExecutionRuntime;
  const settings = runtime.rootStageContext.getPolicy();
  const archive = admitArchive(runtime, settings);
  if (!archive) return current;
  const retained = projectRetainedChildren(archive, settings, runtime.capture?.explanation !== undefined);
  return new Map([...Object.entries(retained), ...current]);
}
