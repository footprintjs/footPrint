/**
 * Historical byte references predate source positions. Remove only the new
 * address at a known subflow-result metadata slot, never by searching payloads
 * for its key. Both snapshot and lean checkpoint results use this exact slot.
 * The root snapshots in these fixtures are already explicitly projected without
 * logAddress; none of these historical fixtures captures emitted events.
 *
 * Keep old references and all other comparison bytes unchanged. A new or
 * malformed address shape fails here rather than silently widening the exception.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertLogAddress(value: unknown): void {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, 'logRunId') ||
    !Object.hasOwn(value, 'drillPath') ||
    typeof value.logRunId !== 'string' ||
    value.logRunId.length === 0 ||
    !Array.isArray(value.drillPath) ||
    value.drillPath.some((id) => typeof id !== 'string' || !/^.+#\d+$/.test(id))
  ) {
    throw new Error('Historical byte view: malformed or changed logAddress');
  }
}

/** Only results[*].treeContext.logAddress is an admitted additive field. */
export function withoutSubflowLogAddresses(
  results: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (results === null || results === undefined) return results;
  return Object.fromEntries(
    Object.entries(results).map(([key, result]) => {
      if (!isRecord(result) || !isRecord(result.treeContext) || !Object.hasOwn(result.treeContext, 'logAddress')) {
        return [key, result];
      }
      assertLogAddress(result.treeContext.logAddress);
      const treeContext = { ...result.treeContext };
      delete treeContext.logAddress;
      return [key, { ...result, treeContext }];
    }),
  );
}
