/**
 * NodeResolver — DFS node lookup + subflow reference resolution.
 *
 * Responsibilities:
 * - Find nodes by ID via recursive depth-first search (for back-edge/loop support)
 * - Resolve subflow reference nodes to actual subflow structures
 * - Evaluate deciders to determine next node in branching scenarios
 */
export class NodeResolver {
    constructor(deps, nodeIdMap) {
        this.deps = deps;
        this.nodeIdMap = nodeIdMap !== null && nodeIdMap !== void 0 ? nodeIdMap : new Map();
    }
    /**
     * O(1) node lookup via pre-built ID map.
     * Falls back to DFS from startNode (for dynamic nodes added at runtime
     * or subflow-local lookups that use an explicit startNode).
     */
    findNodeById(nodeId, startNode) {
        // Fast path: O(1) map lookup (only valid for root-level graph, not subflow-local)
        if (!startNode) {
            const mapped = this.nodeIdMap.get(nodeId);
            if (mapped)
                return mapped;
        }
        // Fallback: DFS from startNode (subflow-local or dynamic nodes not in the map)
        return this._dfs(nodeId, startNode !== null && startNode !== void 0 ? startNode : this.deps.root);
    }
    /**
     * DFS search for a node by ID.
     * Used as fallback when the node is not in the pre-built map.
     */
    _dfs(nodeId, node) {
        if (node.id === nodeId)
            return node;
        if (node.children) {
            for (const child of node.children) {
                const found = this._dfs(nodeId, child);
                if (found)
                    return found;
            }
        }
        if (node.next) {
            const found = this._dfs(nodeId, node.next);
            if (found)
                return found;
        }
        return undefined;
    }
    /**
     * Resolve a subflow reference node to its actual structure.
     *
     * Reference nodes are lightweight placeholders (isSubflowRoot but no fn/children).
     * The actual structure lives in the subflows dictionary.
     */
    resolveSubflowReference(node) {
        // Already has structure — not a reference
        if (node.fn || (node.children && node.children.length > 0))
            return node;
        if (!this.deps.subflows)
            return node;
        // Try multiple keys in order of preference
        const keysToTry = [node.subflowId, node.subflowName, node.name].filter(Boolean);
        let subflowDef;
        for (const key of keysToTry) {
            if (this.deps.subflows[key]) {
                subflowDef = this.deps.subflows[key];
                break;
            }
        }
        if (!subflowDef) {
            this.deps.logger.info(`Subflow not found in dictionary for node '${node.name}' (tried keys: ${keysToTry.join(', ')})`);
            return node;
        }
        // Merge reference metadata with actual structure.
        // id comes from the inner root (the actual stage identity for trace matching),
        // not the mount node (which is the subflow entry point in the parent).
        return {
            ...subflowDef.root,
            isSubflowRoot: node.isSubflowRoot,
            subflowId: node.subflowId,
            subflowName: node.subflowName,
            id: subflowDef.root.id || node.id,
            subflowMountOptions: node.subflowMountOptions || subflowDef.root.subflowMountOptions,
        };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTm9kZVJlc29sdmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvaGFuZGxlcnMvTm9kZVJlc29sdmVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7O0dBT0c7QUFNSCxNQUFNLE9BQU8sWUFBWTtJQUd2QixZQUFvQixJQUErQixFQUFFLFNBQWdEO1FBQWpGLFNBQUksR0FBSixJQUFJLENBQTJCO1FBQ2pELElBQUksQ0FBQyxTQUFTLEdBQUcsU0FBUyxhQUFULFNBQVMsY0FBVCxTQUFTLEdBQUksSUFBSSxHQUFHLEVBQUUsQ0FBQztJQUMxQyxDQUFDO0lBRUQ7Ozs7T0FJRztJQUNILFlBQVksQ0FBQyxNQUFjLEVBQUUsU0FBbUM7UUFDOUQsa0ZBQWtGO1FBQ2xGLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUNmLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1lBQzFDLElBQUksTUFBTTtnQkFBRSxPQUFPLE1BQU0sQ0FBQztRQUM1QixDQUFDO1FBRUQsK0VBQStFO1FBQy9FLE9BQU8sSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsU0FBUyxhQUFULFNBQVMsY0FBVCxTQUFTLEdBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUN4RCxDQUFDO0lBRUQ7OztPQUdHO0lBQ0ssSUFBSSxDQUFDLE1BQWMsRUFBRSxJQUE2QjtRQUN4RCxJQUFJLElBQUksQ0FBQyxFQUFFLEtBQUssTUFBTTtZQUFFLE9BQU8sSUFBSSxDQUFDO1FBRXBDLElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQ2xCLEtBQUssTUFBTSxLQUFLLElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO2dCQUNsQyxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxLQUFLLENBQUMsQ0FBQztnQkFDdkMsSUFBSSxLQUFLO29CQUFFLE9BQU8sS0FBSyxDQUFDO1lBQzFCLENBQUM7UUFDSCxDQUFDO1FBRUQsSUFBSSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDZCxNQUFNLEtBQUssR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDM0MsSUFBSSxLQUFLO2dCQUFFLE9BQU8sS0FBSyxDQUFDO1FBQzFCLENBQUM7UUFFRCxPQUFPLFNBQVMsQ0FBQztJQUNuQixDQUFDO0lBRUQ7Ozs7O09BS0c7SUFDSCx1QkFBdUIsQ0FBQyxJQUE2QjtRQUNuRCwwQ0FBMEM7UUFDMUMsSUFBSSxJQUFJLENBQUMsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUM7WUFBRSxPQUFPLElBQUksQ0FBQztRQUV4RSxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFFckMsMkNBQTJDO1FBQzNDLE1BQU0sU0FBUyxHQUFHLENBQUMsSUFBSSxDQUFDLFNBQVMsRUFBRSxJQUFJLENBQUMsV0FBVyxFQUFFLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFhLENBQUM7UUFDNUYsSUFBSSxVQUF5RCxDQUFDO1FBRTlELEtBQUssTUFBTSxHQUFHLElBQUksU0FBUyxFQUFFLENBQUM7WUFDNUIsSUFBSSxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO2dCQUM1QixVQUFVLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQ3JDLE1BQU07WUFDUixDQUFDO1FBQ0gsQ0FBQztRQUVELElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUNoQixJQUFJLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQ25CLDZDQUE2QyxJQUFJLENBQUMsSUFBSSxrQkFBa0IsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUNoRyxDQUFDO1lBQ0YsT0FBTyxJQUFJLENBQUM7UUFDZCxDQUFDO1FBRUQsa0RBQWtEO1FBQ2xELCtFQUErRTtRQUMvRSx1RUFBdUU7UUFDdkUsT0FBTztZQUNMLEdBQUcsVUFBVSxDQUFDLElBQUk7WUFDbEIsYUFBYSxFQUFFLElBQUksQ0FBQyxhQUFhO1lBQ2pDLFNBQVMsRUFBRSxJQUFJLENBQUMsU0FBUztZQUN6QixXQUFXLEVBQUUsSUFBSSxDQUFDLFdBQVc7WUFDN0IsRUFBRSxFQUFFLFVBQVUsQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLElBQUksQ0FBQyxFQUFFO1lBQ2pDLG1CQUFtQixFQUFFLElBQUksQ0FBQyxtQkFBbUIsSUFBSSxVQUFVLENBQUMsSUFBSSxDQUFDLG1CQUFtQjtTQUNyRixDQUFDO0lBQ0osQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBOb2RlUmVzb2x2ZXIg4oCUIERGUyBub2RlIGxvb2t1cCArIHN1YmZsb3cgcmVmZXJlbmNlIHJlc29sdXRpb24uXG4gKlxuICogUmVzcG9uc2liaWxpdGllczpcbiAqIC0gRmluZCBub2RlcyBieSBJRCB2aWEgcmVjdXJzaXZlIGRlcHRoLWZpcnN0IHNlYXJjaCAoZm9yIGJhY2stZWRnZS9sb29wIHN1cHBvcnQpXG4gKiAtIFJlc29sdmUgc3ViZmxvdyByZWZlcmVuY2Ugbm9kZXMgdG8gYWN0dWFsIHN1YmZsb3cgc3RydWN0dXJlc1xuICogLSBFdmFsdWF0ZSBkZWNpZGVycyB0byBkZXRlcm1pbmUgbmV4dCBub2RlIGluIGJyYW5jaGluZyBzY2VuYXJpb3NcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFN0YWdlQ29udGV4dCB9IGZyb20gJy4uLy4uL21lbW9yeS9TdGFnZUNvbnRleHQuanMnO1xuaW1wb3J0IHR5cGUgeyBTdGFnZU5vZGUgfSBmcm9tICcuLi9ncmFwaC9TdGFnZU5vZGUuanMnO1xuaW1wb3J0IHR5cGUgeyBIYW5kbGVyRGVwcyB9IGZyb20gJy4uL3R5cGVzLmpzJztcblxuZXhwb3J0IGNsYXNzIE5vZGVSZXNvbHZlcjxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+IHtcbiAgcHJpdmF0ZSByZWFkb25seSBub2RlSWRNYXA6IE1hcDxzdHJpbmcsIFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+PjtcblxuICBjb25zdHJ1Y3Rvcihwcml2YXRlIGRlcHM6IEhhbmRsZXJEZXBzPFRPdXQsIFRTY29wZT4sIG5vZGVJZE1hcD86IE1hcDxzdHJpbmcsIFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+Pikge1xuICAgIHRoaXMubm9kZUlkTWFwID0gbm9kZUlkTWFwID8/IG5ldyBNYXAoKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBPKDEpIG5vZGUgbG9va3VwIHZpYSBwcmUtYnVpbHQgSUQgbWFwLlxuICAgKiBGYWxscyBiYWNrIHRvIERGUyBmcm9tIHN0YXJ0Tm9kZSAoZm9yIGR5bmFtaWMgbm9kZXMgYWRkZWQgYXQgcnVudGltZVxuICAgKiBvciBzdWJmbG93LWxvY2FsIGxvb2t1cHMgdGhhdCB1c2UgYW4gZXhwbGljaXQgc3RhcnROb2RlKS5cbiAgICovXG4gIGZpbmROb2RlQnlJZChub2RlSWQ6IHN0cmluZywgc3RhcnROb2RlPzogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4pOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB8IHVuZGVmaW5lZCB7XG4gICAgLy8gRmFzdCBwYXRoOiBPKDEpIG1hcCBsb29rdXAgKG9ubHkgdmFsaWQgZm9yIHJvb3QtbGV2ZWwgZ3JhcGgsIG5vdCBzdWJmbG93LWxvY2FsKVxuICAgIGlmICghc3RhcnROb2RlKSB7XG4gICAgICBjb25zdCBtYXBwZWQgPSB0aGlzLm5vZGVJZE1hcC5nZXQobm9kZUlkKTtcbiAgICAgIGlmIChtYXBwZWQpIHJldHVybiBtYXBwZWQ7XG4gICAgfVxuXG4gICAgLy8gRmFsbGJhY2s6IERGUyBmcm9tIHN0YXJ0Tm9kZSAoc3ViZmxvdy1sb2NhbCBvciBkeW5hbWljIG5vZGVzIG5vdCBpbiB0aGUgbWFwKVxuICAgIHJldHVybiB0aGlzLl9kZnMobm9kZUlkLCBzdGFydE5vZGUgPz8gdGhpcy5kZXBzLnJvb3QpO1xuICB9XG5cbiAgLyoqXG4gICAqIERGUyBzZWFyY2ggZm9yIGEgbm9kZSBieSBJRC5cbiAgICogVXNlZCBhcyBmYWxsYmFjayB3aGVuIHRoZSBub2RlIGlzIG5vdCBpbiB0aGUgcHJlLWJ1aWx0IG1hcC5cbiAgICovXG4gIHByaXZhdGUgX2Rmcyhub2RlSWQ6IHN0cmluZywgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4pOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB8IHVuZGVmaW5lZCB7XG4gICAgaWYgKG5vZGUuaWQgPT09IG5vZGVJZCkgcmV0dXJuIG5vZGU7XG5cbiAgICBpZiAobm9kZS5jaGlsZHJlbikge1xuICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLmNoaWxkcmVuKSB7XG4gICAgICAgIGNvbnN0IGZvdW5kID0gdGhpcy5fZGZzKG5vZGVJZCwgY2hpbGQpO1xuICAgICAgICBpZiAoZm91bmQpIHJldHVybiBmb3VuZDtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAobm9kZS5uZXh0KSB7XG4gICAgICBjb25zdCBmb3VuZCA9IHRoaXMuX2Rmcyhub2RlSWQsIG5vZGUubmV4dCk7XG4gICAgICBpZiAoZm91bmQpIHJldHVybiBmb3VuZDtcbiAgICB9XG5cbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlc29sdmUgYSBzdWJmbG93IHJlZmVyZW5jZSBub2RlIHRvIGl0cyBhY3R1YWwgc3RydWN0dXJlLlxuICAgKlxuICAgKiBSZWZlcmVuY2Ugbm9kZXMgYXJlIGxpZ2h0d2VpZ2h0IHBsYWNlaG9sZGVycyAoaXNTdWJmbG93Um9vdCBidXQgbm8gZm4vY2hpbGRyZW4pLlxuICAgKiBUaGUgYWN0dWFsIHN0cnVjdHVyZSBsaXZlcyBpbiB0aGUgc3ViZmxvd3MgZGljdGlvbmFyeS5cbiAgICovXG4gIHJlc29sdmVTdWJmbG93UmVmZXJlbmNlKG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+KTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4ge1xuICAgIC8vIEFscmVhZHkgaGFzIHN0cnVjdHVyZSDigJQgbm90IGEgcmVmZXJlbmNlXG4gICAgaWYgKG5vZGUuZm4gfHwgKG5vZGUuY2hpbGRyZW4gJiYgbm9kZS5jaGlsZHJlbi5sZW5ndGggPiAwKSkgcmV0dXJuIG5vZGU7XG5cbiAgICBpZiAoIXRoaXMuZGVwcy5zdWJmbG93cykgcmV0dXJuIG5vZGU7XG5cbiAgICAvLyBUcnkgbXVsdGlwbGUga2V5cyBpbiBvcmRlciBvZiBwcmVmZXJlbmNlXG4gICAgY29uc3Qga2V5c1RvVHJ5ID0gW25vZGUuc3ViZmxvd0lkLCBub2RlLnN1YmZsb3dOYW1lLCBub2RlLm5hbWVdLmZpbHRlcihCb29sZWFuKSBhcyBzdHJpbmdbXTtcbiAgICBsZXQgc3ViZmxvd0RlZjogeyByb290OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB9IHwgdW5kZWZpbmVkO1xuXG4gICAgZm9yIChjb25zdCBrZXkgb2Yga2V5c1RvVHJ5KSB7XG4gICAgICBpZiAodGhpcy5kZXBzLnN1YmZsb3dzW2tleV0pIHtcbiAgICAgICAgc3ViZmxvd0RlZiA9IHRoaXMuZGVwcy5zdWJmbG93c1trZXldO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoIXN1YmZsb3dEZWYpIHtcbiAgICAgIHRoaXMuZGVwcy5sb2dnZXIuaW5mbyhcbiAgICAgICAgYFN1YmZsb3cgbm90IGZvdW5kIGluIGRpY3Rpb25hcnkgZm9yIG5vZGUgJyR7bm9kZS5uYW1lfScgKHRyaWVkIGtleXM6ICR7a2V5c1RvVHJ5LmpvaW4oJywgJyl9KWAsXG4gICAgICApO1xuICAgICAgcmV0dXJuIG5vZGU7XG4gICAgfVxuXG4gICAgLy8gTWVyZ2UgcmVmZXJlbmNlIG1ldGFkYXRhIHdpdGggYWN0dWFsIHN0cnVjdHVyZS5cbiAgICAvLyBpZCBjb21lcyBmcm9tIHRoZSBpbm5lciByb290ICh0aGUgYWN0dWFsIHN0YWdlIGlkZW50aXR5IGZvciB0cmFjZSBtYXRjaGluZyksXG4gICAgLy8gbm90IHRoZSBtb3VudCBub2RlICh3aGljaCBpcyB0aGUgc3ViZmxvdyBlbnRyeSBwb2ludCBpbiB0aGUgcGFyZW50KS5cbiAgICByZXR1cm4ge1xuICAgICAgLi4uc3ViZmxvd0RlZi5yb290LFxuICAgICAgaXNTdWJmbG93Um9vdDogbm9kZS5pc1N1YmZsb3dSb290LFxuICAgICAgc3ViZmxvd0lkOiBub2RlLnN1YmZsb3dJZCxcbiAgICAgIHN1YmZsb3dOYW1lOiBub2RlLnN1YmZsb3dOYW1lLFxuICAgICAgaWQ6IHN1YmZsb3dEZWYucm9vdC5pZCB8fCBub2RlLmlkLFxuICAgICAgc3ViZmxvd01vdW50T3B0aW9uczogbm9kZS5zdWJmbG93TW91bnRPcHRpb25zIHx8IHN1YmZsb3dEZWYucm9vdC5zdWJmbG93TW91bnRPcHRpb25zLFxuICAgIH07XG4gIH1cbn1cbiJdfQ==