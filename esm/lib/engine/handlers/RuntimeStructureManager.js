/**
 * RuntimeStructureManager — Mutable structure tracking for visualization.
 *
 * During execution, dynamic events (new children, subflows, next chains,
 * loop iterations) modify the pipeline. This manager keeps a serialized
 * structure in sync so consumers get the complete picture.
 *
 * Deep-clones build-time structure at init, then maintains O(1) lookup map.
 */
import { isDevMode } from '../../scope/detectCircular.js';
/**
 * Compute the node type from node properties.
 * Shared by RuntimeStructureManager (serialization) and ExtractorRunner (metadata).
 */
export function computeNodeType(node) {
    var _a;
    // Loop back-edge nodes are spec stubs — they are not executable stages.
    // (Runtime: StageNode.isLoopRef; Spec: SerializedPipelineStructure.isLoopReference)
    if (node.isLoopRef)
        return 'loop';
    if (node.isSubflowRoot)
        return 'subflow';
    if (node.selectorFn)
        return 'selector';
    // nextNodeSelector is an output-based routing function (not scope-based), grouped with
    // deciderFn as 'decider' rather than 'selector'. The two branches differ in what they
    // read (output vs scope) but both represent a conditional branch decision. Revisit in a
    // future cleanup once the distinction is user-visible in the UI.
    if (node.nextNodeSelector || node.deciderFn)
        return 'decider';
    if (node.isStreaming)
        return 'streaming';
    const hasDynamicChildren = Boolean(((_a = node.children) === null || _a === void 0 ? void 0 : _a.length) && !node.nextNodeSelector && node.fn);
    if (node.children && node.children.length > 0 && !hasDynamicChildren)
        return 'fork';
    return 'stage';
}
export class RuntimeStructureManager {
    constructor() {
        this.structureNodeMap = new Map();
    }
    /** Initialize from build-time structure. Deep-clones via JSON round-trip. */
    init(buildTimeStructure) {
        if (!buildTimeStructure)
            return;
        try {
            this.runtimePipelineStructure = JSON.parse(JSON.stringify(buildTimeStructure));
        }
        catch (_a) {
            // Non-serializable build-time structure — skip runtime tracking gracefully.
            return;
        }
        this.buildNodeMap(this.runtimePipelineStructure);
    }
    /** Returns the current runtime structure (mutated during execution). */
    getStructure() {
        return this.runtimePipelineStructure;
    }
    /** Recursively registers all nodes in the O(1) lookup map. */
    buildNodeMap(node, depth = 0) {
        if (depth > RuntimeStructureManager.MAX_NODE_MAP_DEPTH) {
            // Guard against pathologically deep or cyclic structures injected into buildTimeStructure.
            // Normal builder-produced charts are naturally bounded well below this limit.
            return;
        }
        this.structureNodeMap.set(node.id, node);
        if (node.children) {
            for (const child of node.children) {
                this.buildNodeMap(child, depth + 1);
            }
        }
        if (node.next) {
            this.buildNodeMap(node.next, depth + 1);
        }
        if (node.subflowStructure) {
            this.buildNodeMap(node.subflowStructure, depth + 1);
        }
    }
    /** Convert a runtime StageNode into a SerializedPipelineStructure node. */
    stageNodeToStructure(node) {
        var _a, _b, _c, _d;
        const structure = {
            name: node.name,
            id: node.id,
            type: computeNodeType(node),
            description: node.description,
        };
        if (node.isStreaming) {
            structure.isStreaming = true;
            structure.streamId = node.streamId;
        }
        if (node.isSubflowRoot) {
            structure.isSubflowRoot = true;
            structure.subflowId = node.subflowId;
            structure.subflowName = node.subflowName;
        }
        if (node.deciderFn) {
            structure.hasDecider = true;
            structure.branchIds = (_a = node.children) === null || _a === void 0 ? void 0 : _a.map((c) => c.id);
        }
        if (node.selectorFn || node.nextNodeSelector) {
            structure.hasSelector = true;
            structure.branchIds = (_b = node.children) === null || _b === void 0 ? void 0 : _b.map((c) => c.id);
        }
        if ((_c = node.children) === null || _c === void 0 ? void 0 : _c.length) {
            structure.children = node.children.map((c) => this.stageNodeToStructure(c));
        }
        if (node.next) {
            structure.next = this.stageNodeToStructure(node.next);
        }
        if ((_d = node.subflowDef) === null || _d === void 0 ? void 0 : _d.buildTimeStructure) {
            structure.subflowStructure = node.subflowDef.buildTimeStructure;
        }
        return structure;
    }
    /** Update structure when dynamic children are discovered at runtime. */
    updateDynamicChildren(parentNodeId, dynamicChildren, hasSelector, hasDecider) {
        if (!this.runtimePipelineStructure)
            return;
        const parentStructure = this.structureNodeMap.get(parentNodeId);
        if (!parentStructure) {
            if (isDevMode()) {
                console.warn(`[footprint] RuntimeStructureManager: node '${parentNodeId}' not found in structure map — snapshot visualization may be incomplete`);
            }
            return;
        }
        const childStructures = dynamicChildren.map((child) => this.stageNodeToStructure(child));
        parentStructure.children = childStructures;
        for (const childStructure of childStructures) {
            this.buildNodeMap(childStructure);
        }
        if (hasSelector) {
            parentStructure.hasSelector = true;
            parentStructure.branchIds = childStructures.map((c) => c.id);
        }
        if (hasDecider) {
            parentStructure.hasDecider = true;
            parentStructure.branchIds = childStructures.map((c) => c.id);
        }
    }
    /** Update structure when a dynamic subflow is registered at runtime. */
    updateDynamicSubflow(mountNodeId, subflowId, subflowName, subflowBuildTimeStructure) {
        if (!this.runtimePipelineStructure)
            return;
        const mountStructure = this.structureNodeMap.get(mountNodeId);
        if (!mountStructure) {
            if (isDevMode()) {
                console.warn(`[footprint] RuntimeStructureManager: node '${mountNodeId}' not found in structure map — snapshot visualization may be incomplete`);
            }
            return;
        }
        mountStructure.isSubflowRoot = true;
        mountStructure.subflowId = subflowId;
        if (subflowName !== undefined) {
            mountStructure.subflowName = subflowName;
        }
        if (subflowBuildTimeStructure) {
            // Deep-copy to prevent external mutation of the stored structure
            try {
                mountStructure.subflowStructure = JSON.parse(JSON.stringify(subflowBuildTimeStructure));
                this.buildNodeMap(mountStructure.subflowStructure);
            }
            catch (_a) {
                // Non-serializable subflow structure — skip subflow structure tracking gracefully.
            }
        }
    }
    /** Update structure when a dynamic next chain is discovered at runtime. */
    updateDynamicNext(currentNodeId, dynamicNext) {
        if (!this.runtimePipelineStructure)
            return;
        const currentStructure = this.structureNodeMap.get(currentNodeId);
        if (!currentStructure) {
            if (isDevMode()) {
                console.warn(`[footprint] RuntimeStructureManager: node '${currentNodeId}' not found in structure map — snapshot visualization may be incomplete`);
            }
            return;
        }
        const nextStructure = this.stageNodeToStructure(dynamicNext);
        currentStructure.next = nextStructure;
        this.buildNodeMap(nextStructure);
    }
    /** Update the iteration count for a node (loop support). */
    updateIterationCount(nodeId, count) {
        if (!this.runtimePipelineStructure)
            return;
        const nodeStructure = this.structureNodeMap.get(nodeId);
        if (!nodeStructure)
            return;
        nodeStructure.iterationCount = count;
    }
}
RuntimeStructureManager.MAX_NODE_MAP_DEPTH = 500;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUnVudGltZVN0cnVjdHVyZU1hbmFnZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9oYW5kbGVycy9SdW50aW1lU3RydWN0dXJlTWFuYWdlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7R0FRRztBQUVILE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSwrQkFBK0IsQ0FBQztBQUkxRDs7O0dBR0c7QUFDSCxNQUFNLFVBQVUsZUFBZSxDQUM3QixJQUFlOztJQUVmLHdFQUF3RTtJQUN4RSxvRkFBb0Y7SUFDcEYsSUFBSSxJQUFJLENBQUMsU0FBUztRQUFFLE9BQU8sTUFBTSxDQUFDO0lBQ2xDLElBQUksSUFBSSxDQUFDLGFBQWE7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUN6QyxJQUFJLElBQUksQ0FBQyxVQUFVO1FBQUUsT0FBTyxVQUFVLENBQUM7SUFDdkMsdUZBQXVGO0lBQ3ZGLHNGQUFzRjtJQUN0Rix3RkFBd0Y7SUFDeEYsaUVBQWlFO0lBQ2pFLElBQUksSUFBSSxDQUFDLGdCQUFnQixJQUFJLElBQUksQ0FBQyxTQUFTO1FBQUUsT0FBTyxTQUFTLENBQUM7SUFDOUQsSUFBSSxJQUFJLENBQUMsV0FBVztRQUFFLE9BQU8sV0FBVyxDQUFDO0lBRXpDLE1BQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDLENBQUEsTUFBQSxJQUFJLENBQUMsUUFBUSwwQ0FBRSxNQUFNLEtBQUksQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLElBQUksSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO0lBQy9GLElBQUksSUFBSSxDQUFDLFFBQVEsSUFBSSxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sR0FBRyxDQUFDLElBQUksQ0FBQyxrQkFBa0I7UUFBRSxPQUFPLE1BQU0sQ0FBQztJQUVwRixPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBRUQsTUFBTSxPQUFPLHVCQUF1QjtJQUFwQztRQUVVLHFCQUFn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QUMsWUFBWSxDQUFDLGFBQWEsQ0FBQyxDQUFDO0lBQ25DLENBQUM7SUFFRCw0REFBNEQ7SUFDNUQsb0JBQW9CLENBQUMsTUFBYyxFQUFFLEtBQWE7UUFDaEQsSUFBSSxDQUFDLElBQUksQ0FBQyx3QkFBd0I7WUFBRSxPQUFPO1FBQzNDLE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLENBQUM7UUFDeEQsSUFBSSxDQUFDLGFBQWE7WUFBRSxPQUFPO1FBQzNCLGFBQWEsQ0FBQyxjQUFjLEdBQUcsS0FBSyxDQUFDO0lBQ3ZDLENBQUM7O0FBMUt1QiwwQ0FBa0IsR0FBRyxHQUFHLEFBQU4sQ0FBTyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUnVudGltZVN0cnVjdHVyZU1hbmFnZXIg4oCUIE11dGFibGUgc3RydWN0dXJlIHRyYWNraW5nIGZvciB2aXN1YWxpemF0aW9uLlxuICpcbiAqIER1cmluZyBleGVjdXRpb24sIGR5bmFtaWMgZXZlbnRzIChuZXcgY2hpbGRyZW4sIHN1YmZsb3dzLCBuZXh0IGNoYWlucyxcbiAqIGxvb3AgaXRlcmF0aW9ucykgbW9kaWZ5IHRoZSBwaXBlbGluZS4gVGhpcyBtYW5hZ2VyIGtlZXBzIGEgc2VyaWFsaXplZFxuICogc3RydWN0dXJlIGluIHN5bmMgc28gY29uc3VtZXJzIGdldCB0aGUgY29tcGxldGUgcGljdHVyZS5cbiAqXG4gKiBEZWVwLWNsb25lcyBidWlsZC10aW1lIHN0cnVjdHVyZSBhdCBpbml0LCB0aGVuIG1haW50YWlucyBPKDEpIGxvb2t1cCBtYXAuXG4gKi9cblxuaW1wb3J0IHsgaXNEZXZNb2RlIH0gZnJvbSAnLi4vLi4vc2NvcGUvZGV0ZWN0Q2lyY3VsYXIuanMnO1xuaW1wb3J0IHR5cGUgeyBTdGFnZU5vZGUgfSBmcm9tICcuLi9ncmFwaC9TdGFnZU5vZGUuanMnO1xuaW1wb3J0IHR5cGUgeyBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbi8qKlxuICogQ29tcHV0ZSB0aGUgbm9kZSB0eXBlIGZyb20gbm9kZSBwcm9wZXJ0aWVzLlxuICogU2hhcmVkIGJ5IFJ1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyIChzZXJpYWxpemF0aW9uKSBhbmQgRXh0cmFjdG9yUnVubmVyIChtZXRhZGF0YSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21wdXRlTm9kZVR5cGUoXG4gIG5vZGU6IFN0YWdlTm9kZSxcbik6ICdzdGFnZScgfCAnZGVjaWRlcicgfCAnc2VsZWN0b3InIHwgJ2ZvcmsnIHwgJ3N0cmVhbWluZycgfCAnc3ViZmxvdycgfCAnbG9vcCcge1xuICAvLyBMb29wIGJhY2stZWRnZSBub2RlcyBhcmUgc3BlYyBzdHVicyDigJQgdGhleSBhcmUgbm90IGV4ZWN1dGFibGUgc3RhZ2VzLlxuICAvLyAoUnVudGltZTogU3RhZ2VOb2RlLmlzTG9vcFJlZjsgU3BlYzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlLmlzTG9vcFJlZmVyZW5jZSlcbiAgaWYgKG5vZGUuaXNMb29wUmVmKSByZXR1cm4gJ2xvb3AnO1xuICBpZiAobm9kZS5pc1N1YmZsb3dSb290KSByZXR1cm4gJ3N1YmZsb3cnO1xuICBpZiAobm9kZS5zZWxlY3RvckZuKSByZXR1cm4gJ3NlbGVjdG9yJztcbiAgLy8gbmV4dE5vZGVTZWxlY3RvciBpcyBhbiBvdXRwdXQtYmFzZWQgcm91dGluZyBmdW5jdGlvbiAobm90IHNjb3BlLWJhc2VkKSwgZ3JvdXBlZCB3aXRoXG4gIC8vIGRlY2lkZXJGbiBhcyAnZGVjaWRlcicgcmF0aGVyIHRoYW4gJ3NlbGVjdG9yJy4gVGhlIHR3byBicmFuY2hlcyBkaWZmZXIgaW4gd2hhdCB0aGV5XG4gIC8vIHJlYWQgKG91dHB1dCB2cyBzY29wZSkgYnV0IGJvdGggcmVwcmVzZW50IGEgY29uZGl0aW9uYWwgYnJhbmNoIGRlY2lzaW9uLiBSZXZpc2l0IGluIGFcbiAgLy8gZnV0dXJlIGNsZWFudXAgb25jZSB0aGUgZGlzdGluY3Rpb24gaXMgdXNlci12aXNpYmxlIGluIHRoZSBVSS5cbiAgaWYgKG5vZGUubmV4dE5vZGVTZWxlY3RvciB8fCBub2RlLmRlY2lkZXJGbikgcmV0dXJuICdkZWNpZGVyJztcbiAgaWYgKG5vZGUuaXNTdHJlYW1pbmcpIHJldHVybiAnc3RyZWFtaW5nJztcblxuICBjb25zdCBoYXNEeW5hbWljQ2hpbGRyZW4gPSBCb29sZWFuKG5vZGUuY2hpbGRyZW4/Lmxlbmd0aCAmJiAhbm9kZS5uZXh0Tm9kZVNlbGVjdG9yICYmIG5vZGUuZm4pO1xuICBpZiAobm9kZS5jaGlsZHJlbiAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aCA+IDAgJiYgIWhhc0R5bmFtaWNDaGlsZHJlbikgcmV0dXJuICdmb3JrJztcblxuICByZXR1cm4gJ3N0YWdlJztcbn1cblxuZXhwb3J0IGNsYXNzIFJ1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyIHtcbiAgcHJpdmF0ZSBydW50aW1lUGlwZWxpbmVTdHJ1Y3R1cmU/OiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmU7XG4gIHByaXZhdGUgc3RydWN0dXJlTm9kZU1hcDogTWFwPHN0cmluZywgU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlPiA9IG5ldyBNYXAoKTtcblxuICAvKiogSW5pdGlhbGl6ZSBmcm9tIGJ1aWxkLXRpbWUgc3RydWN0dXJlLiBEZWVwLWNsb25lcyB2aWEgSlNPTiByb3VuZC10cmlwLiAqL1xuICBpbml0KGJ1aWxkVGltZVN0cnVjdHVyZT86IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSk6IHZvaWQge1xuICAgIGlmICghYnVpbGRUaW1lU3RydWN0dXJlKSByZXR1cm47XG4gICAgdHJ5IHtcbiAgICAgIHRoaXMucnVudGltZVBpcGVsaW5lU3RydWN0dXJlID0gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShidWlsZFRpbWVTdHJ1Y3R1cmUpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIE5vbi1zZXJpYWxpemFibGUgYnVpbGQtdGltZSBzdHJ1Y3R1cmUg4oCUIHNraXAgcnVudGltZSB0cmFja2luZyBncmFjZWZ1bGx5LlxuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLmJ1aWxkTm9kZU1hcCh0aGlzLnJ1bnRpbWVQaXBlbGluZVN0cnVjdHVyZSEpO1xuICB9XG5cbiAgLyoqIFJldHVybnMgdGhlIGN1cnJlbnQgcnVudGltZSBzdHJ1Y3R1cmUgKG11dGF0ZWQgZHVyaW5nIGV4ZWN1dGlvbikuICovXG4gIGdldFN0cnVjdHVyZSgpOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLnJ1bnRpbWVQaXBlbGluZVN0cnVjdHVyZTtcbiAgfVxuXG4gIHByaXZhdGUgc3RhdGljIHJlYWRvbmx5IE1BWF9OT0RFX01BUF9ERVBUSCA9IDUwMDtcblxuICAvKiogUmVjdXJzaXZlbHkgcmVnaXN0ZXJzIGFsbCBub2RlcyBpbiB0aGUgTygxKSBsb29rdXAgbWFwLiAqL1xuICBwcml2YXRlIGJ1aWxkTm9kZU1hcChub2RlOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUsIGRlcHRoID0gMCk6IHZvaWQge1xuICAgIGlmIChkZXB0aCA+IFJ1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyLk1BWF9OT0RFX01BUF9ERVBUSCkge1xuICAgICAgLy8gR3VhcmQgYWdhaW5zdCBwYXRob2xvZ2ljYWxseSBkZWVwIG9yIGN5Y2xpYyBzdHJ1Y3R1cmVzIGluamVjdGVkIGludG8gYnVpbGRUaW1lU3RydWN0dXJlLlxuICAgICAgLy8gTm9ybWFsIGJ1aWxkZXItcHJvZHVjZWQgY2hhcnRzIGFyZSBuYXR1cmFsbHkgYm91bmRlZCB3ZWxsIGJlbG93IHRoaXMgbGltaXQuXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuc3RydWN0dXJlTm9kZU1hcC5zZXQobm9kZS5pZCwgbm9kZSk7XG5cbiAgICBpZiAobm9kZS5jaGlsZHJlbikge1xuICAgICAgZm9yIChjb25zdCBjaGlsZCBvZiBub2RlLmNoaWxkcmVuKSB7XG4gICAgICAgIHRoaXMuYnVpbGROb2RlTWFwKGNoaWxkLCBkZXB0aCArIDEpO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAobm9kZS5uZXh0KSB7XG4gICAgICB0aGlzLmJ1aWxkTm9kZU1hcChub2RlLm5leHQsIGRlcHRoICsgMSk7XG4gICAgfVxuICAgIGlmIChub2RlLnN1YmZsb3dTdHJ1Y3R1cmUpIHtcbiAgICAgIHRoaXMuYnVpbGROb2RlTWFwKG5vZGUuc3ViZmxvd1N0cnVjdHVyZSwgZGVwdGggKyAxKTtcbiAgICB9XG4gIH1cblxuICAvKiogQ29udmVydCBhIHJ1bnRpbWUgU3RhZ2VOb2RlIGludG8gYSBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUgbm9kZS4gKi9cbiAgc3RhZ2VOb2RlVG9TdHJ1Y3R1cmUobm9kZTogU3RhZ2VOb2RlKTogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlIHtcbiAgICBjb25zdCBzdHJ1Y3R1cmU6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSA9IHtcbiAgICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICAgIGlkOiBub2RlLmlkLFxuICAgICAgdHlwZTogY29tcHV0ZU5vZGVUeXBlKG5vZGUpLFxuICAgICAgZGVzY3JpcHRpb246IG5vZGUuZGVzY3JpcHRpb24sXG4gICAgfTtcblxuICAgIGlmIChub2RlLmlzU3RyZWFtaW5nKSB7XG4gICAgICBzdHJ1Y3R1cmUuaXNTdHJlYW1pbmcgPSB0cnVlO1xuICAgICAgc3RydWN0dXJlLnN0cmVhbUlkID0gbm9kZS5zdHJlYW1JZDtcbiAgICB9XG5cbiAgICBpZiAobm9kZS5pc1N1YmZsb3dSb290KSB7XG4gICAgICBzdHJ1Y3R1cmUuaXNTdWJmbG93Um9vdCA9IHRydWU7XG4gICAgICBzdHJ1Y3R1cmUuc3ViZmxvd0lkID0gbm9kZS5zdWJmbG93SWQ7XG4gICAgICBzdHJ1Y3R1cmUuc3ViZmxvd05hbWUgPSBub2RlLnN1YmZsb3dOYW1lO1xuICAgIH1cblxuICAgIGlmIChub2RlLmRlY2lkZXJGbikge1xuICAgICAgc3RydWN0dXJlLmhhc0RlY2lkZXIgPSB0cnVlO1xuICAgICAgc3RydWN0dXJlLmJyYW5jaElkcyA9IG5vZGUuY2hpbGRyZW4/Lm1hcCgoYykgPT4gYy5pZCk7XG4gICAgfVxuXG4gICAgaWYgKG5vZGUuc2VsZWN0b3JGbiB8fCBub2RlLm5leHROb2RlU2VsZWN0b3IpIHtcbiAgICAgIHN0cnVjdHVyZS5oYXNTZWxlY3RvciA9IHRydWU7XG4gICAgICBzdHJ1Y3R1cmUuYnJhbmNoSWRzID0gbm9kZS5jaGlsZHJlbj8ubWFwKChjKSA9PiBjLmlkKTtcbiAgICB9XG5cbiAgICBpZiAobm9kZS5jaGlsZHJlbj8ubGVuZ3RoKSB7XG4gICAgICBzdHJ1Y3R1cmUuY2hpbGRyZW4gPSBub2RlLmNoaWxkcmVuLm1hcCgoYykgPT4gdGhpcy5zdGFnZU5vZGVUb1N0cnVjdHVyZShjKSk7XG4gICAgfVxuXG4gICAgaWYgKG5vZGUubmV4dCkge1xuICAgICAgc3RydWN0dXJlLm5leHQgPSB0aGlzLnN0YWdlTm9kZVRvU3RydWN0dXJlKG5vZGUubmV4dCk7XG4gICAgfVxuXG4gICAgaWYgKG5vZGUuc3ViZmxvd0RlZj8uYnVpbGRUaW1lU3RydWN0dXJlKSB7XG4gICAgICBzdHJ1Y3R1cmUuc3ViZmxvd1N0cnVjdHVyZSA9IG5vZGUuc3ViZmxvd0RlZi5idWlsZFRpbWVTdHJ1Y3R1cmUgYXMgU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlO1xuICAgIH1cblxuICAgIHJldHVybiBzdHJ1Y3R1cmU7XG4gIH1cblxuICAvKiogVXBkYXRlIHN0cnVjdHVyZSB3aGVuIGR5bmFtaWMgY2hpbGRyZW4gYXJlIGRpc2NvdmVyZWQgYXQgcnVudGltZS4gKi9cbiAgdXBkYXRlRHluYW1pY0NoaWxkcmVuKFxuICAgIHBhcmVudE5vZGVJZDogc3RyaW5nLFxuICAgIGR5bmFtaWNDaGlsZHJlbjogU3RhZ2VOb2RlW10sXG4gICAgaGFzU2VsZWN0b3I/OiBib29sZWFuLFxuICAgIGhhc0RlY2lkZXI/OiBib29sZWFuLFxuICApOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMucnVudGltZVBpcGVsaW5lU3RydWN0dXJlKSByZXR1cm47XG5cbiAgICBjb25zdCBwYXJlbnRTdHJ1Y3R1cmUgPSB0aGlzLnN0cnVjdHVyZU5vZGVNYXAuZ2V0KHBhcmVudE5vZGVJZCk7XG4gICAgaWYgKCFwYXJlbnRTdHJ1Y3R1cmUpIHtcbiAgICAgIGlmIChpc0Rldk1vZGUoKSkge1xuICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgYFtmb290cHJpbnRdIFJ1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyOiBub2RlICcke3BhcmVudE5vZGVJZH0nIG5vdCBmb3VuZCBpbiBzdHJ1Y3R1cmUgbWFwIOKAlCBzbmFwc2hvdCB2aXN1YWxpemF0aW9uIG1heSBiZSBpbmNvbXBsZXRlYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBjaGlsZFN0cnVjdHVyZXMgPSBkeW5hbWljQ2hpbGRyZW4ubWFwKChjaGlsZCkgPT4gdGhpcy5zdGFnZU5vZGVUb1N0cnVjdHVyZShjaGlsZCkpO1xuICAgIHBhcmVudFN0cnVjdHVyZS5jaGlsZHJlbiA9IGNoaWxkU3RydWN0dXJlcztcblxuICAgIGZvciAoY29uc3QgY2hpbGRTdHJ1Y3R1cmUgb2YgY2hpbGRTdHJ1Y3R1cmVzKSB7XG4gICAgICB0aGlzLmJ1aWxkTm9kZU1hcChjaGlsZFN0cnVjdHVyZSk7XG4gICAgfVxuXG4gICAgaWYgKGhhc1NlbGVjdG9yKSB7XG4gICAgICBwYXJlbnRTdHJ1Y3R1cmUuaGFzU2VsZWN0b3IgPSB0cnVlO1xuICAgICAgcGFyZW50U3RydWN0dXJlLmJyYW5jaElkcyA9IGNoaWxkU3RydWN0dXJlcy5tYXAoKGMpID0+IGMuaWQpO1xuICAgIH1cblxuICAgIGlmIChoYXNEZWNpZGVyKSB7XG4gICAgICBwYXJlbnRTdHJ1Y3R1cmUuaGFzRGVjaWRlciA9IHRydWU7XG4gICAgICBwYXJlbnRTdHJ1Y3R1cmUuYnJhbmNoSWRzID0gY2hpbGRTdHJ1Y3R1cmVzLm1hcCgoYykgPT4gYy5pZCk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFVwZGF0ZSBzdHJ1Y3R1cmUgd2hlbiBhIGR5bmFtaWMgc3ViZmxvdyBpcyByZWdpc3RlcmVkIGF0IHJ1bnRpbWUuICovXG4gIHVwZGF0ZUR5bmFtaWNTdWJmbG93KFxuICAgIG1vdW50Tm9kZUlkOiBzdHJpbmcsXG4gICAgc3ViZmxvd0lkOiBzdHJpbmcsXG4gICAgc3ViZmxvd05hbWU/OiBzdHJpbmcsXG4gICAgc3ViZmxvd0J1aWxkVGltZVN0cnVjdHVyZT86IHVua25vd24sXG4gICk6IHZvaWQge1xuICAgIGlmICghdGhpcy5ydW50aW1lUGlwZWxpbmVTdHJ1Y3R1cmUpIHJldHVybjtcblxuICAgIGNvbnN0IG1vdW50U3RydWN0dXJlID0gdGhpcy5zdHJ1Y3R1cmVOb2RlTWFwLmdldChtb3VudE5vZGVJZCk7XG4gICAgaWYgKCFtb3VudFN0cnVjdHVyZSkge1xuICAgICAgaWYgKGlzRGV2TW9kZSgpKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgICBgW2Zvb3RwcmludF0gUnVudGltZVN0cnVjdHVyZU1hbmFnZXI6IG5vZGUgJyR7bW91bnROb2RlSWR9JyBub3QgZm91bmQgaW4gc3RydWN0dXJlIG1hcCDigJQgc25hcHNob3QgdmlzdWFsaXphdGlvbiBtYXkgYmUgaW5jb21wbGV0ZWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgbW91bnRTdHJ1Y3R1cmUuaXNTdWJmbG93Um9vdCA9IHRydWU7XG4gICAgbW91bnRTdHJ1Y3R1cmUuc3ViZmxvd0lkID0gc3ViZmxvd0lkO1xuXG4gICAgaWYgKHN1YmZsb3dOYW1lICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIG1vdW50U3RydWN0dXJlLnN1YmZsb3dOYW1lID0gc3ViZmxvd05hbWU7XG4gICAgfVxuXG4gICAgaWYgKHN1YmZsb3dCdWlsZFRpbWVTdHJ1Y3R1cmUpIHtcbiAgICAgIC8vIERlZXAtY29weSB0byBwcmV2ZW50IGV4dGVybmFsIG11dGF0aW9uIG9mIHRoZSBzdG9yZWQgc3RydWN0dXJlXG4gICAgICB0cnkge1xuICAgICAgICBtb3VudFN0cnVjdHVyZS5zdWJmbG93U3RydWN0dXJlID0gSlNPTi5wYXJzZShcbiAgICAgICAgICBKU09OLnN0cmluZ2lmeShzdWJmbG93QnVpbGRUaW1lU3RydWN0dXJlKSxcbiAgICAgICAgKSBhcyBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmU7XG4gICAgICAgIHRoaXMuYnVpbGROb2RlTWFwKG1vdW50U3RydWN0dXJlLnN1YmZsb3dTdHJ1Y3R1cmUpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIE5vbi1zZXJpYWxpemFibGUgc3ViZmxvdyBzdHJ1Y3R1cmUg4oCUIHNraXAgc3ViZmxvdyBzdHJ1Y3R1cmUgdHJhY2tpbmcgZ3JhY2VmdWxseS5cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKiogVXBkYXRlIHN0cnVjdHVyZSB3aGVuIGEgZHluYW1pYyBuZXh0IGNoYWluIGlzIGRpc2NvdmVyZWQgYXQgcnVudGltZS4gKi9cbiAgdXBkYXRlRHluYW1pY05leHQoY3VycmVudE5vZGVJZDogc3RyaW5nLCBkeW5hbWljTmV4dDogU3RhZ2VOb2RlKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnJ1bnRpbWVQaXBlbGluZVN0cnVjdHVyZSkgcmV0dXJuO1xuXG4gICAgY29uc3QgY3VycmVudFN0cnVjdHVyZSA9IHRoaXMuc3RydWN0dXJlTm9kZU1hcC5nZXQoY3VycmVudE5vZGVJZCk7XG4gICAgaWYgKCFjdXJyZW50U3RydWN0dXJlKSB7XG4gICAgICBpZiAoaXNEZXZNb2RlKCkpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgIGBbZm9vdHByaW50XSBSdW50aW1lU3RydWN0dXJlTWFuYWdlcjogbm9kZSAnJHtjdXJyZW50Tm9kZUlkfScgbm90IGZvdW5kIGluIHN0cnVjdHVyZSBtYXAg4oCUIHNuYXBzaG90IHZpc3VhbGl6YXRpb24gbWF5IGJlIGluY29tcGxldGVgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IG5leHRTdHJ1Y3R1cmUgPSB0aGlzLnN0YWdlTm9kZVRvU3RydWN0dXJlKGR5bmFtaWNOZXh0KTtcbiAgICBjdXJyZW50U3RydWN0dXJlLm5leHQgPSBuZXh0U3RydWN0dXJlO1xuICAgIHRoaXMuYnVpbGROb2RlTWFwKG5leHRTdHJ1Y3R1cmUpO1xuICB9XG5cbiAgLyoqIFVwZGF0ZSB0aGUgaXRlcmF0aW9uIGNvdW50IGZvciBhIG5vZGUgKGxvb3Agc3VwcG9ydCkuICovXG4gIHVwZGF0ZUl0ZXJhdGlvbkNvdW50KG5vZGVJZDogc3RyaW5nLCBjb3VudDogbnVtYmVyKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnJ1bnRpbWVQaXBlbGluZVN0cnVjdHVyZSkgcmV0dXJuO1xuICAgIGNvbnN0IG5vZGVTdHJ1Y3R1cmUgPSB0aGlzLnN0cnVjdHVyZU5vZGVNYXAuZ2V0KG5vZGVJZCk7XG4gICAgaWYgKCFub2RlU3RydWN0dXJlKSByZXR1cm47XG4gICAgbm9kZVN0cnVjdHVyZS5pdGVyYXRpb25Db3VudCA9IGNvdW50O1xuICB9XG59XG4iXX0=