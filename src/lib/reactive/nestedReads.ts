/** Opt-in, path-aware member observation; execution still follows the existing live-view law. */
export type MemberReader = (path: readonly string[], parent: object) => unknown;

/**
 * Only a current own DATA path may be re-read through the tracked port. Walking
 * descriptors avoids invoking accessors while validating that path. A held
 * proxy whose path disappeared keeps answering its captured object, without
 * pretending those values came from current state. Undefined members stay raw:
 * a path-aware scope read may fall back to a root value the member expression
 * did not read. No sibling scan is needed.
 */
export function memberReader(
  currentRoot: () => unknown,
  rootKey: string,
  read: (segments: readonly string[]) => unknown,
): MemberReader {
  return (path, parent) => {
    const key = path[path.length - 1];
    let current = currentRoot();
    for (const segment of path.slice(0, -1)) {
      if (current === null || typeof current !== 'object') break;
      const descriptor = Object.getOwnPropertyDescriptor(current, segment);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        current = undefined;
        break;
      }
      current = descriptor.value;
    }
    const descriptor = Object.getOwnPropertyDescriptor(parent, key);
    return current === parent &&
      descriptor &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
      descriptor.value !== undefined
      ? read([rootKey, ...path])
      : (parent as Record<string, unknown>)[key];
  };
}
