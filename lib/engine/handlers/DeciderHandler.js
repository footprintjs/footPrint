"use strict";
/**
 * DeciderHandler — Single-choice conditional branching.
 *
 * Handles scope-based deciders (stage IS the decider, returns branch ID).
 * Logs flow control decisions and narrative sentences.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeciderHandler = void 0;
const types_js_1 = require("../../decide/types.js");
const types_js_2 = require("../../pause/types.js");
class DeciderHandler {
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Handle a scope-based decider (created via addDeciderFunction).
     * The stage function IS the decider — its return value is the branch ID.
     * Execution order: runStage(fn) → commit → resolve child → log → executeNode(child).
     */
    async handleScopeBased(node, stageFunc, context, breakFlag, branchPath, runStage, executeNode, callExtractor, getStagePath, traversalContext) {
        var _a, _b, _c;
        const breakFn = () => (breakFlag.shouldBreak = true);
        let branchId;
        let decisionEvidence;
        try {
            const stageOutput = await runStage(node, stageFunc, context, breakFn);
            // Detect DecisionResult from decide() helper via Symbol brand
            if (stageOutput && typeof stageOutput === 'object' && Reflect.has(stageOutput, types_js_1.DECISION_RESULT)) {
                branchId = stageOutput.branch;
                decisionEvidence = stageOutput.evidence;
            }
            else {
                branchId = String(stageOutput);
            }
        }
        catch (error) {
            // PauseSignal is expected control flow — commit and re-throw without error logging.
            if ((0, types_js_2.isPauseSignal)(error)) {
                context.commit();
                throw error;
            }
            context.commit();
            callExtractor(node, context, getStagePath(node, branchPath, context.stageName), undefined, {
                type: 'stageExecutionError',
                message: error.toString(),
            });
            this.deps.logger.error(`Error in pipeline (${branchPath}) stage [${node.name}]:`, { error });
            context.addError('stageExecutionError', error.toString());
            this.deps.narrativeGenerator.onError(node.name, error.toString(), error, traversalContext);
            throw error;
        }
        context.commit();
        callExtractor(node, context, getStagePath(node, branchPath, context.stageName), branchId);
        if (breakFlag.shouldBreak) {
            this.deps.logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
            return branchId;
        }
        // Resolve child by matching branch ID against node.children.
        // Match branchId first (original unprefixed ID), fall back to id for backward compat.
        const children = node.children;
        let chosen = children.find((child) => { var _a; return ((_a = child.branchId) !== null && _a !== void 0 ? _a : child.id) === branchId; });
        // Fall back to default branch
        if (!chosen) {
            const defaultChild = children.find((child) => { var _a; return ((_a = child.branchId) !== null && _a !== void 0 ? _a : child.id) === 'default'; });
            if (defaultChild) {
                chosen = defaultChild;
            }
            else {
                const errorMessage = `Scope-based decider '${node.name}' returned branch ID '${branchId}' which doesn't match any child and no default branch is set`;
                context.addError('deciderError', errorMessage);
                throw new Error(errorMessage);
            }
        }
        const chosenName = chosen.name;
        const wasDefault = ((_a = chosen.branchId) !== null && _a !== void 0 ? _a : chosen.id) !== branchId;
        const rationale = (_c = (_b = context.debug) === null || _b === void 0 ? void 0 : _b.logContext) === null || _c === void 0 ? void 0 : _c.deciderRationale;
        let branchReason;
        if (wasDefault) {
            branchReason = `Returned '${branchId}' (no match), fell back to default → ${chosenName} path.`;
        }
        else if (rationale) {
            branchReason = `Based on: ${rationale} → chose ${chosenName} path.`;
        }
        else {
            branchReason = `Evaluated scope and returned '${branchId}' → chose ${chosenName} path.`;
        }
        context.addFlowDebugMessage('branch', branchReason, {
            targetStage: chosen.name,
            rationale: rationale || `returned branchId: ${branchId}`,
        });
        this.deps.narrativeGenerator.onDecision(node.name, chosen.name, rationale, node.description, traversalContext, decisionEvidence);
        const branchContext = context.createChild(branchPath, chosen.id, chosen.name, chosen.id);
        return executeNode(chosen, branchContext, breakFlag, branchPath);
    }
}
exports.DeciderHandler = DeciderHandler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRGVjaWRlckhhbmRsZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9oYW5kbGVycy9EZWNpZGVySGFuZGxlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUdILG9EQUF3RDtBQUV4RCxtREFBcUQ7QUFRckQsTUFBYSxjQUFjO0lBQ3pCLFlBQTZCLElBQStCO1FBQS9CLFNBQUksR0FBSixJQUFJLENBQTJCO0lBQUcsQ0FBQztJQUVoRTs7OztPQUlHO0lBQ0gsS0FBSyxDQUFDLGdCQUFnQixDQUNwQixJQUE2QixFQUM3QixTQUFzQyxFQUN0QyxPQUFxQixFQUNyQixTQUFtQyxFQUNuQyxVQUE4QixFQUM5QixRQUFrQyxFQUNsQyxXQUF3QyxFQUN4QyxhQUE0QyxFQUM1QyxZQUEwQyxFQUMxQyxnQkFBbUM7O1FBRW5DLE1BQU0sT0FBTyxHQUFHLEdBQUcsRUFBRSxDQUFDLENBQUMsU0FBUyxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsQ0FBQztRQUVyRCxJQUFJLFFBQWdCLENBQUM7UUFDckIsSUFBSSxnQkFBOEMsQ0FBQztRQUNuRCxJQUFJLENBQUM7WUFDSCxNQUFNLFdBQVcsR0FBRyxNQUFNLFFBQVEsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQztZQUN0RSw4REFBOEQ7WUFDOUQsSUFBSSxXQUFXLElBQUksT0FBTyxXQUFXLEtBQUssUUFBUSxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUMsV0FBcUIsRUFBRSwwQkFBZSxDQUFDLEVBQUUsQ0FBQztnQkFDMUcsUUFBUSxHQUFJLFdBQW1CLENBQUMsTUFBTSxDQUFDO2dCQUN2QyxnQkFBZ0IsR0FBSSxXQUFtQixDQUFDLFFBQVEsQ0FBQztZQUNuRCxDQUFDO2lCQUFNLENBQUM7Z0JBQ04sUUFBUSxHQUFHLE1BQU0sQ0FBQyxXQUFXLENBQUMsQ0FBQztZQUNqQyxDQUFDO1FBQ0gsQ0FBQztRQUFDLE9BQU8sS0FBVSxFQUFFLENBQUM7WUFDcEIsb0ZBQW9GO1lBQ3BGLElBQUksSUFBQSx3QkFBYSxFQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7Z0JBQ3pCLE9BQU8sQ0FBQyxNQUFNLEVBQUUsQ0FBQztnQkFDakIsTUFBTSxLQUFLLENBQUM7WUFDZCxDQUFDO1lBQ0QsT0FBTyxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQ2pCLGFBQWEsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFLFlBQVksQ0FBQyxJQUFJLEVBQUUsVUFBVSxFQUFFLE9BQU8sQ0FBQyxTQUFTLENBQUMsRUFBRSxTQUFTLEVBQUU7Z0JBQ3pGLElBQUksRUFBRSxxQkFBcUI7Z0JBQzNCLE9BQU8sRUFBRSxLQUFLLENBQUMsUUFBUSxFQUFFO2FBQzFCLENBQUMsQ0FBQztZQUNILElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxzQkFBc0IsVUFBVSxZQUFZLElBQUksQ0FBQyxJQUFJLElBQUksRUFBRSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7WUFDN0YsT0FBTyxDQUFDLFFBQVEsQ0FBQyxxQkFBcUIsRUFBRSxLQUFLLENBQUMsUUFBUSxFQUFFLENBQUMsQ0FBQztZQUMxRCxJQUFJLENBQUMsSUFBSSxDQUFDLGtCQUFrQixDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLEtBQUssQ0FBQyxRQUFRLEVBQUUsRUFBRSxLQUFLLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztZQUMzRixNQUFNLEtBQUssQ0FBQztRQUNkLENBQUM7UUFFRCxPQUFPLENBQUMsTUFBTSxFQUFFLENBQUM7UUFDakIsYUFBYSxDQUFDLElBQUksRUFBRSxPQUFPLEVBQUUsWUFBWSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUUsT0FBTyxDQUFDLFNBQVMsQ0FBQyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1FBRTFGLElBQUksU0FBUyxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQzFCLElBQUksQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxrQ0FBa0MsVUFBVSxXQUFXLElBQUksQ0FBQyxJQUFJLDBCQUEwQixDQUFDLENBQUM7WUFDbEgsT0FBTyxRQUFRLENBQUM7UUFDbEIsQ0FBQztRQUVELDZEQUE2RDtRQUM3RCxzRkFBc0Y7UUFDdEYsTUFBTSxRQUFRLEdBQUcsSUFBSSxDQUFDLFFBQXFDLENBQUM7UUFDNUQsSUFBSSxNQUFNLEdBQUcsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLFdBQUMsT0FBQSxDQUFDLE1BQUEsS0FBSyxDQUFDLFFBQVEsbUNBQUksS0FBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLFFBQVEsQ0FBQSxFQUFBLENBQUMsQ0FBQztRQUVqRiw4QkFBOEI7UUFDOUIsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQ1osTUFBTSxZQUFZLEdBQUcsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLFdBQUMsT0FBQSxDQUFDLE1BQUEsS0FBSyxDQUFDLFFBQVEsbUNBQUksS0FBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLLFNBQVMsQ0FBQSxFQUFBLENBQUMsQ0FBQztZQUMxRixJQUFJLFlBQVksRUFBRSxDQUFDO2dCQUNqQixNQUFNLEdBQUcsWUFBWSxDQUFDO1lBQ3hCLENBQUM7aUJBQU0sQ0FBQztnQkFDTixNQUFNLFlBQVksR0FBRyx3QkFBd0IsSUFBSSxDQUFDLElBQUkseUJBQXlCLFFBQVEsOERBQThELENBQUM7Z0JBQ3RKLE9BQU8sQ0FBQyxRQUFRLENBQUMsY0FBYyxFQUFFLFlBQVksQ0FBQyxDQUFDO2dCQUMvQyxNQUFNLElBQUksS0FBSyxDQUFDLFlBQVksQ0FBQyxDQUFDO1lBQ2hDLENBQUM7UUFDSCxDQUFDO1FBRUQsTUFBTSxVQUFVLEdBQUcsTUFBTSxDQUFDLElBQUksQ0FBQztRQUMvQixNQUFNLFVBQVUsR0FBRyxDQUFDLE1BQUEsTUFBTSxDQUFDLFFBQVEsbUNBQUksTUFBTSxDQUFDLEVBQUUsQ0FBQyxLQUFLLFFBQVEsQ0FBQztRQUMvRCxNQUFNLFNBQVMsR0FBRyxNQUFBLE1BQUEsT0FBTyxDQUFDLEtBQUssMENBQUUsVUFBVSwwQ0FBRSxnQkFBc0MsQ0FBQztRQUNwRixJQUFJLFlBQW9CLENBQUM7UUFDekIsSUFBSSxVQUFVLEVBQUUsQ0FBQztZQUNmLFlBQVksR0FBRyxhQUFhLFFBQVEsd0NBQXdDLFVBQVUsUUFBUSxDQUFDO1FBQ2pHLENBQUM7YUFBTSxJQUFJLFNBQVMsRUFBRSxDQUFDO1lBQ3JCLFlBQVksR0FBRyxhQUFhLFNBQVMsWUFBWSxVQUFVLFFBQVEsQ0FBQztRQUN0RSxDQUFDO2FBQU0sQ0FBQztZQUNOLFlBQVksR0FBRyxpQ0FBaUMsUUFBUSxhQUFhLFVBQVUsUUFBUSxDQUFDO1FBQzFGLENBQUM7UUFDRCxPQUFPLENBQUMsbUJBQW1CLENBQUMsUUFBUSxFQUFFLFlBQVksRUFBRTtZQUNsRCxXQUFXLEVBQUUsTUFBTSxDQUFDLElBQUk7WUFDeEIsU0FBUyxFQUFFLFNBQVMsSUFBSSxzQkFBc0IsUUFBUSxFQUFFO1NBQ3pELENBQUMsQ0FBQztRQUVILElBQUksQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsVUFBVSxDQUNyQyxJQUFJLENBQUMsSUFBSSxFQUNULE1BQU0sQ0FBQyxJQUFJLEVBQ1gsU0FBUyxFQUNULElBQUksQ0FBQyxXQUFXLEVBQ2hCLGdCQUFnQixFQUNoQixnQkFBZ0IsQ0FDakIsQ0FBQztRQUVGLE1BQU0sYUFBYSxHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQUMsVUFBb0IsRUFBRSxNQUFNLENBQUMsRUFBRSxFQUFFLE1BQU0sQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDO1FBQ25HLE9BQU8sV0FBVyxDQUFDLE1BQU0sRUFBRSxhQUFhLEVBQUUsU0FBUyxFQUFFLFVBQVUsQ0FBQyxDQUFDO0lBQ25FLENBQUM7Q0FDRjtBQXZHRCx3Q0F1R0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIERlY2lkZXJIYW5kbGVyIOKAlCBTaW5nbGUtY2hvaWNlIGNvbmRpdGlvbmFsIGJyYW5jaGluZy5cbiAqXG4gKiBIYW5kbGVzIHNjb3BlLWJhc2VkIGRlY2lkZXJzIChzdGFnZSBJUyB0aGUgZGVjaWRlciwgcmV0dXJucyBicmFuY2ggSUQpLlxuICogTG9ncyBmbG93IGNvbnRyb2wgZGVjaXNpb25zIGFuZCBuYXJyYXRpdmUgc2VudGVuY2VzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRGVjaXNpb25FdmlkZW5jZSB9IGZyb20gJy4uLy4uL2RlY2lkZS90eXBlcy5qcyc7XG5pbXBvcnQgeyBERUNJU0lPTl9SRVNVTFQgfSBmcm9tICcuLi8uLi9kZWNpZGUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBTdGFnZUNvbnRleHQgfSBmcm9tICcuLi8uLi9tZW1vcnkvU3RhZ2VDb250ZXh0LmpzJztcbmltcG9ydCB7IGlzUGF1c2VTaWduYWwgfSBmcm9tICcuLi8uLi9wYXVzZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IFN0YWdlTm9kZSB9IGZyb20gJy4uL2dyYXBoL1N0YWdlTm9kZS5qcyc7XG5pbXBvcnQgdHlwZSB7IFRyYXZlcnNhbENvbnRleHQgfSBmcm9tICcuLi9uYXJyYXRpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBIYW5kbGVyRGVwcywgU3RhZ2VGdW5jdGlvbiB9IGZyb20gJy4uL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgQ2FsbEV4dHJhY3RvckZuLCBFeGVjdXRlTm9kZUZuLCBHZXRTdGFnZVBhdGhGbiwgUnVuU3RhZ2VGbiB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5leHBvcnQgdHlwZSB7IENhbGxFeHRyYWN0b3JGbiwgRXhlY3V0ZU5vZGVGbiwgR2V0U3RhZ2VQYXRoRm4sIFJ1blN0YWdlRm4gfTtcblxuZXhwb3J0IGNsYXNzIERlY2lkZXJIYW5kbGVyPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBjb25zdHJ1Y3Rvcihwcml2YXRlIHJlYWRvbmx5IGRlcHM6IEhhbmRsZXJEZXBzPFRPdXQsIFRTY29wZT4pIHt9XG5cbiAgLyoqXG4gICAqIEhhbmRsZSBhIHNjb3BlLWJhc2VkIGRlY2lkZXIgKGNyZWF0ZWQgdmlhIGFkZERlY2lkZXJGdW5jdGlvbikuXG4gICAqIFRoZSBzdGFnZSBmdW5jdGlvbiBJUyB0aGUgZGVjaWRlciDigJQgaXRzIHJldHVybiB2YWx1ZSBpcyB0aGUgYnJhbmNoIElELlxuICAgKiBFeGVjdXRpb24gb3JkZXI6IHJ1blN0YWdlKGZuKSDihpIgY29tbWl0IOKGkiByZXNvbHZlIGNoaWxkIOKGkiBsb2cg4oaSIGV4ZWN1dGVOb2RlKGNoaWxkKS5cbiAgICovXG4gIGFzeW5jIGhhbmRsZVNjb3BlQmFzZWQoXG4gICAgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgc3RhZ2VGdW5jOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sXG4gICAgY29udGV4dDogU3RhZ2VDb250ZXh0LFxuICAgIGJyZWFrRmxhZzogeyBzaG91bGRCcmVhazogYm9vbGVhbiB9LFxuICAgIGJyYW5jaFBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBydW5TdGFnZTogUnVuU3RhZ2VGbjxUT3V0LCBUU2NvcGU+LFxuICAgIGV4ZWN1dGVOb2RlOiBFeGVjdXRlTm9kZUZuPFRPdXQsIFRTY29wZT4sXG4gICAgY2FsbEV4dHJhY3RvcjogQ2FsbEV4dHJhY3RvckZuPFRPdXQsIFRTY29wZT4sXG4gICAgZ2V0U3RhZ2VQYXRoOiBHZXRTdGFnZVBhdGhGbjxUT3V0LCBUU2NvcGU+LFxuICAgIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0LFxuICApOiBQcm9taXNlPGFueT4ge1xuICAgIGNvbnN0IGJyZWFrRm4gPSAoKSA9PiAoYnJlYWtGbGFnLnNob3VsZEJyZWFrID0gdHJ1ZSk7XG5cbiAgICBsZXQgYnJhbmNoSWQ6IHN0cmluZztcbiAgICBsZXQgZGVjaXNpb25FdmlkZW5jZTogRGVjaXNpb25FdmlkZW5jZSB8IHVuZGVmaW5lZDtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgc3RhZ2VPdXRwdXQgPSBhd2FpdCBydW5TdGFnZShub2RlLCBzdGFnZUZ1bmMsIGNvbnRleHQsIGJyZWFrRm4pO1xuICAgICAgLy8gRGV0ZWN0IERlY2lzaW9uUmVzdWx0IGZyb20gZGVjaWRlKCkgaGVscGVyIHZpYSBTeW1ib2wgYnJhbmRcbiAgICAgIGlmIChzdGFnZU91dHB1dCAmJiB0eXBlb2Ygc3RhZ2VPdXRwdXQgPT09ICdvYmplY3QnICYmIFJlZmxlY3QuaGFzKHN0YWdlT3V0cHV0IGFzIG9iamVjdCwgREVDSVNJT05fUkVTVUxUKSkge1xuICAgICAgICBicmFuY2hJZCA9IChzdGFnZU91dHB1dCBhcyBhbnkpLmJyYW5jaDtcbiAgICAgICAgZGVjaXNpb25FdmlkZW5jZSA9IChzdGFnZU91dHB1dCBhcyBhbnkpLmV2aWRlbmNlO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYnJhbmNoSWQgPSBTdHJpbmcoc3RhZ2VPdXRwdXQpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcbiAgICAgIC8vIFBhdXNlU2lnbmFsIGlzIGV4cGVjdGVkIGNvbnRyb2wgZmxvdyDigJQgY29tbWl0IGFuZCByZS10aHJvdyB3aXRob3V0IGVycm9yIGxvZ2dpbmcuXG4gICAgICBpZiAoaXNQYXVzZVNpZ25hbChlcnJvcikpIHtcbiAgICAgICAgY29udGV4dC5jb21taXQoKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgICBjb250ZXh0LmNvbW1pdCgpO1xuICAgICAgY2FsbEV4dHJhY3Rvcihub2RlLCBjb250ZXh0LCBnZXRTdGFnZVBhdGgobm9kZSwgYnJhbmNoUGF0aCwgY29udGV4dC5zdGFnZU5hbWUpLCB1bmRlZmluZWQsIHtcbiAgICAgICAgdHlwZTogJ3N0YWdlRXhlY3V0aW9uRXJyb3InLFxuICAgICAgICBtZXNzYWdlOiBlcnJvci50b1N0cmluZygpLFxuICAgICAgfSk7XG4gICAgICB0aGlzLmRlcHMubG9nZ2VyLmVycm9yKGBFcnJvciBpbiBwaXBlbGluZSAoJHticmFuY2hQYXRofSkgc3RhZ2UgWyR7bm9kZS5uYW1lfV06YCwgeyBlcnJvciB9KTtcbiAgICAgIGNvbnRleHQuYWRkRXJyb3IoJ3N0YWdlRXhlY3V0aW9uRXJyb3InLCBlcnJvci50b1N0cmluZygpKTtcbiAgICAgIHRoaXMuZGVwcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25FcnJvcihub2RlLm5hbWUsIGVycm9yLnRvU3RyaW5nKCksIGVycm9yLCB0cmF2ZXJzYWxDb250ZXh0KTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cblxuICAgIGNvbnRleHQuY29tbWl0KCk7XG4gICAgY2FsbEV4dHJhY3Rvcihub2RlLCBjb250ZXh0LCBnZXRTdGFnZVBhdGgobm9kZSwgYnJhbmNoUGF0aCwgY29udGV4dC5zdGFnZU5hbWUpLCBicmFuY2hJZCk7XG5cbiAgICBpZiAoYnJlYWtGbGFnLnNob3VsZEJyZWFrKSB7XG4gICAgICB0aGlzLmRlcHMubG9nZ2VyLmluZm8oYEV4ZWN1dGlvbiBzdG9wcGVkIGluIHBpcGVsaW5lICgke2JyYW5jaFBhdGh9KSBhZnRlciAke25vZGUubmFtZX0gZHVlIHRvIGJyZWFrIGNvbmRpdGlvbi5gKTtcbiAgICAgIHJldHVybiBicmFuY2hJZDtcbiAgICB9XG5cbiAgICAvLyBSZXNvbHZlIGNoaWxkIGJ5IG1hdGNoaW5nIGJyYW5jaCBJRCBhZ2FpbnN0IG5vZGUuY2hpbGRyZW4uXG4gICAgLy8gTWF0Y2ggYnJhbmNoSWQgZmlyc3QgKG9yaWdpbmFsIHVucHJlZml4ZWQgSUQpLCBmYWxsIGJhY2sgdG8gaWQgZm9yIGJhY2t3YXJkIGNvbXBhdC5cbiAgICBjb25zdCBjaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4gYXMgU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT5bXTtcbiAgICBsZXQgY2hvc2VuID0gY2hpbGRyZW4uZmluZCgoY2hpbGQpID0+IChjaGlsZC5icmFuY2hJZCA/PyBjaGlsZC5pZCkgPT09IGJyYW5jaElkKTtcblxuICAgIC8vIEZhbGwgYmFjayB0byBkZWZhdWx0IGJyYW5jaFxuICAgIGlmICghY2hvc2VuKSB7XG4gICAgICBjb25zdCBkZWZhdWx0Q2hpbGQgPSBjaGlsZHJlbi5maW5kKChjaGlsZCkgPT4gKGNoaWxkLmJyYW5jaElkID8/IGNoaWxkLmlkKSA9PT0gJ2RlZmF1bHQnKTtcbiAgICAgIGlmIChkZWZhdWx0Q2hpbGQpIHtcbiAgICAgICAgY2hvc2VuID0gZGVmYXVsdENoaWxkO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gYFNjb3BlLWJhc2VkIGRlY2lkZXIgJyR7bm9kZS5uYW1lfScgcmV0dXJuZWQgYnJhbmNoIElEICcke2JyYW5jaElkfScgd2hpY2ggZG9lc24ndCBtYXRjaCBhbnkgY2hpbGQgYW5kIG5vIGRlZmF1bHQgYnJhbmNoIGlzIHNldGA7XG4gICAgICAgIGNvbnRleHQuYWRkRXJyb3IoJ2RlY2lkZXJFcnJvcicsIGVycm9yTWVzc2FnZSk7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGNob3Nlbk5hbWUgPSBjaG9zZW4ubmFtZTtcbiAgICBjb25zdCB3YXNEZWZhdWx0ID0gKGNob3Nlbi5icmFuY2hJZCA/PyBjaG9zZW4uaWQpICE9PSBicmFuY2hJZDtcbiAgICBjb25zdCByYXRpb25hbGUgPSBjb250ZXh0LmRlYnVnPy5sb2dDb250ZXh0Py5kZWNpZGVyUmF0aW9uYWxlIGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICBsZXQgYnJhbmNoUmVhc29uOiBzdHJpbmc7XG4gICAgaWYgKHdhc0RlZmF1bHQpIHtcbiAgICAgIGJyYW5jaFJlYXNvbiA9IGBSZXR1cm5lZCAnJHticmFuY2hJZH0nIChubyBtYXRjaCksIGZlbGwgYmFjayB0byBkZWZhdWx0IOKGkiAke2Nob3Nlbk5hbWV9IHBhdGguYDtcbiAgICB9IGVsc2UgaWYgKHJhdGlvbmFsZSkge1xuICAgICAgYnJhbmNoUmVhc29uID0gYEJhc2VkIG9uOiAke3JhdGlvbmFsZX0g4oaSIGNob3NlICR7Y2hvc2VuTmFtZX0gcGF0aC5gO1xuICAgIH0gZWxzZSB7XG4gICAgICBicmFuY2hSZWFzb24gPSBgRXZhbHVhdGVkIHNjb3BlIGFuZCByZXR1cm5lZCAnJHticmFuY2hJZH0nIOKGkiBjaG9zZSAke2Nob3Nlbk5hbWV9IHBhdGguYDtcbiAgICB9XG4gICAgY29udGV4dC5hZGRGbG93RGVidWdNZXNzYWdlKCdicmFuY2gnLCBicmFuY2hSZWFzb24sIHtcbiAgICAgIHRhcmdldFN0YWdlOiBjaG9zZW4ubmFtZSxcbiAgICAgIHJhdGlvbmFsZTogcmF0aW9uYWxlIHx8IGByZXR1cm5lZCBicmFuY2hJZDogJHticmFuY2hJZH1gLFxuICAgIH0pO1xuXG4gICAgdGhpcy5kZXBzLm5hcnJhdGl2ZUdlbmVyYXRvci5vbkRlY2lzaW9uKFxuICAgICAgbm9kZS5uYW1lLFxuICAgICAgY2hvc2VuLm5hbWUsXG4gICAgICByYXRpb25hbGUsXG4gICAgICBub2RlLmRlc2NyaXB0aW9uLFxuICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICAgIGRlY2lzaW9uRXZpZGVuY2UsXG4gICAgKTtcblxuICAgIGNvbnN0IGJyYW5jaENvbnRleHQgPSBjb250ZXh0LmNyZWF0ZUNoaWxkKGJyYW5jaFBhdGggYXMgc3RyaW5nLCBjaG9zZW4uaWQsIGNob3Nlbi5uYW1lLCBjaG9zZW4uaWQpO1xuICAgIHJldHVybiBleGVjdXRlTm9kZShjaG9zZW4sIGJyYW5jaENvbnRleHQsIGJyZWFrRmxhZywgYnJhbmNoUGF0aCk7XG4gIH1cbn1cbiJdfQ==