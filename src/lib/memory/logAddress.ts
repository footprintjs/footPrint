import type { LogAddress } from 'foottrace';

/** One engine address law for a mount's independent native book and its sink log. */
export function childLogAddress(
  parent: LogAddress | undefined,
  mountRuntimeStageId: string | undefined,
): LogAddress | undefined {
  return parent && mountRuntimeStageId
    ? { logRunId: parent.logRunId, drillPath: [...parent.drillPath, mountRuntimeStageId] }
    : undefined;
}
