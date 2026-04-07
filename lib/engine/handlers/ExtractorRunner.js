"use strict";
/**
 * ExtractorRunner — Per-stage snapshot extraction.
 *
 * Coordinates traversal extractor invocations: step counting,
 * snapshot enrichment, error collection, and result storage.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExtractorRunner = void 0;
const RuntimeStructureManager_js_1 = require("./RuntimeStructureManager.js");
class ExtractorRunner {
    constructor(extractor, enrichSnapshots, executionRuntime, logger) {
        this.extractedResults = new Map();
        this.extractorErrors = [];
        this.stepCounter = 0;
        this.extractor = extractor;
        this.enrichSnapshots = enrichSnapshots;
        this.executionRuntime = executionRuntime;
        this.logger = logger;
    }
    /**
     * Call the extractor for a stage and store the result.
     * Increments stepCounter (1-based) before creating snapshot.
     */
    callExtractor(node, context, stagePath, stageOutput, errorInfo) {
        var _a;
        if (!this.extractor)
            return;
        this.stepCounter++;
        try {
            const snapshot = {
                node,
                context,
                stepNumber: this.stepCounter,
                structureMetadata: this.buildStructureMetadata(node),
            };
            if (this.enrichSnapshots) {
                try {
                    snapshot.scopeState = { ...this.executionRuntime.globalStore.getState() };
                    snapshot.debugInfo = {
                        logs: { ...context.debug.logContext },
                        errors: { ...context.debug.errorContext },
                        metrics: { ...context.debug.metricContext },
                        evals: { ...context.debug.evalContext },
                    };
                    if (context.debug.flowMessages.length > 0) {
                        snapshot.debugInfo.flowMessages = [...context.debug.flowMessages];
                    }
                    snapshot.stageOutput = stageOutput;
                    if (errorInfo) {
                        snapshot.errorInfo = errorInfo;
                    }
                    snapshot.historyIndex = this.executionRuntime.executionHistory.list().length;
                }
                catch (enrichError) {
                    this.logger.warn(`Enrichment error at stage '${stagePath}':`, { error: enrichError });
                }
            }
            const result = this.extractor(snapshot);
            if (result !== undefined && result !== null) {
                this.extractedResults.set(stagePath, result);
            }
        }
        catch (error) {
            this.logger.error(`Extractor error at stage '${stagePath}':`, { error });
            this.extractorErrors.push({
                stagePath,
                message: (_a = error === null || error === void 0 ? void 0 : error.message) !== null && _a !== void 0 ? _a : String(error),
                error,
            });
        }
    }
    /**
     * Generate the stage path for extractor results.
     * Uses node.id combined with branchPath.
     */
    getStagePath(node, branchPath, contextStageName) {
        const baseName = node.id;
        const nodeId = contextStageName && contextStageName !== node.name ? contextStageName : baseName;
        if (!branchPath)
            return nodeId;
        return `${branchPath}.${nodeId}`;
    }
    buildStructureMetadata(node) {
        var _a;
        const metadata = {
            type: (0, RuntimeStructureManager_js_1.computeNodeType)(node),
        };
        if (node.isSubflowRoot) {
            metadata.isSubflowRoot = true;
            metadata.subflowId = node.subflowId;
            metadata.subflowName = node.subflowName;
        }
        else if (this.currentSubflowId) {
            metadata.subflowId = this.currentSubflowId;
        }
        if (this.currentForkId) {
            metadata.isParallelChild = true;
            metadata.parallelGroupId = this.currentForkId;
        }
        if (node.isStreaming) {
            metadata.streamId = node.streamId;
        }
        const hasDynamicChildren = Boolean(((_a = node.children) === null || _a === void 0 ? void 0 : _a.length) && !node.nextNodeSelector && node.fn);
        if (hasDynamicChildren) {
            metadata.isDynamic = true;
        }
        return metadata;
    }
    /** Returns extracted results collected during execution. */
    getExtractedResults() {
        return this.extractedResults;
    }
    /** Returns errors encountered during extraction. */
    getExtractorErrors() {
        return this.extractorErrors;
    }
}
exports.ExtractorRunner = ExtractorRunner;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXh0cmFjdG9yUnVubmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvaGFuZGxlcnMvRXh0cmFjdG9yUnVubmVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7O0FBWUgsNkVBQStEO0FBRS9ELE1BQWEsZUFBZTtJQWdCMUIsWUFDRSxTQUF5QyxFQUN6QyxlQUF3QixFQUN4QixnQkFBbUMsRUFDbkMsTUFBZTtRQWRULHFCQUFnQixHQUF5QixJQUFJLEdBQUcsRUFBRSxDQUFDO1FBQ25ELG9CQUFlLEdBQXFCLEVBQUUsQ0FBQztRQUN2QyxnQkFBVyxHQUFHLENBQUMsQ0FBQztRQWN0QixJQUFJLENBQUMsU0FBUyxHQUFHLFNBQVMsQ0FBQztRQUMzQixJQUFJLENBQUMsZUFBZSxHQUFHLGVBQWUsQ0FBQztRQUN2QyxJQUFJLENBQUMsZ0JBQWdCLEdBQUcsZ0JBQWdCLENBQUM7UUFDekMsSUFBSSxDQUFDLE1BQU0sR0FBRyxNQUFNLENBQUM7SUFDdkIsQ0FBQztJQUVEOzs7T0FHRztJQUNILGFBQWEsQ0FDWCxJQUFlLEVBQ2YsT0FBcUIsRUFDckIsU0FBaUIsRUFDakIsV0FBcUIsRUFDckIsU0FBNkM7O1FBRTdDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUztZQUFFLE9BQU87UUFFNUIsSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBRW5CLElBQUksQ0FBQztZQUNILE1BQU0sUUFBUSxHQUFrQjtnQkFDOUIsSUFBSTtnQkFDSixPQUFPO2dCQUNQLFVBQVUsRUFBRSxJQUFJLENBQUMsV0FBVztnQkFDNUIsaUJBQWlCLEVBQUUsSUFBSSxDQUFDLHNCQUFzQixDQUFDLElBQUksQ0FBQzthQUNyRCxDQUFDO1lBRUYsSUFBSSxJQUFJLENBQUMsZUFBZSxFQUFFLENBQUM7Z0JBQ3pCLElBQUksQ0FBQztvQkFDSCxRQUFRLENBQUMsVUFBVSxHQUFHLEVBQUUsR0FBRyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsV0FBVyxDQUFDLFFBQVEsRUFBRSxFQUFFLENBQUM7b0JBRTFFLFFBQVEsQ0FBQyxTQUFTLEdBQUc7d0JBQ25CLElBQUksRUFBRSxFQUFFLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxVQUFVLEVBQUU7d0JBQ3JDLE1BQU0sRUFBRSxFQUFFLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQUU7d0JBQ3pDLE9BQU8sRUFBRSxFQUFFLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxhQUFhLEVBQUU7d0JBQzNDLEtBQUssRUFBRSxFQUFFLEdBQUcsT0FBTyxDQUFDLEtBQUssQ0FBQyxXQUFXLEVBQUU7cUJBQ3hDLENBQUM7b0JBQ0YsSUFBSSxPQUFPLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUM7d0JBQzFDLFFBQVEsQ0FBQyxTQUFTLENBQUMsWUFBWSxHQUFHLENBQUMsR0FBRyxPQUFPLENBQUMsS0FBSyxDQUFDLFlBQVksQ0FBQyxDQUFDO29CQUNwRSxDQUFDO29CQUVELFFBQVEsQ0FBQyxXQUFXLEdBQUcsV0FBVyxDQUFDO29CQUVuQyxJQUFJLFNBQVMsRUFBRSxDQUFDO3dCQUNkLFFBQVEsQ0FBQyxTQUFTLEdBQUcsU0FBUyxDQUFDO29CQUNqQyxDQUFDO29CQUVELFFBQVEsQ0FBQyxZQUFZLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDLGdCQUFnQixDQUFDLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQztnQkFDL0UsQ0FBQztnQkFBQyxPQUFPLFdBQWdCLEVBQUUsQ0FBQztvQkFDMUIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsOEJBQThCLFNBQVMsSUFBSSxFQUFFLEVBQUUsS0FBSyxFQUFFLFdBQVcsRUFBRSxDQUFDLENBQUM7Z0JBQ3hGLENBQUM7WUFDSCxDQUFDO1lBRUQsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsQ0FBQztZQUV4QyxJQUFJLE1BQU0sS0FBSyxTQUFTLElBQUksTUFBTSxLQUFLLElBQUksRUFBRSxDQUFDO2dCQUM1QyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxNQUFNLENBQUMsQ0FBQztZQUMvQyxDQUFDO1FBQ0gsQ0FBQztRQUFDLE9BQU8sS0FBVSxFQUFFLENBQUM7WUFDcEIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsNkJBQTZCLFNBQVMsSUFBSSxFQUFFLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztZQUN6RSxJQUFJLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQztnQkFDeEIsU0FBUztnQkFDVCxPQUFPLEVBQUUsTUFBQSxLQUFLLGFBQUwsS0FBSyx1QkFBTCxLQUFLLENBQUUsT0FBTyxtQ0FBSSxNQUFNLENBQUMsS0FBSyxDQUFDO2dCQUN4QyxLQUFLO2FBQ04sQ0FBQyxDQUFDO1FBQ0wsQ0FBQztJQUNILENBQUM7SUFFRDs7O09BR0c7SUFDSCxZQUFZLENBQUMsSUFBZSxFQUFFLFVBQW1CLEVBQUUsZ0JBQXlCO1FBQzFFLE1BQU0sUUFBUSxHQUFHLElBQUksQ0FBQyxFQUFFLENBQUM7UUFDekIsTUFBTSxNQUFNLEdBQUcsZ0JBQWdCLElBQUksZ0JBQWdCLEtBQUssSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztRQUNoRyxJQUFJLENBQUMsVUFBVTtZQUFFLE9BQU8sTUFBTSxDQUFDO1FBQy9CLE9BQU8sR0FBRyxVQUFVLElBQUksTUFBTSxFQUFFLENBQUM7SUFDbkMsQ0FBQztJQUVPLHNCQUFzQixDQUFDLElBQWU7O1FBQzVDLE1BQU0sUUFBUSxHQUE2QjtZQUN6QyxJQUFJLEVBQUUsSUFBQSw0Q0FBZSxFQUFDLElBQUksQ0FBQztTQUM1QixDQUFDO1FBRUYsSUFBSSxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7WUFDdkIsUUFBUSxDQUFDLGFBQWEsR0FBRyxJQUFJLENBQUM7WUFDOUIsUUFBUSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDO1lBQ3BDLFFBQVEsQ0FBQyxXQUFXLEdBQUcsSUFBSSxDQUFDLFdBQVcsQ0FBQztRQUMxQyxDQUFDO2FBQU0sSUFBSSxJQUFJLENBQUMsZ0JBQWdCLEVBQUUsQ0FBQztZQUNqQyxRQUFRLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxnQkFBZ0IsQ0FBQztRQUM3QyxDQUFDO1FBRUQsSUFBSSxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7WUFDdkIsUUFBUSxDQUFDLGVBQWUsR0FBRyxJQUFJLENBQUM7WUFDaEMsUUFBUSxDQUFDLGVBQWUsR0FBRyxJQUFJLENBQUMsYUFBYSxDQUFDO1FBQ2hELENBQUM7UUFFRCxJQUFJLElBQUksQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUNyQixRQUFRLENBQUMsUUFBUSxHQUFHLElBQUksQ0FBQyxRQUFRLENBQUM7UUFDcEMsQ0FBQztRQUVELE1BQU0sa0JBQWtCLEdBQUcsT0FBTyxDQUFDLENBQUEsTUFBQSxJQUFJLENBQUMsUUFBUSwwQ0FBRSxNQUFNLEtBQUksQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLElBQUksSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQy9GLElBQUksa0JBQWtCLEVBQUUsQ0FBQztZQUN2QixRQUFRLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQztRQUM1QixDQUFDO1FBRUQsT0FBTyxRQUFRLENBQUM7SUFDbEIsQ0FBQztJQUVELDREQUE0RDtJQUM1RCxtQkFBbUI7UUFDakIsT0FBTyxJQUFJLENBQUMsZ0JBQXdDLENBQUM7SUFDdkQsQ0FBQztJQUVELG9EQUFvRDtJQUNwRCxrQkFBa0I7UUFDaEIsT0FBTyxJQUFJLENBQUMsZUFBZSxDQUFDO0lBQzlCLENBQUM7Q0FDRjtBQTlJRCwwQ0E4SUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEV4dHJhY3RvclJ1bm5lciDigJQgUGVyLXN0YWdlIHNuYXBzaG90IGV4dHJhY3Rpb24uXG4gKlxuICogQ29vcmRpbmF0ZXMgdHJhdmVyc2FsIGV4dHJhY3RvciBpbnZvY2F0aW9uczogc3RlcCBjb3VudGluZyxcbiAqIHNuYXBzaG90IGVucmljaG1lbnQsIGVycm9yIGNvbGxlY3Rpb24sIGFuZCByZXN1bHQgc3RvcmFnZS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFN0YWdlQ29udGV4dCB9IGZyb20gJy4uLy4uL21lbW9yeS9TdGFnZUNvbnRleHQuanMnO1xuaW1wb3J0IHR5cGUgeyBTdGFnZU5vZGUgfSBmcm9tICcuLi9ncmFwaC9TdGFnZU5vZGUuanMnO1xuaW1wb3J0IHR5cGUge1xuICBFeHRyYWN0b3JFcnJvcixcbiAgSUV4ZWN1dGlvblJ1bnRpbWUsXG4gIElMb2dnZXIsXG4gIFJ1bnRpbWVTdHJ1Y3R1cmVNZXRhZGF0YSxcbiAgU3RhZ2VTbmFwc2hvdCxcbiAgVHJhdmVyc2FsRXh0cmFjdG9yLFxufSBmcm9tICcuLi90eXBlcy5qcyc7XG5pbXBvcnQgeyBjb21wdXRlTm9kZVR5cGUgfSBmcm9tICcuL1J1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyLmpzJztcblxuZXhwb3J0IGNsYXNzIEV4dHJhY3RvclJ1bm5lcjxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+IHtcbiAgcHJpdmF0ZSByZWFkb25seSBleHRyYWN0b3I/OiBUcmF2ZXJzYWxFeHRyYWN0b3I7XG4gIHByaXZhdGUgcmVhZG9ubHkgZW5yaWNoU25hcHNob3RzOiBib29sZWFuO1xuICBwcml2YXRlIHJlYWRvbmx5IGV4ZWN1dGlvblJ1bnRpbWU6IElFeGVjdXRpb25SdW50aW1lO1xuICBwcml2YXRlIHJlYWRvbmx5IGxvZ2dlcjogSUxvZ2dlcjtcblxuICBwcml2YXRlIGV4dHJhY3RlZFJlc3VsdHM6IE1hcDxzdHJpbmcsIHVua25vd24+ID0gbmV3IE1hcCgpO1xuICBwcml2YXRlIGV4dHJhY3RvckVycm9yczogRXh0cmFjdG9yRXJyb3JbXSA9IFtdO1xuICBwcml2YXRlIHN0ZXBDb3VudGVyID0gMDtcblxuICAvKiogQ3VycmVudCBzdWJmbG93IGNvbnRleHQgZm9yIG1ldGFkYXRhIHByb3BhZ2F0aW9uLiBTZXQvY2xlYXJlZCBkdXJpbmcgc3ViZmxvdyBleGVjdXRpb24uICovXG4gIGN1cnJlbnRTdWJmbG93SWQ/OiBzdHJpbmc7XG5cbiAgLyoqIEN1cnJlbnQgZm9yayBjb250ZXh0IGZvciBtZXRhZGF0YSBwcm9wYWdhdGlvbi4gU2V0L2NsZWFyZWQgZHVyaW5nIHBhcmFsbGVsIGNoaWxkcmVuIGV4ZWN1dGlvbi4gKi9cbiAgY3VycmVudEZvcmtJZD86IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihcbiAgICBleHRyYWN0b3I6IFRyYXZlcnNhbEV4dHJhY3RvciB8IHVuZGVmaW5lZCxcbiAgICBlbnJpY2hTbmFwc2hvdHM6IGJvb2xlYW4sXG4gICAgZXhlY3V0aW9uUnVudGltZTogSUV4ZWN1dGlvblJ1bnRpbWUsXG4gICAgbG9nZ2VyOiBJTG9nZ2VyLFxuICApIHtcbiAgICB0aGlzLmV4dHJhY3RvciA9IGV4dHJhY3RvcjtcbiAgICB0aGlzLmVucmljaFNuYXBzaG90cyA9IGVucmljaFNuYXBzaG90cztcbiAgICB0aGlzLmV4ZWN1dGlvblJ1bnRpbWUgPSBleGVjdXRpb25SdW50aW1lO1xuICAgIHRoaXMubG9nZ2VyID0gbG9nZ2VyO1xuICB9XG5cbiAgLyoqXG4gICAqIENhbGwgdGhlIGV4dHJhY3RvciBmb3IgYSBzdGFnZSBhbmQgc3RvcmUgdGhlIHJlc3VsdC5cbiAgICogSW5jcmVtZW50cyBzdGVwQ291bnRlciAoMS1iYXNlZCkgYmVmb3JlIGNyZWF0aW5nIHNuYXBzaG90LlxuICAgKi9cbiAgY2FsbEV4dHJhY3RvcihcbiAgICBub2RlOiBTdGFnZU5vZGUsXG4gICAgY29udGV4dDogU3RhZ2VDb250ZXh0LFxuICAgIHN0YWdlUGF0aDogc3RyaW5nLFxuICAgIHN0YWdlT3V0cHV0PzogdW5rbm93bixcbiAgICBlcnJvckluZm8/OiB7IHR5cGU6IHN0cmluZzsgbWVzc2FnZTogc3RyaW5nIH0sXG4gICk6IHZvaWQge1xuICAgIGlmICghdGhpcy5leHRyYWN0b3IpIHJldHVybjtcblxuICAgIHRoaXMuc3RlcENvdW50ZXIrKztcblxuICAgIHRyeSB7XG4gICAgICBjb25zdCBzbmFwc2hvdDogU3RhZ2VTbmFwc2hvdCA9IHtcbiAgICAgICAgbm9kZSxcbiAgICAgICAgY29udGV4dCxcbiAgICAgICAgc3RlcE51bWJlcjogdGhpcy5zdGVwQ291bnRlcixcbiAgICAgICAgc3RydWN0dXJlTWV0YWRhdGE6IHRoaXMuYnVpbGRTdHJ1Y3R1cmVNZXRhZGF0YShub2RlKSxcbiAgICAgIH07XG5cbiAgICAgIGlmICh0aGlzLmVucmljaFNuYXBzaG90cykge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHNuYXBzaG90LnNjb3BlU3RhdGUgPSB7IC4uLnRoaXMuZXhlY3V0aW9uUnVudGltZS5nbG9iYWxTdG9yZS5nZXRTdGF0ZSgpIH07XG5cbiAgICAgICAgICBzbmFwc2hvdC5kZWJ1Z0luZm8gPSB7XG4gICAgICAgICAgICBsb2dzOiB7IC4uLmNvbnRleHQuZGVidWcubG9nQ29udGV4dCB9LFxuICAgICAgICAgICAgZXJyb3JzOiB7IC4uLmNvbnRleHQuZGVidWcuZXJyb3JDb250ZXh0IH0sXG4gICAgICAgICAgICBtZXRyaWNzOiB7IC4uLmNvbnRleHQuZGVidWcubWV0cmljQ29udGV4dCB9LFxuICAgICAgICAgICAgZXZhbHM6IHsgLi4uY29udGV4dC5kZWJ1Zy5ldmFsQ29udGV4dCB9LFxuICAgICAgICAgIH07XG4gICAgICAgICAgaWYgKGNvbnRleHQuZGVidWcuZmxvd01lc3NhZ2VzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNuYXBzaG90LmRlYnVnSW5mby5mbG93TWVzc2FnZXMgPSBbLi4uY29udGV4dC5kZWJ1Zy5mbG93TWVzc2FnZXNdO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHNuYXBzaG90LnN0YWdlT3V0cHV0ID0gc3RhZ2VPdXRwdXQ7XG5cbiAgICAgICAgICBpZiAoZXJyb3JJbmZvKSB7XG4gICAgICAgICAgICBzbmFwc2hvdC5lcnJvckluZm8gPSBlcnJvckluZm87XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgc25hcHNob3QuaGlzdG9yeUluZGV4ID0gdGhpcy5leGVjdXRpb25SdW50aW1lLmV4ZWN1dGlvbkhpc3RvcnkubGlzdCgpLmxlbmd0aDtcbiAgICAgICAgfSBjYXRjaCAoZW5yaWNoRXJyb3I6IGFueSkge1xuICAgICAgICAgIHRoaXMubG9nZ2VyLndhcm4oYEVucmljaG1lbnQgZXJyb3IgYXQgc3RhZ2UgJyR7c3RhZ2VQYXRofSc6YCwgeyBlcnJvcjogZW5yaWNoRXJyb3IgfSk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc3QgcmVzdWx0ID0gdGhpcy5leHRyYWN0b3Ioc25hcHNob3QpO1xuXG4gICAgICBpZiAocmVzdWx0ICE9PSB1bmRlZmluZWQgJiYgcmVzdWx0ICE9PSBudWxsKSB7XG4gICAgICAgIHRoaXMuZXh0cmFjdGVkUmVzdWx0cy5zZXQoc3RhZ2VQYXRoLCByZXN1bHQpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgIHRoaXMubG9nZ2VyLmVycm9yKGBFeHRyYWN0b3IgZXJyb3IgYXQgc3RhZ2UgJyR7c3RhZ2VQYXRofSc6YCwgeyBlcnJvciB9KTtcbiAgICAgIHRoaXMuZXh0cmFjdG9yRXJyb3JzLnB1c2goe1xuICAgICAgICBzdGFnZVBhdGgsXG4gICAgICAgIG1lc3NhZ2U6IGVycm9yPy5tZXNzYWdlID8/IFN0cmluZyhlcnJvciksXG4gICAgICAgIGVycm9yLFxuICAgICAgfSk7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEdlbmVyYXRlIHRoZSBzdGFnZSBwYXRoIGZvciBleHRyYWN0b3IgcmVzdWx0cy5cbiAgICogVXNlcyBub2RlLmlkIGNvbWJpbmVkIHdpdGggYnJhbmNoUGF0aC5cbiAgICovXG4gIGdldFN0YWdlUGF0aChub2RlOiBTdGFnZU5vZGUsIGJyYW5jaFBhdGg/OiBzdHJpbmcsIGNvbnRleHRTdGFnZU5hbWU/OiBzdHJpbmcpOiBzdHJpbmcge1xuICAgIGNvbnN0IGJhc2VOYW1lID0gbm9kZS5pZDtcbiAgICBjb25zdCBub2RlSWQgPSBjb250ZXh0U3RhZ2VOYW1lICYmIGNvbnRleHRTdGFnZU5hbWUgIT09IG5vZGUubmFtZSA/IGNvbnRleHRTdGFnZU5hbWUgOiBiYXNlTmFtZTtcbiAgICBpZiAoIWJyYW5jaFBhdGgpIHJldHVybiBub2RlSWQ7XG4gICAgcmV0dXJuIGAke2JyYW5jaFBhdGh9LiR7bm9kZUlkfWA7XG4gIH1cblxuICBwcml2YXRlIGJ1aWxkU3RydWN0dXJlTWV0YWRhdGEobm9kZTogU3RhZ2VOb2RlKTogUnVudGltZVN0cnVjdHVyZU1ldGFkYXRhIHtcbiAgICBjb25zdCBtZXRhZGF0YTogUnVudGltZVN0cnVjdHVyZU1ldGFkYXRhID0ge1xuICAgICAgdHlwZTogY29tcHV0ZU5vZGVUeXBlKG5vZGUpLFxuICAgIH07XG5cbiAgICBpZiAobm9kZS5pc1N1YmZsb3dSb290KSB7XG4gICAgICBtZXRhZGF0YS5pc1N1YmZsb3dSb290ID0gdHJ1ZTtcbiAgICAgIG1ldGFkYXRhLnN1YmZsb3dJZCA9IG5vZGUuc3ViZmxvd0lkO1xuICAgICAgbWV0YWRhdGEuc3ViZmxvd05hbWUgPSBub2RlLnN1YmZsb3dOYW1lO1xuICAgIH0gZWxzZSBpZiAodGhpcy5jdXJyZW50U3ViZmxvd0lkKSB7XG4gICAgICBtZXRhZGF0YS5zdWJmbG93SWQgPSB0aGlzLmN1cnJlbnRTdWJmbG93SWQ7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuY3VycmVudEZvcmtJZCkge1xuICAgICAgbWV0YWRhdGEuaXNQYXJhbGxlbENoaWxkID0gdHJ1ZTtcbiAgICAgIG1ldGFkYXRhLnBhcmFsbGVsR3JvdXBJZCA9IHRoaXMuY3VycmVudEZvcmtJZDtcbiAgICB9XG5cbiAgICBpZiAobm9kZS5pc1N0cmVhbWluZykge1xuICAgICAgbWV0YWRhdGEuc3RyZWFtSWQgPSBub2RlLnN0cmVhbUlkO1xuICAgIH1cblxuICAgIGNvbnN0IGhhc0R5bmFtaWNDaGlsZHJlbiA9IEJvb2xlYW4obm9kZS5jaGlsZHJlbj8ubGVuZ3RoICYmICFub2RlLm5leHROb2RlU2VsZWN0b3IgJiYgbm9kZS5mbik7XG4gICAgaWYgKGhhc0R5bmFtaWNDaGlsZHJlbikge1xuICAgICAgbWV0YWRhdGEuaXNEeW5hbWljID0gdHJ1ZTtcbiAgICB9XG5cbiAgICByZXR1cm4gbWV0YWRhdGE7XG4gIH1cblxuICAvKiogUmV0dXJucyBleHRyYWN0ZWQgcmVzdWx0cyBjb2xsZWN0ZWQgZHVyaW5nIGV4ZWN1dGlvbi4gKi9cbiAgZ2V0RXh0cmFjdGVkUmVzdWx0czxUUmVzdWx0ID0gdW5rbm93bj4oKTogTWFwPHN0cmluZywgVFJlc3VsdD4ge1xuICAgIHJldHVybiB0aGlzLmV4dHJhY3RlZFJlc3VsdHMgYXMgTWFwPHN0cmluZywgVFJlc3VsdD47XG4gIH1cblxuICAvKiogUmV0dXJucyBlcnJvcnMgZW5jb3VudGVyZWQgZHVyaW5nIGV4dHJhY3Rpb24uICovXG4gIGdldEV4dHJhY3RvckVycm9ycygpOiBFeHRyYWN0b3JFcnJvcltdIHtcbiAgICByZXR1cm4gdGhpcy5leHRyYWN0b3JFcnJvcnM7XG4gIH1cbn1cbiJdfQ==