/**
 * selectionProblem — what a selector's refused answer got wrong, for its error message.
 *
 * A selection is refused when an id names no child or names one child twice.
 * The unknown ids are named first; with none, the ids named more than once.
 * Used by `SelectorHandler · handleScopeBased` and
 * `ChildrenExecutor · executeSelectedChildren`.
 */
export function selectionProblem(selectedIds: readonly unknown[], unknownIds: readonly unknown[]): string {
  if (unknownIds.length > 0) return `unknown child IDs: ${unknownIds.join(', ')}`;
  const duplicated = new Set(selectedIds.filter((id, index) => selectedIds.indexOf(id) !== index));
  return `duplicate child IDs: ${[...duplicated].join(', ')}`;
}
