import { findLastWriterWithBasis, findUnchangedWrites } from 'foottrace';
import { createRecordGraph, explain, recordScopesFromSnapshot } from 'foottrace/cause';

/** Explain the final recorded value of one key in a saved FootPrint root snapshot. */
export async function inspectSnapshotKey(snapshot, key, sourceLinks) {
  const { scopes, gaps: projectionGaps } = recordScopesFromSnapshot(snapshot);
  const root = scopes.find((scope) => scope.address.drillPath.length === 0);
  const report = {
    key,
    projectionGaps,
    writer: null,
    unchangedWrites: null,
    walk: null,
    sourceLinks: { status: 'not-queried' },
  };
  if (!root) return report;

  const { writer, basis } = findLastWriterWithBasis(root.commitLog, key);
  report.writerBasis = basis;
  report.unchangedWrites = findUnchangedWrites(
    {
      commitLog: root.commitLog,
      executionTree: snapshot.executionTree,
      runId: snapshot.runId,
      logAddress: root.address,
    },
    key,
  );
  if (!writer) return report;

  const commitIdx = root.commitLog.indexOf(writer);
  const runtimeStageId = writer.runtimeStageId;
  report.writer = { runtimeStageId, commitIdx };

  // An explicitly supplied inventory applies only to the local snapshot's root.
  // Child scopes still use the normal graph rules and need their own inventory and policy.
  const graph = createRecordGraph(
    scopes.map((scope) => scope === root && sourceLinks !== undefined ? { ...scope, sourceLinks } : scope),
    sourceLinks === undefined ? {} : {
      sourceLinkPolicy: ({ address }) => address.logRunId === root.address.logRunId && address.drillPath.length === 0,
    },
  );
  const nodeId = graph.nodeId(root.address, { runtimeStageId, commitIdx, key });
  const { backward } = await explain(graph, nodeId, { includeBackward: true, impact: { maxCalls: 1 } });
  const { sourceLinks: links = [], sourceLinkGaps: gaps = [], ...walk } = backward;
  report.walk = walk;
  report.sourceLinks = sourceLinks === undefined
    ? { status: 'not-collected' }
    : { status: 'queried', links, gaps };
  return report;
}
