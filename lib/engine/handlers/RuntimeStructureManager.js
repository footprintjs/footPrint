"use strict";
/**
 * RuntimeStructureManager — Mutable structure tracking for visualization.
 *
 * During execution, dynamic events (new children, subflows, next chains,
 * loop iterations) modify the pipeline. This manager keeps a serialized
 * structure in sync so consumers get the complete picture.
 *
 * Deep-clones build-time structure at init, then maintains O(1) lookup map.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuntimeStructureManager = exports.computeNodeType = void 0;
const detectCircular_js_1 = require("../../scope/detectCircular.js");
/**
 * Compute the node type from node properties.
 * Shared by RuntimeStructureManager (serialization) and ExtractorRunner (metadata).
 */
function computeNodeType(node) {
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
exports.computeNodeType = computeNodeType;
class RuntimeStructureManager {
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
            if ((0, detectCircular_js_1.isDevMode)()) {
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
            if ((0, detectCircular_js_1.isDevMode)()) {
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
            if ((0, detectCircular_js_1.isDevMode)()) {
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
exports.RuntimeStructureManager = RuntimeStructureManager;
RuntimeStructureManager.MAX_NODE_MAP_DEPTH = 500;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUnVudGltZVN0cnVjdHVyZU1hbmFnZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9oYW5kbGVycy9SdW50aW1lU3RydWN0dXJlTWFuYWdlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7O0dBUUc7OztBQUVILHFFQUEwRDtBQUkxRDs7O0dBR0c7QUFDSCxTQUFnQixlQUFlLENBQzdCLElBQWU7O0lBRWYsd0VBQXdFO0lBQ3hFLG9GQUFvRjtJQUNwRixJQUFJLElBQUksQ0FBQyxTQUFTO1FBQUUsT0FBTyxNQUFNLENBQUM7SUFDbEMsSUFBSSxJQUFJLENBQUMsYUFBYTtRQUFFLE9BQU8sU0FBUyxDQUFDO0lBQ3pDLElBQUksSUFBSSxDQUFDLFVBQVU7UUFBRSxPQUFPLFVBQVUsQ0FBQztJQUN2Qyx1RkFBdUY7SUFDdkYsc0ZBQXNGO0lBQ3RGLHdGQUF3RjtJQUN4RixpRUFBaUU7SUFDakUsSUFBSSxJQUFJLENBQUMsZ0JBQWdCLElBQUksSUFBSSxDQUFDLFNBQVM7UUFBRSxPQUFPLFNBQVMsQ0FBQztJQUM5RCxJQUFJLElBQUksQ0FBQyxXQUFXO1FBQUUsT0FBTyxXQUFXLENBQUM7SUFFekMsTUFBTSxrQkFBa0IsR0FBRyxPQUFPLENBQUMsQ0FBQSxNQUFBLElBQUksQ0FBQyxRQUFRLDBDQUFFLE1BQU0sS0FBSSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsSUFBSSxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDL0YsSUFBSSxJQUFJLENBQUMsUUFBUSxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxHQUFHLENBQUMsSUFBSSxDQUFDLGtCQUFrQjtRQUFFLE9BQU8sTUFBTSxDQUFDO0lBRXBGLE9BQU8sT0FBTyxDQUFDO0FBQ2pCLENBQUM7QUFuQkQsMENBbUJDO0FBRUQsTUFBYSx1QkFBdUI7SUFBcEM7UUFFVSxxQkFBZ0IsR0FBNkMsSUFBSSxHQUFHLEVBQUUsQ0FBQztJQThMakYsQ0FBQztJQTVMQyw2RUFBNkU7SUFDN0UsSUFBSSxDQUFDLGtCQUFnRDtRQUNuRCxJQUFJLENBQUMsa0JBQWtCO1lBQUUsT0FBTztRQUNoQyxJQUFJLENBQUM7WUFDSCxJQUFJLENBQUMsd0JBQXdCLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLGtCQUFrQixDQUFDLENBQUMsQ0FBQztRQUNqRixDQUFDO1FBQUMsV0FBTSxDQUFDO1lBQ1AsNEVBQTRFO1lBQzVFLE9BQU87UUFDVCxDQUFDO1FBQ0QsSUFBSSxDQUFDLFlBQVksQ0FBQyxJQUFJLENBQUMsd0JBQXlCLENBQUMsQ0FBQztJQUNwRCxDQUFDO0lBRUQsd0VBQXdFO0lBQ3hFLFlBQVk7UUFDVixPQUFPLElBQUksQ0FBQyx3QkFBd0IsQ0FBQztJQUN2QyxDQUFDO0lBSUQsOERBQThEO0lBQ3RELFlBQVksQ0FBQyxJQUFpQyxFQUFFLEtBQUssR0FBRyxDQUFDO1FBQy9ELElBQUksS0FBSyxHQUFHLHVCQUF1QixDQUFDLGtCQUFrQixFQUFFLENBQUM7WUFDdkQsMkZBQTJGO1lBQzNGLDhFQUE4RTtZQUM5RSxPQUFPO1FBQ1QsQ0FBQztRQUNELElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxJQUFJLENBQUMsQ0FBQztRQUV6QyxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNsQixLQUFLLE1BQU0sS0FBSyxJQUFJLElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztnQkFDbEMsSUFBSSxDQUFDLFlBQVksQ0FBQyxLQUFLLEVBQUUsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO1lBQ3RDLENBQUM7UUFDSCxDQUFDO1FBQ0QsSUFBSSxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUM7WUFDZCxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsS0FBSyxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQzFDLENBQUM7UUFDRCxJQUFJLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1lBQzFCLElBQUksQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLGdCQUFnQixFQUFFLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQztRQUN0RCxDQUFDO0lBQ0gsQ0FBQztJQUVELDJFQUEyRTtJQUMzRSxvQkFBb0IsQ0FBQyxJQUFlOztRQUNsQyxNQUFNLFNBQVMsR0FBZ0M7WUFDN0MsSUFBSSxFQUFFLElBQUksQ0FBQyxJQUFJO1lBQ2YsRUFBRSxFQUFFLElBQUksQ0FBQyxFQUFFO1lBQ1gsSUFBSSxFQUFFLGVBQWUsQ0FBQyxJQUFJLENBQUM7WUFDM0IsV0FBVyxFQUFFLElBQUksQ0FBQyxXQUFXO1NBQzlCLENBQUM7UUFFRixJQUFJLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNyQixTQUFTLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQztZQUM3QixTQUFTLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUM7UUFDckMsQ0FBQztRQUVELElBQUksSUFBSSxDQUFDLGFBQWEsRUFBRSxDQUFDO1lBQ3ZCLFNBQVMsQ0FBQyxhQUFhLEdBQUcsSUFBSSxDQUFDO1lBQy9CLFNBQVMsQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQztZQUNyQyxTQUFTLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUM7UUFDM0MsQ0FBQztRQUVELElBQUksSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO1lBQ25CLFNBQVMsQ0FBQyxVQUFVLEdBQUcsSUFBSSxDQUFDO1lBQzVCLFNBQVMsQ0FBQyxTQUFTLEdBQUcsTUFBQSxJQUFJLENBQUMsUUFBUSwwQ0FBRSxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUN4RCxDQUFDO1FBRUQsSUFBSSxJQUFJLENBQUMsVUFBVSxJQUFJLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1lBQzdDLFNBQVMsQ0FBQyxXQUFXLEdBQUcsSUFBSSxDQUFDO1lBQzdCLFNBQVMsQ0FBQyxTQUFTLEdBQUcsTUFBQSxJQUFJLENBQUMsUUFBUSwwQ0FBRSxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUN4RCxDQUFDO1FBRUQsSUFBSSxNQUFBLElBQUksQ0FBQyxRQUFRLDBDQUFFLE1BQU0sRUFBRSxDQUFDO1lBQzFCLFNBQVMsQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLElBQUksQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzlFLENBQUM7UUFFRCxJQUFJLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztZQUNkLFNBQVMsQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDLG9CQUFvQixDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN4RCxDQUFDO1FBRUQsSUFBSSxNQUFBLElBQUksQ0FBQyxVQUFVLDBDQUFFLGtCQUFrQixFQUFFLENBQUM7WUFDeEMsU0FBUyxDQUFDLGdCQUFnQixHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsa0JBQWlELENBQUM7UUFDakcsQ0FBQztRQUVELE9BQU8sU0FBUyxDQUFDO0lBQ25CLENBQUM7SUFFRCx3RUFBd0U7SUFDeEUscUJBQXFCLENBQ25CLFlBQW9CLEVBQ3BCLGVBQTRCLEVBQzVCLFdBQXFCLEVBQ3JCLFVBQW9CO1FBRXBCLElBQUksQ0FBQyxJQUFJLENBQUMsd0JBQXdCO1lBQUUsT0FBTztRQUUzQyxNQUFNLGVBQWUsR0FBRyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQyxDQUFDO1FBQ2hFLElBQUksQ0FBQyxlQUFlLEVBQUUsQ0FBQztZQUNyQixJQUFJLElBQUEsNkJBQVMsR0FBRSxFQUFFLENBQUM7Z0JBQ2hCLE9BQU8sQ0FBQyxJQUFJLENBQ1YsOENBQThDLFlBQVkseUVBQXlFLENBQ3BJLENBQUM7WUFDSixDQUFDO1lBQ0QsT0FBTztRQUNULENBQUM7UUFFRCxNQUFNLGVBQWUsR0FBRyxlQUFlLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxJQUFJLENBQUMsb0JBQW9CLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztRQUN6RixlQUFlLENBQUMsUUFBUSxHQUFHLGVBQWUsQ0FBQztRQUUzQyxLQUFLLE1BQU0sY0FBYyxJQUFJLGVBQWUsRUFBRSxDQUFDO1lBQzdDLElBQUksQ0FBQyxZQUFZLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDcEMsQ0FBQztRQUVELElBQUksV0FBVyxFQUFFLENBQUM7WUFDaEIsZUFBZSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUM7WUFDbkMsZUFBZSxDQUFDLFNBQVMsR0FBRyxlQUFlLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDL0QsQ0FBQztRQUVELElBQUksVUFBVSxFQUFFLENBQUM7WUFDZixlQUFlLENBQUMsVUFBVSxHQUFHLElBQUksQ0FBQztZQUNsQyxlQUFlLENBQUMsU0FBUyxHQUFHLGVBQWUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUMvRCxDQUFDO0lBQ0gsQ0FBQztJQUVELHdFQUF3RTtJQUN4RSxvQkFBb0IsQ0FDbEIsV0FBbUIsRUFDbkIsU0FBaUIsRUFDakIsV0FBb0IsRUFDcEIseUJBQW1DO1FBRW5DLElBQUksQ0FBQyxJQUFJLENBQUMsd0JBQXdCO1lBQUUsT0FBTztRQUUzQyxNQUFNLGNBQWMsR0FBRyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQzlELElBQUksQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUNwQixJQUFJLElBQUEsNkJBQVMsR0FBRSxFQUFFLENBQUM7Z0JBQ2hCLE9BQU8sQ0FBQyxJQUFJLENBQ1YsOENBQThDLFdBQVcseUVBQXlFLENBQ25JLENBQUM7WUFDSixDQUFDO1lBQ0QsT0FBTztRQUNULENBQUM7UUFFRCxjQUFjLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQztRQUNwQyxjQUFjLENBQUMsU0FBUyxHQUFHLFNBQVMsQ0FBQztRQUVyQyxJQUFJLFdBQVcsS0FBSyxTQUFTLEVBQUUsQ0FBQztZQUM5QixjQUFjLENBQUMsV0FBVyxHQUFHLFdBQVcsQ0FBQztRQUMzQyxDQUFDO1FBRUQsSUFBSSx5QkFBeUIsRUFBRSxDQUFDO1lBQzlCLGlFQUFpRTtZQUNqRSxJQUFJLENBQUM7Z0JBQ0gsY0FBYyxDQUFDLGdCQUFnQixHQUFHLElBQUksQ0FBQyxLQUFLLENBQzFDLElBQUksQ0FBQyxTQUFTLENBQUMseUJBQXlCLENBQUMsQ0FDWCxDQUFDO2dCQUNqQyxJQUFJLENBQUMsWUFBWSxDQUFDLGNBQWMsQ0FBQyxnQkFBZ0IsQ0FBQyxDQUFDO1lBQ3JELENBQUM7WUFBQyxXQUFNLENBQUM7Z0JBQ1AsbUZBQW1GO1lBQ3JGLENBQUM7UUFDSCxDQUFDO0lBQ0gsQ0FBQztJQUVELDJFQUEyRTtJQUMzRSxpQkFBaUIsQ0FBQyxhQUFxQixFQUFFLFdBQXNCO1FBQzdELElBQUksQ0FBQyxJQUFJLENBQUMsd0JBQXdCO1lBQUUsT0FBTztRQUUzQyxNQUFNLGdCQUFnQixHQUFHLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDbEUsSUFBSSxDQUFDLGdCQUFnQixFQUFFLENBQUM7WUFDdEIsSUFBSSxJQUFBLDZCQUFTLEdBQUUsRUFBRSxDQUFDO2dCQUNoQixPQUFPLENBQUMsSUFBSSxDQUNWLDhDQUE4QyxhQUFhLHlFQUF5RSxDQUNySSxDQUFDO1lBQ0osQ0FBQztZQUNELE9BQU87UUFDVCxDQUFDO1FBRUQsTUFBTSxhQUFhLEdBQUcsSUFBSSxDQUFDLG9CQUFvQixDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQzdELGdCQUFnQixDQUFDLElBQUksR0FBRyxhQUFhLENBQUM7UUFDdEMsSUFBSSxDQUFDLFlBQVksQ0FBQyxhQUFhLENBQUMsQ0FBQztJQUNuQyxDQUFDO0lBRUQsNERBQTREO0lBQzVELG9CQUFvQixDQUFDLE1BQWMsRUFBRSxLQUFhO1FBQ2hELElBQUksQ0FBQyxJQUFJLENBQUMsd0JBQXdCO1lBQUUsT0FBTztRQUMzQyxNQUFNLGFBQWEsR0FBRyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ3hELElBQUksQ0FBQyxhQUFhO1lBQUUsT0FBTztRQUMzQixhQUFhLENBQUMsY0FBYyxHQUFHLEtBQUssQ0FBQztJQUN2QyxDQUFDOztBQS9MSCwwREFnTUM7QUEzS3lCLDBDQUFrQixHQUFHLEdBQUcsQUFBTixDQUFPIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSdW50aW1lU3RydWN0dXJlTWFuYWdlciDigJQgTXV0YWJsZSBzdHJ1Y3R1cmUgdHJhY2tpbmcgZm9yIHZpc3VhbGl6YXRpb24uXG4gKlxuICogRHVyaW5nIGV4ZWN1dGlvbiwgZHluYW1pYyBldmVudHMgKG5ldyBjaGlsZHJlbiwgc3ViZmxvd3MsIG5leHQgY2hhaW5zLFxuICogbG9vcCBpdGVyYXRpb25zKSBtb2RpZnkgdGhlIHBpcGVsaW5lLiBUaGlzIG1hbmFnZXIga2VlcHMgYSBzZXJpYWxpemVkXG4gKiBzdHJ1Y3R1cmUgaW4gc3luYyBzbyBjb25zdW1lcnMgZ2V0IHRoZSBjb21wbGV0ZSBwaWN0dXJlLlxuICpcbiAqIERlZXAtY2xvbmVzIGJ1aWxkLXRpbWUgc3RydWN0dXJlIGF0IGluaXQsIHRoZW4gbWFpbnRhaW5zIE8oMSkgbG9va3VwIG1hcC5cbiAqL1xuXG5pbXBvcnQgeyBpc0Rldk1vZGUgfSBmcm9tICcuLi8uLi9zY29wZS9kZXRlY3RDaXJjdWxhci5qcyc7XG5pbXBvcnQgdHlwZSB7IFN0YWdlTm9kZSB9IGZyb20gJy4uL2dyYXBoL1N0YWdlTm9kZS5qcyc7XG5pbXBvcnQgdHlwZSB7IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSB9IGZyb20gJy4uL3R5cGVzLmpzJztcblxuLyoqXG4gKiBDb21wdXRlIHRoZSBub2RlIHR5cGUgZnJvbSBub2RlIHByb3BlcnRpZXMuXG4gKiBTaGFyZWQgYnkgUnVudGltZVN0cnVjdHVyZU1hbmFnZXIgKHNlcmlhbGl6YXRpb24pIGFuZCBFeHRyYWN0b3JSdW5uZXIgKG1ldGFkYXRhKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbXB1dGVOb2RlVHlwZShcbiAgbm9kZTogU3RhZ2VOb2RlLFxuKTogJ3N0YWdlJyB8ICdkZWNpZGVyJyB8ICdzZWxlY3RvcicgfCAnZm9yaycgfCAnc3RyZWFtaW5nJyB8ICdzdWJmbG93JyB8ICdsb29wJyB7XG4gIC8vIExvb3AgYmFjay1lZGdlIG5vZGVzIGFyZSBzcGVjIHN0dWJzIOKAlCB0aGV5IGFyZSBub3QgZXhlY3V0YWJsZSBzdGFnZXMuXG4gIC8vIChSdW50aW1lOiBTdGFnZU5vZGUuaXNMb29wUmVmOyBTcGVjOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUuaXNMb29wUmVmZXJlbmNlKVxuICBpZiAobm9kZS5pc0xvb3BSZWYpIHJldHVybiAnbG9vcCc7XG4gIGlmIChub2RlLmlzU3ViZmxvd1Jvb3QpIHJldHVybiAnc3ViZmxvdyc7XG4gIGlmIChub2RlLnNlbGVjdG9yRm4pIHJldHVybiAnc2VsZWN0b3InO1xuICAvLyBuZXh0Tm9kZVNlbGVjdG9yIGlzIGFuIG91dHB1dC1iYXNlZCByb3V0aW5nIGZ1bmN0aW9uIChub3Qgc2NvcGUtYmFzZWQpLCBncm91cGVkIHdpdGhcbiAgLy8gZGVjaWRlckZuIGFzICdkZWNpZGVyJyByYXRoZXIgdGhhbiAnc2VsZWN0b3InLiBUaGUgdHdvIGJyYW5jaGVzIGRpZmZlciBpbiB3aGF0IHRoZXlcbiAgLy8gcmVhZCAob3V0cHV0IHZzIHNjb3BlKSBidXQgYm90aCByZXByZXNlbnQgYSBjb25kaXRpb25hbCBicmFuY2ggZGVjaXNpb24uIFJldmlzaXQgaW4gYVxuICAvLyBmdXR1cmUgY2xlYW51cCBvbmNlIHRoZSBkaXN0aW5jdGlvbiBpcyB1c2VyLXZpc2libGUgaW4gdGhlIFVJLlxuICBpZiAobm9kZS5uZXh0Tm9kZVNlbGVjdG9yIHx8IG5vZGUuZGVjaWRlckZuKSByZXR1cm4gJ2RlY2lkZXInO1xuICBpZiAobm9kZS5pc1N0cmVhbWluZykgcmV0dXJuICdzdHJlYW1pbmcnO1xuXG4gIGNvbnN0IGhhc0R5bmFtaWNDaGlsZHJlbiA9IEJvb2xlYW4obm9kZS5jaGlsZHJlbj8ubGVuZ3RoICYmICFub2RlLm5leHROb2RlU2VsZWN0b3IgJiYgbm9kZS5mbik7XG4gIGlmIChub2RlLmNoaWxkcmVuICYmIG5vZGUuY2hpbGRyZW4ubGVuZ3RoID4gMCAmJiAhaGFzRHluYW1pY0NoaWxkcmVuKSByZXR1cm4gJ2ZvcmsnO1xuXG4gIHJldHVybiAnc3RhZ2UnO1xufVxuXG5leHBvcnQgY2xhc3MgUnVudGltZVN0cnVjdHVyZU1hbmFnZXIge1xuICBwcml2YXRlIHJ1bnRpbWVQaXBlbGluZVN0cnVjdHVyZT86IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZTtcbiAgcHJpdmF0ZSBzdHJ1Y3R1cmVOb2RlTWFwOiBNYXA8c3RyaW5nLCBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmU+ID0gbmV3IE1hcCgpO1xuXG4gIC8qKiBJbml0aWFsaXplIGZyb20gYnVpbGQtdGltZSBzdHJ1Y3R1cmUuIERlZXAtY2xvbmVzIHZpYSBKU09OIHJvdW5kLXRyaXAuICovXG4gIGluaXQoYnVpbGRUaW1lU3RydWN0dXJlPzogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlKTogdm9pZCB7XG4gICAgaWYgKCFidWlsZFRpbWVTdHJ1Y3R1cmUpIHJldHVybjtcbiAgICB0cnkge1xuICAgICAgdGhpcy5ydW50aW1lUGlwZWxpbmVTdHJ1Y3R1cmUgPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KGJ1aWxkVGltZVN0cnVjdHVyZSkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gTm9uLXNlcmlhbGl6YWJsZSBidWlsZC10aW1lIHN0cnVjdHVyZSDigJQgc2tpcCBydW50aW1lIHRyYWNraW5nIGdyYWNlZnVsbHkuXG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuYnVpbGROb2RlTWFwKHRoaXMucnVudGltZVBpcGVsaW5lU3RydWN0dXJlISk7XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgY3VycmVudCBydW50aW1lIHN0cnVjdHVyZSAobXV0YXRlZCBkdXJpbmcgZXhlY3V0aW9uKS4gKi9cbiAgZ2V0U3RydWN0dXJlKCk6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMucnVudGltZVBpcGVsaW5lU3RydWN0dXJlO1xuICB9XG5cbiAgcHJpdmF0ZSBzdGF0aWMgcmVhZG9ubHkgTUFYX05PREVfTUFQX0RFUFRIID0gNTAwO1xuXG4gIC8qKiBSZWN1cnNpdmVseSByZWdpc3RlcnMgYWxsIG5vZGVzIGluIHRoZSBPKDEpIGxvb2t1cCBtYXAuICovXG4gIHByaXZhdGUgYnVpbGROb2RlTWFwKG5vZGU6IFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSwgZGVwdGggPSAwKTogdm9pZCB7XG4gICAgaWYgKGRlcHRoID4gUnVudGltZVN0cnVjdHVyZU1hbmFnZXIuTUFYX05PREVfTUFQX0RFUFRIKSB7XG4gICAgICAvLyBHdWFyZCBhZ2FpbnN0IHBhdGhvbG9naWNhbGx5IGRlZXAgb3IgY3ljbGljIHN0cnVjdHVyZXMgaW5qZWN0ZWQgaW50byBidWlsZFRpbWVTdHJ1Y3R1cmUuXG4gICAgICAvLyBOb3JtYWwgYnVpbGRlci1wcm9kdWNlZCBjaGFydHMgYXJlIG5hdHVyYWxseSBib3VuZGVkIHdlbGwgYmVsb3cgdGhpcyBsaW1pdC5cbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5zdHJ1Y3R1cmVOb2RlTWFwLnNldChub2RlLmlkLCBub2RlKTtcblxuICAgIGlmIChub2RlLmNoaWxkcmVuKSB7XG4gICAgICBmb3IgKGNvbnN0IGNoaWxkIG9mIG5vZGUuY2hpbGRyZW4pIHtcbiAgICAgICAgdGhpcy5idWlsZE5vZGVNYXAoY2hpbGQsIGRlcHRoICsgMSk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChub2RlLm5leHQpIHtcbiAgICAgIHRoaXMuYnVpbGROb2RlTWFwKG5vZGUubmV4dCwgZGVwdGggKyAxKTtcbiAgICB9XG4gICAgaWYgKG5vZGUuc3ViZmxvd1N0cnVjdHVyZSkge1xuICAgICAgdGhpcy5idWlsZE5vZGVNYXAobm9kZS5zdWJmbG93U3RydWN0dXJlLCBkZXB0aCArIDEpO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBDb252ZXJ0IGEgcnVudGltZSBTdGFnZU5vZGUgaW50byBhIFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZSBub2RlLiAqL1xuICBzdGFnZU5vZGVUb1N0cnVjdHVyZShub2RlOiBTdGFnZU5vZGUpOiBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUge1xuICAgIGNvbnN0IHN0cnVjdHVyZTogU2VyaWFsaXplZFBpcGVsaW5lU3RydWN0dXJlID0ge1xuICAgICAgbmFtZTogbm9kZS5uYW1lLFxuICAgICAgaWQ6IG5vZGUuaWQsXG4gICAgICB0eXBlOiBjb21wdXRlTm9kZVR5cGUobm9kZSksXG4gICAgICBkZXNjcmlwdGlvbjogbm9kZS5kZXNjcmlwdGlvbixcbiAgICB9O1xuXG4gICAgaWYgKG5vZGUuaXNTdHJlYW1pbmcpIHtcbiAgICAgIHN0cnVjdHVyZS5pc1N0cmVhbWluZyA9IHRydWU7XG4gICAgICBzdHJ1Y3R1cmUuc3RyZWFtSWQgPSBub2RlLnN0cmVhbUlkO1xuICAgIH1cblxuICAgIGlmIChub2RlLmlzU3ViZmxvd1Jvb3QpIHtcbiAgICAgIHN0cnVjdHVyZS5pc1N1YmZsb3dSb290ID0gdHJ1ZTtcbiAgICAgIHN0cnVjdHVyZS5zdWJmbG93SWQgPSBub2RlLnN1YmZsb3dJZDtcbiAgICAgIHN0cnVjdHVyZS5zdWJmbG93TmFtZSA9IG5vZGUuc3ViZmxvd05hbWU7XG4gICAgfVxuXG4gICAgaWYgKG5vZGUuZGVjaWRlckZuKSB7XG4gICAgICBzdHJ1Y3R1cmUuaGFzRGVjaWRlciA9IHRydWU7XG4gICAgICBzdHJ1Y3R1cmUuYnJhbmNoSWRzID0gbm9kZS5jaGlsZHJlbj8ubWFwKChjKSA9PiBjLmlkKTtcbiAgICB9XG5cbiAgICBpZiAobm9kZS5zZWxlY3RvckZuIHx8IG5vZGUubmV4dE5vZGVTZWxlY3Rvcikge1xuICAgICAgc3RydWN0dXJlLmhhc1NlbGVjdG9yID0gdHJ1ZTtcbiAgICAgIHN0cnVjdHVyZS5icmFuY2hJZHMgPSBub2RlLmNoaWxkcmVuPy5tYXAoKGMpID0+IGMuaWQpO1xuICAgIH1cblxuICAgIGlmIChub2RlLmNoaWxkcmVuPy5sZW5ndGgpIHtcbiAgICAgIHN0cnVjdHVyZS5jaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4ubWFwKChjKSA9PiB0aGlzLnN0YWdlTm9kZVRvU3RydWN0dXJlKGMpKTtcbiAgICB9XG5cbiAgICBpZiAobm9kZS5uZXh0KSB7XG4gICAgICBzdHJ1Y3R1cmUubmV4dCA9IHRoaXMuc3RhZ2VOb2RlVG9TdHJ1Y3R1cmUobm9kZS5uZXh0KTtcbiAgICB9XG5cbiAgICBpZiAobm9kZS5zdWJmbG93RGVmPy5idWlsZFRpbWVTdHJ1Y3R1cmUpIHtcbiAgICAgIHN0cnVjdHVyZS5zdWJmbG93U3RydWN0dXJlID0gbm9kZS5zdWJmbG93RGVmLmJ1aWxkVGltZVN0cnVjdHVyZSBhcyBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmU7XG4gICAgfVxuXG4gICAgcmV0dXJuIHN0cnVjdHVyZTtcbiAgfVxuXG4gIC8qKiBVcGRhdGUgc3RydWN0dXJlIHdoZW4gZHluYW1pYyBjaGlsZHJlbiBhcmUgZGlzY292ZXJlZCBhdCBydW50aW1lLiAqL1xuICB1cGRhdGVEeW5hbWljQ2hpbGRyZW4oXG4gICAgcGFyZW50Tm9kZUlkOiBzdHJpbmcsXG4gICAgZHluYW1pY0NoaWxkcmVuOiBTdGFnZU5vZGVbXSxcbiAgICBoYXNTZWxlY3Rvcj86IGJvb2xlYW4sXG4gICAgaGFzRGVjaWRlcj86IGJvb2xlYW4sXG4gICk6IHZvaWQge1xuICAgIGlmICghdGhpcy5ydW50aW1lUGlwZWxpbmVTdHJ1Y3R1cmUpIHJldHVybjtcblxuICAgIGNvbnN0IHBhcmVudFN0cnVjdHVyZSA9IHRoaXMuc3RydWN0dXJlTm9kZU1hcC5nZXQocGFyZW50Tm9kZUlkKTtcbiAgICBpZiAoIXBhcmVudFN0cnVjdHVyZSkge1xuICAgICAgaWYgKGlzRGV2TW9kZSgpKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgICBgW2Zvb3RwcmludF0gUnVudGltZVN0cnVjdHVyZU1hbmFnZXI6IG5vZGUgJyR7cGFyZW50Tm9kZUlkfScgbm90IGZvdW5kIGluIHN0cnVjdHVyZSBtYXAg4oCUIHNuYXBzaG90IHZpc3VhbGl6YXRpb24gbWF5IGJlIGluY29tcGxldGVgLFxuICAgICAgICApO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IGNoaWxkU3RydWN0dXJlcyA9IGR5bmFtaWNDaGlsZHJlbi5tYXAoKGNoaWxkKSA9PiB0aGlzLnN0YWdlTm9kZVRvU3RydWN0dXJlKGNoaWxkKSk7XG4gICAgcGFyZW50U3RydWN0dXJlLmNoaWxkcmVuID0gY2hpbGRTdHJ1Y3R1cmVzO1xuXG4gICAgZm9yIChjb25zdCBjaGlsZFN0cnVjdHVyZSBvZiBjaGlsZFN0cnVjdHVyZXMpIHtcbiAgICAgIHRoaXMuYnVpbGROb2RlTWFwKGNoaWxkU3RydWN0dXJlKTtcbiAgICB9XG5cbiAgICBpZiAoaGFzU2VsZWN0b3IpIHtcbiAgICAgIHBhcmVudFN0cnVjdHVyZS5oYXNTZWxlY3RvciA9IHRydWU7XG4gICAgICBwYXJlbnRTdHJ1Y3R1cmUuYnJhbmNoSWRzID0gY2hpbGRTdHJ1Y3R1cmVzLm1hcCgoYykgPT4gYy5pZCk7XG4gICAgfVxuXG4gICAgaWYgKGhhc0RlY2lkZXIpIHtcbiAgICAgIHBhcmVudFN0cnVjdHVyZS5oYXNEZWNpZGVyID0gdHJ1ZTtcbiAgICAgIHBhcmVudFN0cnVjdHVyZS5icmFuY2hJZHMgPSBjaGlsZFN0cnVjdHVyZXMubWFwKChjKSA9PiBjLmlkKTtcbiAgICB9XG4gIH1cblxuICAvKiogVXBkYXRlIHN0cnVjdHVyZSB3aGVuIGEgZHluYW1pYyBzdWJmbG93IGlzIHJlZ2lzdGVyZWQgYXQgcnVudGltZS4gKi9cbiAgdXBkYXRlRHluYW1pY1N1YmZsb3coXG4gICAgbW91bnROb2RlSWQ6IHN0cmluZyxcbiAgICBzdWJmbG93SWQ6IHN0cmluZyxcbiAgICBzdWJmbG93TmFtZT86IHN0cmluZyxcbiAgICBzdWJmbG93QnVpbGRUaW1lU3RydWN0dXJlPzogdW5rbm93bixcbiAgKTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnJ1bnRpbWVQaXBlbGluZVN0cnVjdHVyZSkgcmV0dXJuO1xuXG4gICAgY29uc3QgbW91bnRTdHJ1Y3R1cmUgPSB0aGlzLnN0cnVjdHVyZU5vZGVNYXAuZ2V0KG1vdW50Tm9kZUlkKTtcbiAgICBpZiAoIW1vdW50U3RydWN0dXJlKSB7XG4gICAgICBpZiAoaXNEZXZNb2RlKCkpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFxuICAgICAgICAgIGBbZm9vdHByaW50XSBSdW50aW1lU3RydWN0dXJlTWFuYWdlcjogbm9kZSAnJHttb3VudE5vZGVJZH0nIG5vdCBmb3VuZCBpbiBzdHJ1Y3R1cmUgbWFwIOKAlCBzbmFwc2hvdCB2aXN1YWxpemF0aW9uIG1heSBiZSBpbmNvbXBsZXRlYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBtb3VudFN0cnVjdHVyZS5pc1N1YmZsb3dSb290ID0gdHJ1ZTtcbiAgICBtb3VudFN0cnVjdHVyZS5zdWJmbG93SWQgPSBzdWJmbG93SWQ7XG5cbiAgICBpZiAoc3ViZmxvd05hbWUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgbW91bnRTdHJ1Y3R1cmUuc3ViZmxvd05hbWUgPSBzdWJmbG93TmFtZTtcbiAgICB9XG5cbiAgICBpZiAoc3ViZmxvd0J1aWxkVGltZVN0cnVjdHVyZSkge1xuICAgICAgLy8gRGVlcC1jb3B5IHRvIHByZXZlbnQgZXh0ZXJuYWwgbXV0YXRpb24gb2YgdGhlIHN0b3JlZCBzdHJ1Y3R1cmVcbiAgICAgIHRyeSB7XG4gICAgICAgIG1vdW50U3RydWN0dXJlLnN1YmZsb3dTdHJ1Y3R1cmUgPSBKU09OLnBhcnNlKFxuICAgICAgICAgIEpTT04uc3RyaW5naWZ5KHN1YmZsb3dCdWlsZFRpbWVTdHJ1Y3R1cmUpLFxuICAgICAgICApIGFzIFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZTtcbiAgICAgICAgdGhpcy5idWlsZE5vZGVNYXAobW91bnRTdHJ1Y3R1cmUuc3ViZmxvd1N0cnVjdHVyZSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLy8gTm9uLXNlcmlhbGl6YWJsZSBzdWJmbG93IHN0cnVjdHVyZSDigJQgc2tpcCBzdWJmbG93IHN0cnVjdHVyZSB0cmFja2luZyBncmFjZWZ1bGx5LlxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8qKiBVcGRhdGUgc3RydWN0dXJlIHdoZW4gYSBkeW5hbWljIG5leHQgY2hhaW4gaXMgZGlzY292ZXJlZCBhdCBydW50aW1lLiAqL1xuICB1cGRhdGVEeW5hbWljTmV4dChjdXJyZW50Tm9kZUlkOiBzdHJpbmcsIGR5bmFtaWNOZXh0OiBTdGFnZU5vZGUpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMucnVudGltZVBpcGVsaW5lU3RydWN0dXJlKSByZXR1cm47XG5cbiAgICBjb25zdCBjdXJyZW50U3RydWN0dXJlID0gdGhpcy5zdHJ1Y3R1cmVOb2RlTWFwLmdldChjdXJyZW50Tm9kZUlkKTtcbiAgICBpZiAoIWN1cnJlbnRTdHJ1Y3R1cmUpIHtcbiAgICAgIGlmIChpc0Rldk1vZGUoKSkge1xuICAgICAgICBjb25zb2xlLndhcm4oXG4gICAgICAgICAgYFtmb290cHJpbnRdIFJ1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyOiBub2RlICcke2N1cnJlbnROb2RlSWR9JyBub3QgZm91bmQgaW4gc3RydWN0dXJlIG1hcCDigJQgc25hcHNob3QgdmlzdWFsaXphdGlvbiBtYXkgYmUgaW5jb21wbGV0ZWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgbmV4dFN0cnVjdHVyZSA9IHRoaXMuc3RhZ2VOb2RlVG9TdHJ1Y3R1cmUoZHluYW1pY05leHQpO1xuICAgIGN1cnJlbnRTdHJ1Y3R1cmUubmV4dCA9IG5leHRTdHJ1Y3R1cmU7XG4gICAgdGhpcy5idWlsZE5vZGVNYXAobmV4dFN0cnVjdHVyZSk7XG4gIH1cblxuICAvKiogVXBkYXRlIHRoZSBpdGVyYXRpb24gY291bnQgZm9yIGEgbm9kZSAobG9vcCBzdXBwb3J0KS4gKi9cbiAgdXBkYXRlSXRlcmF0aW9uQ291bnQobm9kZUlkOiBzdHJpbmcsIGNvdW50OiBudW1iZXIpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMucnVudGltZVBpcGVsaW5lU3RydWN0dXJlKSByZXR1cm47XG4gICAgY29uc3Qgbm9kZVN0cnVjdHVyZSA9IHRoaXMuc3RydWN0dXJlTm9kZU1hcC5nZXQobm9kZUlkKTtcbiAgICBpZiAoIW5vZGVTdHJ1Y3R1cmUpIHJldHVybjtcbiAgICBub2RlU3RydWN0dXJlLml0ZXJhdGlvbkNvdW50ID0gY291bnQ7XG4gIH1cbn1cbiJdfQ==