"use strict";
/**
 * ChildrenExecutor — Parallel fan-out via Promise.allSettled.
 *
 * Responsibilities:
 * - Execute all children in parallel (fork pattern)
 * - Execute selected children based on selector output (multi-choice)
 * - Handle throttling error flagging for rate-limited operations
 * - Aggregate results into { childId: { result, isError } }
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChildrenExecutor = void 0;
const types_js_1 = require("../../pause/types.js");
class ChildrenExecutor {
    constructor(deps, executeNode) {
        this.deps = deps;
        this.executeNode = executeNode;
    }
    /**
     * Execute all children in parallel. Each child commits on settle.
     * Uses Promise.allSettled to ensure all children complete even if some fail.
     */
    async executeNodeChildren(node, context, parentBreakFlag, branchPath, traversalContext) {
        var _a, _b, _c;
        let breakCount = 0;
        const totalChildren = (_b = (_a = node.children) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0;
        const allChildren = (_c = node.children) !== null && _c !== void 0 ? _c : [];
        // Narrative: capture the fan-out
        const childDisplayNames = allChildren.map((c) => c.name);
        this.deps.narrativeGenerator.onFork(node.name, childDisplayNames, traversalContext);
        const childPromises = allChildren.map((child) => {
            const childBranchPath = branchPath || child.id;
            const childContext = context.createChild(childBranchPath, child.id, child.name, child.id);
            const childBreakFlag = { shouldBreak: false };
            const updateParentBreakFlag = () => {
                if (childBreakFlag.shouldBreak)
                    breakCount += 1;
                if (parentBreakFlag && breakCount === totalChildren)
                    parentBreakFlag.shouldBreak = true;
            };
            return this.executeNode(child, childContext, childBreakFlag, childBranchPath)
                .then((result) => {
                childContext.commit();
                updateParentBreakFlag();
                return { id: child.id, result, isError: false };
            })
                .catch((error) => {
                // PauseSignal is expected control flow — re-throw immediately.
                if ((0, types_js_1.isPauseSignal)(error))
                    throw error;
                childContext.commit();
                updateParentBreakFlag();
                this.deps.logger.info(`TREE PIPELINE: executeNodeChildren - Error for id: ${child === null || child === void 0 ? void 0 : child.id}`, { error });
                if (this.deps.throttlingErrorChecker && this.deps.throttlingErrorChecker(error)) {
                    childContext.updateObject(['monitor'], 'isThrottled', true);
                }
                return { id: child.id, result: error, isError: true };
            });
        });
        const childrenResults = {};
        if (node.failFast) {
            // Fail-fast: first child error rejects immediately (unwrapped)
            const results = await Promise.all(allChildren.map((child, i) => childPromises[i].then((r) => {
                if (r.isError)
                    throw r.result;
                return r;
            })));
            for (const { id, result, isError } of results) {
                childrenResults[id] = { id, result, isError: isError !== null && isError !== void 0 ? isError : false };
            }
        }
        else {
            // Default: run all children to completion even if some fail
            const settled = await Promise.allSettled(childPromises);
            let pauseSignal;
            settled.forEach((s) => {
                if (s.status === 'fulfilled') {
                    const { id, result, isError } = s.value;
                    childrenResults[id] = { id, result, isError: isError !== null && isError !== void 0 ? isError : false };
                }
                else if ((0, types_js_1.isPauseSignal)(s.reason)) {
                    // PauseSignal from a child — re-throw after all children settle.
                    // Keep the first signal if multiple children pause.
                    pauseSignal !== null && pauseSignal !== void 0 ? pauseSignal : (pauseSignal = s.reason);
                }
                else {
                    this.deps.logger.error(`Execution failed: ${s.reason}`);
                }
            });
            // Re-throw PauseSignal after all children have settled
            if (pauseSignal)
                throw pauseSignal;
        }
        return childrenResults;
    }
    /**
     * Execute selected children based on selector result.
     * Validates IDs, records selection info, then delegates to executeNodeChildren.
     */
    async executeSelectedChildren(selector, children, input, context, branchPath, traversalContext) {
        const selectorResult = await selector(input);
        const selectedIds = Array.isArray(selectorResult) ? selectorResult : [selectorResult];
        context.addLog('selectedChildIds', selectedIds);
        context.addLog('selectorPattern', 'multi-choice');
        if (selectedIds.length === 0) {
            context.addLog('skippedAllChildren', true);
            return {};
        }
        const selectedChildren = children.filter((c) => selectedIds.includes(c.id));
        // Validate all IDs exist (fail fast)
        if (selectedChildren.length !== selectedIds.length) {
            const childIds = children.map((c) => c.id);
            const missing = selectedIds.filter((id) => !childIds.includes(id));
            const errorMessage = `Selector returned unknown child IDs: ${missing.join(', ')}. Available: ${childIds.join(', ')}`;
            this.deps.logger.error(`Error in pipeline (${branchPath}):`, { error: errorMessage });
            context.addError('selectorError', errorMessage);
            throw new Error(errorMessage);
        }
        const skippedIds = children.filter((c) => !selectedIds.includes(c.id)).map((c) => c.id);
        if (skippedIds.length > 0) {
            context.addLog('skippedChildIds', skippedIds);
        }
        const selectedNames = selectedChildren.map((c) => c.name).join(', ');
        context.addFlowDebugMessage('selected', `Running ${selectedNames} (${selectedChildren.length} of ${children.length} matched)`, { count: selectedChildren.length, targetStage: selectedChildren.map((c) => c.name) });
        // Narrative: capture the selection
        const selectedDisplayNames = selectedChildren.map((c) => c.name);
        this.deps.narrativeGenerator.onSelected(context.stageName || 'selector', selectedDisplayNames, children.length, traversalContext);
        const tempNode = {
            name: 'selector-temp',
            id: 'selector-temp',
            children: selectedChildren,
        };
        return await this.executeNodeChildren(tempNode, context, undefined, branchPath, traversalContext);
    }
}
exports.ChildrenExecutor = ChildrenExecutor;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ2hpbGRyZW5FeGVjdXRvci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvZW5naW5lL2hhbmRsZXJzL0NoaWxkcmVuRXhlY3V0b3IudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7OztHQVFHOzs7QUFHSCxtREFBcUQ7QUFRckQsTUFBYSxnQkFBZ0I7SUFDM0IsWUFBb0IsSUFBK0IsRUFBVSxXQUF3QztRQUFqRixTQUFJLEdBQUosSUFBSSxDQUEyQjtRQUFVLGdCQUFXLEdBQVgsV0FBVyxDQUE2QjtJQUFHLENBQUM7SUFFekc7OztPQUdHO0lBQ0gsS0FBSyxDQUFDLG1CQUFtQixDQUN2QixJQUE2QixFQUM3QixPQUFxQixFQUNyQixlQUEwQyxFQUMxQyxVQUFtQixFQUNuQixnQkFBbUM7O1FBRW5DLElBQUksVUFBVSxHQUFHLENBQUMsQ0FBQztRQUNuQixNQUFNLGFBQWEsR0FBRyxNQUFBLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsTUFBTSxtQ0FBSSxDQUFDLENBQUM7UUFDakQsTUFBTSxXQUFXLEdBQUcsTUFBQSxJQUFJLENBQUMsUUFBUSxtQ0FBSSxFQUFFLENBQUM7UUFFeEMsaUNBQWlDO1FBQ2pDLE1BQU0saUJBQWlCLEdBQUcsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3pELElBQUksQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQztRQUVwRixNQUFNLGFBQWEsR0FBOEIsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFO1lBQ3pFLE1BQU0sZUFBZSxHQUFHLFVBQVUsSUFBSSxLQUFLLENBQUMsRUFBRSxDQUFDO1lBQy9DLE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxX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QyxTQUFTLElBQUksVUFBVSxFQUMvQixvQkFBb0IsRUFDcEIsUUFBUSxDQUFDLE1BQU0sRUFDZixnQkFBZ0IsQ0FDakIsQ0FBQztRQUVGLE1BQU0sUUFBUSxHQUE0QjtZQUN4QyxJQUFJLEVBQUUsZUFBZTtZQUNyQixFQUFFLEVBQUUsZUFBZTtZQUNuQixRQUFRLEVBQUUsZ0JBQWdCO1NBQzNCLENBQUM7UUFDRixPQUFPLE1BQU0sSUFBSSxDQUFDLG1CQUFtQixDQUFDLFFBQVEsRUFBRSxPQUFPLEVBQUUsU0FBUyxFQUFFLFVBQVUsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO0lBQ3BHLENBQUM7Q0FDRjtBQTFKRCw0Q0EwSkMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENoaWxkcmVuRXhlY3V0b3Ig4oCUIFBhcmFsbGVsIGZhbi1vdXQgdmlhIFByb21pc2UuYWxsU2V0dGxlZC5cbiAqXG4gKiBSZXNwb25zaWJpbGl0aWVzOlxuICogLSBFeGVjdXRlIGFsbCBjaGlsZHJlbiBpbiBwYXJhbGxlbCAoZm9yayBwYXR0ZXJuKVxuICogLSBFeGVjdXRlIHNlbGVjdGVkIGNoaWxkcmVuIGJhc2VkIG9uIHNlbGVjdG9yIG91dHB1dCAobXVsdGktY2hvaWNlKVxuICogLSBIYW5kbGUgdGhyb3R0bGluZyBlcnJvciBmbGFnZ2luZyBmb3IgcmF0ZS1saW1pdGVkIG9wZXJhdGlvbnNcbiAqIC0gQWdncmVnYXRlIHJlc3VsdHMgaW50byB7IGNoaWxkSWQ6IHsgcmVzdWx0LCBpc0Vycm9yIH0gfVxuICovXG5cbmltcG9ydCB0eXBlIHsgU3RhZ2VDb250ZXh0IH0gZnJvbSAnLi4vLi4vbWVtb3J5L1N0YWdlQ29udGV4dC5qcyc7XG5pbXBvcnQgeyBpc1BhdXNlU2lnbmFsIH0gZnJvbSAnLi4vLi4vcGF1c2UvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBTZWxlY3RvciwgU3RhZ2VOb2RlIH0gZnJvbSAnLi4vZ3JhcGgvU3RhZ2VOb2RlLmpzJztcbmltcG9ydCB0eXBlIHsgVHJhdmVyc2FsQ29udGV4dCB9IGZyb20gJy4uL25hcnJhdGl2ZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IEhhbmRsZXJEZXBzLCBOb2RlUmVzdWx0VHlwZSB9IGZyb20gJy4uL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgRXhlY3V0ZU5vZGVGbiB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5leHBvcnQgdHlwZSB7IEV4ZWN1dGVOb2RlRm4gfTtcblxuZXhwb3J0IGNsYXNzIENoaWxkcmVuRXhlY3V0b3I8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgZGVwczogSGFuZGxlckRlcHM8VE91dCwgVFNjb3BlPiwgcHJpdmF0ZSBleGVjdXRlTm9kZTogRXhlY3V0ZU5vZGVGbjxUT3V0LCBUU2NvcGU+KSB7fVxuXG4gIC8qKlxuICAgKiBFeGVjdXRlIGFsbCBjaGlsZHJlbiBpbiBwYXJhbGxlbC4gRWFjaCBjaGlsZCBjb21taXRzIG9uIHNldHRsZS5cbiAgICogVXNlcyBQcm9taXNlLmFsbFNldHRsZWQgdG8gZW5zdXJlIGFsbCBjaGlsZHJlbiBjb21wbGV0ZSBldmVuIGlmIHNvbWUgZmFpbC5cbiAgICovXG4gIGFzeW5jIGV4ZWN1dGVOb2RlQ2hpbGRyZW4oXG4gICAgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgY29udGV4dDogU3RhZ2VDb250ZXh0LFxuICAgIHBhcmVudEJyZWFrRmxhZz86IHsgc2hvdWxkQnJlYWs6IGJvb2xlYW4gfSxcbiAgICBicmFuY2hQYXRoPzogc3RyaW5nLFxuICAgIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIE5vZGVSZXN1bHRUeXBlPj4ge1xuICAgIGxldCBicmVha0NvdW50ID0gMDtcbiAgICBjb25zdCB0b3RhbENoaWxkcmVuID0gbm9kZS5jaGlsZHJlbj8ubGVuZ3RoID8/IDA7XG4gICAgY29uc3QgYWxsQ2hpbGRyZW4gPSBub2RlLmNoaWxkcmVuID8/IFtdO1xuXG4gICAgLy8gTmFycmF0aXZlOiBjYXB0dXJlIHRoZSBmYW4tb3V0XG4gICAgY29uc3QgY2hpbGREaXNwbGF5TmFtZXMgPSBhbGxDaGlsZHJlbi5tYXAoKGMpID0+IGMubmFtZSk7XG4gICAgdGhpcy5kZXBzLm5hcnJhdGl2ZUdlbmVyYXRvci5vbkZvcmsobm9kZS5uYW1lLCBjaGlsZERpc3BsYXlOYW1lcywgdHJhdmVyc2FsQ29udGV4dCk7XG5cbiAgICBjb25zdCBjaGlsZFByb21pc2VzOiBQcm9taXNlPE5vZGVSZXN1bHRUeXBlPltdID0gYWxsQ2hpbGRyZW4ubWFwKChjaGlsZCkgPT4ge1xuICAgICAgY29uc3QgY2hpbGRCcmFuY2hQYXRoID0gYnJhbmNoUGF0aCB8fCBjaGlsZC5pZDtcbiAgICAgIGNvbnN0IGNoaWxkQ29udGV4dCA9IGNvbnRleHQuY3JlYXRlQ2hpbGQoY2hpbGRCcmFuY2hQYXRoIGFzIHN0cmluZywgY2hpbGQuaWQgYXMgc3RyaW5nLCBjaGlsZC5uYW1lLCBjaGlsZC5pZCk7XG4gICAgICBjb25zdCBjaGlsZEJyZWFrRmxhZyA9IHsgc2hvdWxkQnJlYWs6IGZhbHNlIH07XG5cbiAgICAgIGNvbnN0IHVwZGF0ZVBhcmVudEJyZWFrRmxhZyA9ICgpID0+IHtcbiAgICAgICAgaWYgKGNoaWxkQnJlYWtGbGFnLnNob3VsZEJyZWFrKSBicmVha0NvdW50ICs9IDE7XG4gICAgICAgIGlmIChwYXJlbnRCcmVha0ZsYWcgJiYgYnJlYWtDb3VudCA9PT0gdG90YWxDaGlsZHJlbikgcGFyZW50QnJlYWtGbGFnLnNob3VsZEJyZWFrID0gdHJ1ZTtcbiAgICAgIH07XG5cbiAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVOb2RlKGNoaWxkLCBjaGlsZENvbnRleHQsIGNoaWxkQnJlYWtGbGFnLCBjaGlsZEJyYW5jaFBhdGgpXG4gICAgICAgIC50aGVuKChyZXN1bHQpID0+IHtcbiAgICAgICAgICBjaGlsZENvbnRleHQuY29tbWl0KCk7XG4gICAgICAgICAgdXBkYXRlUGFyZW50QnJlYWtGbGFnKCk7XG4gICAgICAgICAgcmV0dXJuIHsgaWQ6IGNoaWxkLmlkISwgcmVzdWx0LCBpc0Vycm9yOiBmYWxzZSB9O1xuICAgICAgICB9KVxuICAgICAgICAuY2F0Y2goKGVycm9yKSA9PiB7XG4gICAgICAgICAgLy8gUGF1c2VTaWduYWwgaXMgZXhwZWN0ZWQgY29udHJvbCBmbG93IOKAlCByZS10aHJvdyBpbW1lZGlhdGVseS5cbiAgICAgICAgICBpZiAoaXNQYXVzZVNpZ25hbChlcnJvcikpIHRocm93IGVycm9yO1xuICAgICAgICAgIGNoaWxkQ29udGV4dC5jb21taXQoKTtcbiAgICAgICAgICB1cGRhdGVQYXJlbnRCcmVha0ZsYWcoKTtcbiAgICAgICAgICB0aGlzLmRlcHMubG9nZ2VyLmluZm8oYFRSRUUgUElQRUxJTkU6IGV4ZWN1dGVOb2RlQ2hpbGRyZW4gLSBFcnJvciBmb3IgaWQ6ICR7Y2hpbGQ/LmlkfWAsIHsgZXJyb3IgfSk7XG4gICAgICAgICAgaWYgKHRoaXMuZGVwcy50aHJvdHRsaW5nRXJyb3JDaGVja2VyICYmIHRoaXMuZGVwcy50aHJvdHRsaW5nRXJyb3JDaGVja2VyKGVycm9yKSkge1xuICAgICAgICAgICAgY2hpbGRDb250ZXh0LnVwZGF0ZU9iamVjdChbJ21vbml0b3InXSwgJ2lzVGhyb3R0bGVkJywgdHJ1ZSk7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB7IGlkOiBjaGlsZC5pZCEsIHJlc3VsdDogZXJyb3IsIGlzRXJyb3I6IHRydWUgfTtcbiAgICAgICAgfSk7XG4gICAgfSk7XG5cbiAgICBjb25zdCBjaGlsZHJlblJlc3VsdHM6IFJlY29yZDxzdHJpbmcsIE5vZGVSZXN1bHRUeXBlPiA9IHt9O1xuXG4gICAgaWYgKG5vZGUuZmFpbEZhc3QpIHtcbiAgICAgIC8vIEZhaWwtZmFzdDogZmlyc3QgY2hpbGQgZXJyb3IgcmVqZWN0cyBpbW1lZGlhdGVseSAodW53cmFwcGVkKVxuICAgICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgICBhbGxDaGlsZHJlbi5tYXAoKGNoaWxkLCBpKSA9PlxuICAgICAgICAgIGNoaWxkUHJvbWlzZXNbaV0udGhlbigocikgPT4ge1xuICAgICAgICAgICAgaWYgKHIuaXNFcnJvcikgdGhyb3cgci5yZXN1bHQ7XG4gICAgICAgICAgICByZXR1cm4gcjtcbiAgICAgICAgICB9KSxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgICBmb3IgKGNvbnN0IHsgaWQsIHJlc3VsdCwgaXNFcnJvciB9IG9mIHJlc3VsdHMpIHtcbiAgICAgICAgY2hpbGRyZW5SZXN1bHRzW2lkXSA9IHsgaWQsIHJlc3VsdCwgaXNFcnJvcjogaXNFcnJvciA/PyBmYWxzZSB9O1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBEZWZhdWx0OiBydW4gYWxsIGNoaWxkcmVuIHRvIGNvbXBsZXRpb24gZXZlbiBpZiBzb21lIGZhaWxcbiAgICAgIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQoY2hpbGRQcm9taXNlcyk7XG4gICAgICBsZXQgcGF1c2VTaWduYWw6IHVua25vd247XG4gICAgICBzZXR0bGVkLmZvckVhY2goKHMpID0+IHtcbiAgICAgICAgaWYgKHMuc3RhdHVzID09PSAnZnVsZmlsbGVkJykge1xuICAgICAgICAgIGNvbnN0IHsgaWQsIHJlc3VsdCwgaXNFcnJvciB9ID0gcy52YWx1ZTtcbiAgICAgICAgICBjaGlsZHJlblJlc3VsdHNbaWRdID0geyBpZCwgcmVzdWx0LCBpc0Vycm9yOiBpc0Vycm9yID8/IGZhbHNlIH07XG4gICAgICAgIH0gZWxzZSBpZiAoaXNQYXVzZVNpZ25hbChzLnJlYXNvbikpIHtcbiAgICAgICAgICAvLyBQYXVzZVNpZ25hbCBmcm9tIGEgY2hpbGQg4oCUIHJlLXRocm93IGFmdGVyIGFsbCBjaGlsZHJlbiBzZXR0bGUuXG4gICAgICAgICAgLy8gS2VlcCB0aGUgZmlyc3Qgc2lnbmFsIGlmIG11bHRpcGxlIGNoaWxkcmVuIHBhdXNlLlxuICAgICAgICAgIHBhdXNlU2lnbmFsID8/PSBzLnJlYXNvbjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICB0aGlzLmRlcHMubG9nZ2VyLmVycm9yKGBFeGVjdXRpb24gZmFpbGVkOiAke3MucmVhc29ufWApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICAgIC8vIFJlLXRocm93IFBhdXNlU2lnbmFsIGFmdGVyIGFsbCBjaGlsZHJlbiBoYXZlIHNldHRsZWRcbiAgICAgIGlmIChwYXVzZVNpZ25hbCkgdGhyb3cgcGF1c2VTaWduYWw7XG4gICAgfVxuXG4gICAgcmV0dXJuIGNoaWxkcmVuUmVzdWx0cztcbiAgfVxuXG4gIC8qKlxuICAgKiBFeGVjdXRlIHNlbGVjdGVkIGNoaWxkcmVuIGJhc2VkIG9uIHNlbGVjdG9yIHJlc3VsdC5cbiAgICogVmFsaWRhdGVzIElEcywgcmVjb3JkcyBzZWxlY3Rpb24gaW5mbywgdGhlbiBkZWxlZ2F0ZXMgdG8gZXhlY3V0ZU5vZGVDaGlsZHJlbi5cbiAgICovXG4gIGFzeW5jIGV4ZWN1dGVTZWxlY3RlZENoaWxkcmVuKFxuICAgIHNlbGVjdG9yOiBTZWxlY3RvcixcbiAgICBjaGlsZHJlbjogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT5bXSxcbiAgICBpbnB1dDogYW55LFxuICAgIGNvbnRleHQ6IFN0YWdlQ29udGV4dCxcbiAgICBicmFuY2hQYXRoOiBzdHJpbmcsXG4gICAgdHJhdmVyc2FsQ29udGV4dD86IFRyYXZlcnNhbENvbnRleHQsXG4gICk6IFByb21pc2U8UmVjb3JkPHN0cmluZywgTm9kZVJlc3VsdFR5cGU+PiB7XG4gICAgY29uc3Qgc2VsZWN0b3JSZXN1bHQgPSBhd2FpdCBzZWxlY3RvcihpbnB1dCk7XG4gICAgY29uc3Qgc2VsZWN0ZWRJZHMgPSBBcnJheS5pc0FycmF5KHNlbGVjdG9yUmVzdWx0KSA/IHNlbGVjdG9yUmVzdWx0IDogW3NlbGVjdG9yUmVzdWx0XTtcblxuICAgIGNvbnRleHQuYWRkTG9nKCdzZWxlY3RlZENoaWxkSWRzJywgc2VsZWN0ZWRJZHMpO1xuICAgIGNvbnRleHQuYWRkTG9nKCdzZWxlY3RvclBhdHRlcm4nLCAnbXVsdGktY2hvaWNlJyk7XG5cbiAgICBpZiAoc2VsZWN0ZWRJZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb250ZXh0LmFkZExvZygnc2tpcHBlZEFsbENoaWxkcmVuJywgdHJ1ZSk7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuXG4gICAgY29uc3Qgc2VsZWN0ZWRDaGlsZHJlbiA9IGNoaWxkcmVuLmZpbHRlcigoYykgPT4gc2VsZWN0ZWRJZHMuaW5jbHVkZXMoYy5pZCEpKTtcblxuICAgIC8vIFZhbGlkYXRlIGFsbCBJRHMgZXhpc3QgKGZhaWwgZmFzdClcbiAgICBpZiAoc2VsZWN0ZWRDaGlsZHJlbi5sZW5ndGggIT09IHNlbGVjdGVkSWRzLmxlbmd0aCkge1xuICAgICAgY29uc3QgY2hpbGRJZHMgPSBjaGlsZHJlbi5tYXAoKGMpID0+IGMuaWQpO1xuICAgICAgY29uc3QgbWlzc2luZyA9IHNlbGVjdGVkSWRzLmZpbHRlcigoaWQpID0+ICFjaGlsZElkcy5pbmNsdWRlcyhpZCkpO1xuICAgICAgY29uc3QgZXJyb3JNZXNzYWdlID0gYFNlbGVjdG9yIHJldHVybmVkIHVua25vd24gY2hpbGQgSURzOiAke21pc3Npbmcuam9pbignLCAnKX0uIEF2YWlsYWJsZTogJHtjaGlsZElkcy5qb2luKFxuICAgICAgICAnLCAnLFxuICAgICAgKX1gO1xuICAgICAgdGhpcy5kZXBzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pOmAsIHsgZXJyb3I6IGVycm9yTWVzc2FnZSB9KTtcbiAgICAgIGNvbnRleHQuYWRkRXJyb3IoJ3NlbGVjdG9yRXJyb3InLCBlcnJvck1lc3NhZ2UpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGVycm9yTWVzc2FnZSk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2tpcHBlZElkcyA9IGNoaWxkcmVuLmZpbHRlcigoYykgPT4gIXNlbGVjdGVkSWRzLmluY2x1ZGVzKGMuaWQhKSkubWFwKChjKSA9PiBjLmlkKTtcbiAgICBpZiAoc2tpcHBlZElkcy5sZW5ndGggPiAwKSB7XG4gICAgICBjb250ZXh0LmFkZExvZygnc2tpcHBlZENoaWxkSWRzJywgc2tpcHBlZElkcyk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2VsZWN0ZWROYW1lcyA9IHNlbGVjdGVkQ2hpbGRyZW4ubWFwKChjKSA9PiBjLm5hbWUpLmpvaW4oJywgJyk7XG4gICAgY29udGV4dC5hZGRGbG93RGVidWdNZXNzYWdlKFxuICAgICAgJ3NlbGVjdGVkJyxcbiAgICAgIGBSdW5uaW5nICR7c2VsZWN0ZWROYW1lc30gKCR7c2VsZWN0ZWRDaGlsZHJlbi5sZW5ndGh9IG9mICR7Y2hpbGRyZW4ubGVuZ3RofSBtYXRjaGVkKWAsXG4gICAgICB7IGNvdW50OiBzZWxlY3RlZENoaWxkcmVuLmxlbmd0aCwgdGFyZ2V0U3RhZ2U6IHNlbGVjdGVkQ2hpbGRyZW4ubWFwKChjKSA9PiBjLm5hbWUpIH0sXG4gICAgKTtcblxuICAgIC8vIE5hcnJhdGl2ZTogY2FwdHVyZSB0aGUgc2VsZWN0aW9uXG4gICAgY29uc3Qgc2VsZWN0ZWREaXNwbGF5TmFtZXMgPSBzZWxlY3RlZENoaWxkcmVuLm1hcCgoYykgPT4gYy5uYW1lKTtcbiAgICB0aGlzLmRlcHMubmFycmF0aXZlR2VuZXJhdG9yLm9uU2VsZWN0ZWQoXG4gICAgICBjb250ZXh0LnN0YWdlTmFtZSB8fCAnc2VsZWN0b3InLFxuICAgICAgc2VsZWN0ZWREaXNwbGF5TmFtZXMsXG4gICAgICBjaGlsZHJlbi5sZW5ndGgsXG4gICAgICB0cmF2ZXJzYWxDb250ZXh0LFxuICAgICk7XG5cbiAgICBjb25zdCB0ZW1wTm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4gPSB7XG4gICAgICBuYW1lOiAnc2VsZWN0b3ItdGVtcCcsXG4gICAgICBpZDogJ3NlbGVjdG9yLXRlbXAnLFxuICAgICAgY2hpbGRyZW46IHNlbGVjdGVkQ2hpbGRyZW4sXG4gICAgfTtcbiAgICByZXR1cm4gYXdhaXQgdGhpcy5leGVjdXRlTm9kZUNoaWxkcmVuKHRlbXBOb2RlLCBjb250ZXh0LCB1bmRlZmluZWQsIGJyYW5jaFBhdGgsIHRyYXZlcnNhbENvbnRleHQpO1xuICB9XG59XG4iXX0=