"use strict";
/**
 * NodeResolver — DFS node lookup + subflow reference resolution.
 *
 * Responsibilities:
 * - Find nodes by ID via recursive depth-first search (for back-edge/loop support)
 * - Resolve subflow reference nodes to actual subflow structures
 * - Evaluate deciders to determine next node in branching scenarios
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeResolver = void 0;
class NodeResolver {
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
exports.NodeResolver = NodeResolver;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTm9kZVJlc29sdmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvaGFuZGxlcnMvTm9kZVJlc29sdmVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7OztHQU9HOzs7QUFNSCxNQUFhLFlBQVk7SUFHdkIsWUFBb0IsSUFBK0IsRUFBRSxTQUFnRDtRQUFqRixTQUFJLEdBQUosSUFBSSxDQUEyQjtRQUNqRCxJQUFJLENBQUMsU0FBUyxHQUFHLFNBQVMsYUFBVCxTQUFTLGNBQVQsU0FBUyxHQUFJLElBQUksR0FBRyxFQUFFLENBQUM7SUFDMUMsQ0FBQztJQUVEOzs7O09BSUc7SUFDSCxZQUFZLENBQUMsTUFBYyxFQUFFLFNBQW1DO1FBQzlELGtGQUFrRjtRQUNsRixJQUFJLENBQUMsU0FBUyxFQUFFLENBQUM7WUFDZixNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQztZQUMxQyxJQUFJLE1BQU07Z0JBQUUsT0FBTyxNQUFNLENBQUM7UUFDNUIsQ0FBQztRQUVELCtFQUErRTtRQUMvRSxPQUFPLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxFQUFFLFNBQVMsYUFBVCxTQUFTLGNBQVQsU0FBUyxHQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDeEQsQ0FBQztJQUVEOzs7T0FHRztJQUNLLElBQUksQ0FBQyxNQUFjLEVBQUUsSUFBNkI7UUFDeEQsSUFBSSxJQUFJLENBQUMsRUFBRSxLQUFLLE1BQU07WUFBRSxPQUFPLElBQUksQ0FBQztRQUVwQyxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNsQixLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztnQkFDbEMsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUM7Z0JBQ3ZDLElBQUksS0FBSztvQkFBRSxPQUFPLEtBQUssQ0FBQztZQUMxQixDQUFDO1FBQ0gsQ0FBQztRQUVELElBQUksSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO1lBQ2QsTUFBTSxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1lBQzNDLElBQUksS0FBSztnQkFBRSxPQUFPLEtBQUssQ0FBQztRQUMxQixDQUFDO1FBRUQsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUVEOzs7OztPQUtHO0lBQ0gsdUJBQXVCLENBQUMsSUFBNkI7UUFDbkQsMENBQTBDO1FBQzFDLElBQUksSUFBSSxDQUFDLEVBQUUsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLElBQUksSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFFeEUsSUFBSSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUTtZQUFFLE9BQU8sSUFBSSxDQUFDO1FBRXJDLDJDQUEyQztRQUMzQyxNQUFNLFNBQVMsR0FBRyxDQUFDLElBQUksQ0FBQyxTQUFTLEVBQUUsSUFBSSxDQUFDLFdBQVcsRUFBRSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBYSxDQUFDO1FBQzVGLElBQUksVUFBeUQsQ0FBQztRQUU5RCxLQUFLLE1BQU0sR0FBRyxJQUFJLFNBQVMsRUFBRSxDQUFDO1lBQzVCLElBQUksSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQztnQkFDNUIsVUFBVSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUNyQyxNQUFNO1lBQ1IsQ0FBQztRQUNILENBQUM7UUFFRCxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDaEIsSUFBSSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUNuQiw2Q0FBNkMsSUFBSSxDQUFDLElBQUksa0JBQWtCLFNBQVMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FDaEcsQ0FBQztZQUNGLE9BQU8sSUFBSSxDQUFDO1FBQ2QsQ0FBQztRQUVELGtEQUFrRDtRQUNsRCwrRUFBK0U7UUFDL0UsdUVBQXVFO1FBQ3ZFLE9BQU87WUFDTCxHQUFHLFVBQVUsQ0FBQyxJQUFJO1lBQ2xCLGFBQWEsRUFBRSxJQUFJLENBQUMsYUFBYTtZQUNqQyxTQUFTLEVBQUUsSUFBSSxDQUFDLFNBQVM7WUFDekIsV0FBVyxFQUFFLElBQUksQ0FBQyxXQUFXO1lBQzdCLEVBQUUsRUFBRSxVQUFVLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxJQUFJLENBQUMsRUFBRTtZQUNqQyxtQkFBbUIsRUFBRSxJQUFJLENBQUMsbUJBQW1CLElBQUksVUFBVSxDQUFDLElBQUksQ0FBQyxtQkFBbUI7U0FDckYsQ0FBQztJQUNKLENBQUM7Q0FDRjtBQXZGRCxvQ0F1RkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE5vZGVSZXNvbHZlciDigJQgREZTIG5vZGUgbG9va3VwICsgc3ViZmxvdyByZWZlcmVuY2UgcmVzb2x1dGlvbi5cbiAqXG4gKiBSZXNwb25zaWJpbGl0aWVzOlxuICogLSBGaW5kIG5vZGVzIGJ5IElEIHZpYSByZWN1cnNpdmUgZGVwdGgtZmlyc3Qgc2VhcmNoIChmb3IgYmFjay1lZGdlL2xvb3Agc3VwcG9ydClcbiAqIC0gUmVzb2x2ZSBzdWJmbG93IHJlZmVyZW5jZSBub2RlcyB0byBhY3R1YWwgc3ViZmxvdyBzdHJ1Y3R1cmVzXG4gKiAtIEV2YWx1YXRlIGRlY2lkZXJzIHRvIGRldGVybWluZSBuZXh0IG5vZGUgaW4gYnJhbmNoaW5nIHNjZW5hcmlvc1xuICovXG5cbmltcG9ydCB0eXBlIHsgU3RhZ2VDb250ZXh0IH0gZnJvbSAnLi4vLi4vbWVtb3J5L1N0YWdlQ29udGV4dC5qcyc7XG5pbXBvcnQgdHlwZSB7IFN0YWdlTm9kZSB9IGZyb20gJy4uL2dyYXBoL1N0YWdlTm9kZS5qcyc7XG5pbXBvcnQgdHlwZSB7IEhhbmRsZXJEZXBzIH0gZnJvbSAnLi4vdHlwZXMuanMnO1xuXG5leHBvcnQgY2xhc3MgTm9kZVJlc29sdmVyPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBwcml2YXRlIHJlYWRvbmx5IG5vZGVJZE1hcDogTWFwPHN0cmluZywgU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4+O1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgZGVwczogSGFuZGxlckRlcHM8VE91dCwgVFNjb3BlPiwgbm9kZUlkTWFwPzogTWFwPHN0cmluZywgU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4+KSB7XG4gICAgdGhpcy5ub2RlSWRNYXAgPSBub2RlSWRNYXAgPz8gbmV3IE1hcCgpO1xuICB9XG5cbiAgLyoqXG4gICAqIE8oMSkgbm9kZSBsb29rdXAgdmlhIHByZS1idWlsdCBJRCBtYXAuXG4gICAqIEZhbGxzIGJhY2sgdG8gREZTIGZyb20gc3RhcnROb2RlIChmb3IgZHluYW1pYyBub2RlcyBhZGRlZCBhdCBydW50aW1lXG4gICAqIG9yIHN1YmZsb3ctbG9jYWwgbG9va3VwcyB0aGF0IHVzZSBhbiBleHBsaWNpdCBzdGFydE5vZGUpLlxuICAgKi9cbiAgZmluZE5vZGVCeUlkKG5vZGVJZDogc3RyaW5nLCBzdGFydE5vZGU/OiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPik6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IHwgdW5kZWZpbmVkIHtcbiAgICAvLyBGYXN0IHBhdGg6IE8oMSkgbWFwIGxvb2t1cCAob25seSB2YWxpZCBmb3Igcm9vdC1sZXZlbCBncmFwaCwgbm90IHN1YmZsb3ctbG9jYWwpXG4gICAgaWYgKCFzdGFydE5vZGUpIHtcbiAgICAgIGNvbnN0IG1hcHBlZCA9IHRoaXMubm9kZUlkTWFwLmdldChub2RlSWQpO1xuICAgICAgaWYgKG1hcHBlZCkgcmV0dXJuIG1hcHBlZDtcbiAgICB9XG5cbiAgICAvLyBGYWxsYmFjazogREZTIGZyb20gc3RhcnROb2RlIChzdWJmbG93LWxvY2FsIG9yIGR5bmFtaWMgbm9kZXMgbm90IGluIHRoZSBtYXApXG4gICAgcmV0dXJuIHRoaXMuX2Rmcyhub2RlSWQsIHN0YXJ0Tm9kZSA/PyB0aGlzLmRlcHMucm9vdCk7XG4gIH1cblxuICAvKipcbiAgICogREZTIHNlYXJjaCBmb3IgYSBub2RlIGJ5IElELlxuICAgKiBVc2VkIGFzIGZhbGxiYWNrIHdoZW4gdGhlIG5vZGUgaXMgbm90IGluIHRoZSBwcmUtYnVpbHQgbWFwLlxuICAgKi9cbiAgcHJpdmF0ZSBfZGZzKG5vZGVJZDogc3RyaW5nLCBub2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPik6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IHwgdW5kZWZpbmVkIHtcbiAgICBpZiAobm9kZS5pZCA9PT0gbm9kZUlkKSByZXR1cm4gbm9kZTtcblxuICAgIGlmIChub2RlLmNoaWxkcmVuKSB7XG4gICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUuY2hpbGRyZW4pIHtcbiAgICAgICAgY29uc3QgZm91bmQgPSB0aGlzLl9kZnMobm9kZUlkLCBjaGlsZCk7XG4gICAgICAgIGlmIChmb3VuZCkgcmV0dXJuIGZvdW5kO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChub2RlLm5leHQpIHtcbiAgICAgIGNvbnN0IGZvdW5kID0gdGhpcy5fZGZzKG5vZGVJZCwgbm9kZS5uZXh0KTtcbiAgICAgIGlmIChmb3VuZCkgcmV0dXJuIGZvdW5kO1xuICAgIH1cblxuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICAvKipcbiAgICogUmVzb2x2ZSBhIHN1YmZsb3cgcmVmZXJlbmNlIG5vZGUgdG8gaXRzIGFjdHVhbCBzdHJ1Y3R1cmUuXG4gICAqXG4gICAqIFJlZmVyZW5jZSBub2RlcyBhcmUgbGlnaHR3ZWlnaHQgcGxhY2Vob2xkZXJzIChpc1N1YmZsb3dSb290IGJ1dCBubyBmbi9jaGlsZHJlbikuXG4gICAqIFRoZSBhY3R1YWwgc3RydWN0dXJlIGxpdmVzIGluIHRoZSBzdWJmbG93cyBkaWN0aW9uYXJ5LlxuICAgKi9cbiAgcmVzb2x2ZVN1YmZsb3dSZWZlcmVuY2Uobm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4pOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiB7XG4gICAgLy8gQWxyZWFkeSBoYXMgc3RydWN0dXJlIOKAlCBub3QgYSByZWZlcmVuY2VcbiAgICBpZiAobm9kZS5mbiB8fCAobm9kZS5jaGlsZHJlbiAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aCA+IDApKSByZXR1cm4gbm9kZTtcblxuICAgIGlmICghdGhpcy5kZXBzLnN1YmZsb3dzKSByZXR1cm4gbm9kZTtcblxuICAgIC8vIFRyeSBtdWx0aXBsZSBrZXlzIGluIG9yZGVyIG9mIHByZWZlcmVuY2VcbiAgICBjb25zdCBrZXlzVG9UcnkgPSBbbm9kZS5zdWJmbG93SWQsIG5vZGUuc3ViZmxvd05hbWUsIG5vZGUubmFtZV0uZmlsdGVyKEJvb2xlYW4pIGFzIHN0cmluZ1tdO1xuICAgIGxldCBzdWJmbG93RGVmOiB7IHJvb3Q6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+IH0gfCB1bmRlZmluZWQ7XG5cbiAgICBmb3IgKGNvbnN0IGtleSBvZiBrZXlzVG9UcnkpIHtcbiAgICAgIGlmICh0aGlzLmRlcHMuc3ViZmxvd3Nba2V5XSkge1xuICAgICAgICBzdWJmbG93RGVmID0gdGhpcy5kZXBzLnN1YmZsb3dzW2tleV07XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmICghc3ViZmxvd0RlZikge1xuICAgICAgdGhpcy5kZXBzLmxvZ2dlci5pbmZvKFxuICAgICAgICBgU3ViZmxvdyBub3QgZm91bmQgaW4gZGljdGlvbmFyeSBmb3Igbm9kZSAnJHtub2RlLm5hbWV9JyAodHJpZWQga2V5czogJHtrZXlzVG9Ucnkuam9pbignLCAnKX0pYCxcbiAgICAgICk7XG4gICAgICByZXR1cm4gbm9kZTtcbiAgICB9XG5cbiAgICAvLyBNZXJnZSByZWZlcmVuY2UgbWV0YWRhdGEgd2l0aCBhY3R1YWwgc3RydWN0dXJlLlxuICAgIC8vIGlkIGNvbWVzIGZyb20gdGhlIGlubmVyIHJvb3QgKHRoZSBhY3R1YWwgc3RhZ2UgaWRlbnRpdHkgZm9yIHRyYWNlIG1hdGNoaW5nKSxcbiAgICAvLyBub3QgdGhlIG1vdW50IG5vZGUgKHdoaWNoIGlzIHRoZSBzdWJmbG93IGVudHJ5IHBvaW50IGluIHRoZSBwYXJlbnQpLlxuICAgIHJldHVybiB7XG4gICAgICAuLi5zdWJmbG93RGVmLnJvb3QsXG4gICAgICBpc1N1YmZsb3dSb290OiBub2RlLmlzU3ViZmxvd1Jvb3QsXG4gICAgICBzdWJmbG93SWQ6IG5vZGUuc3ViZmxvd0lkLFxuICAgICAgc3ViZmxvd05hbWU6IG5vZGUuc3ViZmxvd05hbWUsXG4gICAgICBpZDogc3ViZmxvd0RlZi5yb290LmlkIHx8IG5vZGUuaWQsXG4gICAgICBzdWJmbG93TW91bnRPcHRpb25zOiBub2RlLnN1YmZsb3dNb3VudE9wdGlvbnMgfHwgc3ViZmxvd0RlZi5yb290LnN1YmZsb3dNb3VudE9wdGlvbnMsXG4gICAgfTtcbiAgfVxufVxuIl19