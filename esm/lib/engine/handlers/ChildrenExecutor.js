/**
 * ChildrenExecutor — Parallel fan-out via Promise.allSettled.
 *
 * Responsibilities:
 * - Execute all children in parallel (fork pattern)
 * - Execute selected children based on selector output (multi-choice)
 * - Handle throttling error flagging for rate-limited operations
 * - Aggregate results into { childId: { result, isError } }
 */
import { isPauseSignal } from '../../pause/types.js';
export class ChildrenExecutor {
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
                if (isPauseSignal(error))
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
                else if (isPauseSignal(s.reason)) {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ2hpbGRyZW5FeGVjdXRvci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvZW5naW5lL2hhbmRsZXJzL0NoaWxkcmVuRXhlY3V0b3IudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7O0dBUUc7QUFHSCxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFRckQsTUFBTSxPQUFPLGdCQUFnQjtJQUMzQixZQUFvQixJQUErQixFQUFVLFdBQXdDO1FBQWpGLFNBQUksR0FBSixJQUFJLENBQTJCO1FBQVUsZ0JBQVcsR0FBWCxXQUFXLENBQTZCO0lBQUcsQ0FBQztJQUV6Rzs7O09BR0c7SUFDSCxLQUFLLENBQUMsbUJBQW1CLENBQ3ZCLElBQTZCLEVBQzdCLE9BQXFCLEVBQ3JCLGVBQTBDLEVBQzFDLFVBQW1CLEVBQ25CLGdCQUFtQzs7UUFFbkMsSUFBSSxVQUFVLEdBQUcsQ0FBQyxDQUFDO1FBQ25CLE1BQU0sYUFBYSxHQUFHLE1BQUEsTUFBQSxJQUFJLENBQUMsUUFBUSwwQ0FBRSxNQUFNLG1DQUFJLENBQUMsQ0FBQztRQUNqRCxNQUFNLFdBQVcsR0FBRyxNQUFBLElBQUksQ0FBQyxRQUFRLG1DQUFJLEVBQUUsQ0FBQztRQUV4QyxpQ0FBaUM7UUFDakMsTUFBTSxpQkFBaUIsR0FBRyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDekQsSUFBSSxDQUFDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO1FBRXBGLE1BQU0sYUFBYSxHQUE4QixXQUFXLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7WUFDekUsTUFBTSxlQUFlLEdBQUcsVUFBVSxJQUFJLEtBQUssQ0FBQyxFQUFFLENB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QUFDLFVBQVUsQ0FDckMsT0FBTyxDQUFDLFNBQVMsSUFBSSxVQUFVLEVBQy9CLG9CQUFvQixFQUNwQixRQUFRLENBQUMsTUFBTSxFQUNmLGdCQUFnQixDQUNqQixDQUFDO1FBRUYsTUFBTSxRQUFRLEdBQTRCO1lBQ3hDLElBQUksRUFBRSxlQUFlO1lBQ3JCLEVBQUUsRUFBRSxlQUFlO1lBQ25CLFFBQVEsRUFBRSxnQkFBZ0I7U0FDM0IsQ0FBQztRQUNGLE9BQU8sTUFBTSxJQUFJLENBQUMsbUJBQW1CLENBQUMsUUFBUSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsVUFBVSxFQUFFLGdCQUFnQixDQUFDLENBQUM7SUFDcEcsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDaGlsZHJlbkV4ZWN1dG9yIOKAlCBQYXJhbGxlbCBmYW4tb3V0IHZpYSBQcm9taXNlLmFsbFNldHRsZWQuXG4gKlxuICogUmVzcG9uc2liaWxpdGllczpcbiAqIC0gRXhlY3V0ZSBhbGwgY2hpbGRyZW4gaW4gcGFyYWxsZWwgKGZvcmsgcGF0dGVybilcbiAqIC0gRXhlY3V0ZSBzZWxlY3RlZCBjaGlsZHJlbiBiYXNlZCBvbiBzZWxlY3RvciBvdXRwdXQgKG11bHRpLWNob2ljZSlcbiAqIC0gSGFuZGxlIHRocm90dGxpbmcgZXJyb3IgZmxhZ2dpbmcgZm9yIHJhdGUtbGltaXRlZCBvcGVyYXRpb25zXG4gKiAtIEFnZ3JlZ2F0ZSByZXN1bHRzIGludG8geyBjaGlsZElkOiB7IHJlc3VsdCwgaXNFcnJvciB9IH1cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFN0YWdlQ29udGV4dCB9IGZyb20gJy4uLy4uL21lbW9yeS9TdGFnZUNvbnRleHQuanMnO1xuaW1wb3J0IHsgaXNQYXVzZVNpZ25hbCB9IGZyb20gJy4uLy4uL3BhdXNlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgU2VsZWN0b3IsIFN0YWdlTm9kZSB9IGZyb20gJy4uL2dyYXBoL1N0YWdlTm9kZS5qcyc7XG5pbXBvcnQgdHlwZSB7IFRyYXZlcnNhbENvbnRleHQgfSBmcm9tICcuLi9uYXJyYXRpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBIYW5kbGVyRGVwcywgTm9kZVJlc3VsdFR5cGUgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IEV4ZWN1dGVOb2RlRm4gfSBmcm9tICcuL3R5cGVzLmpzJztcblxuZXhwb3J0IHR5cGUgeyBFeGVjdXRlTm9kZUZuIH07XG5cbmV4cG9ydCBjbGFzcyBDaGlsZHJlbkV4ZWN1dG9yPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBjb25zdHJ1Y3Rvcihwcml2YXRlIGRlcHM6IEhhbmRsZXJEZXBzPFRPdXQsIFRTY29wZT4sIHByaXZhdGUgZXhlY3V0ZU5vZGU6IEV4ZWN1dGVOb2RlRm48VE91dCwgVFNjb3BlPikge31cblxuICAvKipcbiAgICogRXhlY3V0ZSBhbGwgY2hpbGRyZW4gaW4gcGFyYWxsZWwuIEVhY2ggY2hpbGQgY29tbWl0cyBvbiBzZXR0bGUuXG4gICAqIFVzZXMgUHJvbWlzZS5hbGxTZXR0bGVkIHRvIGVuc3VyZSBhbGwgY2hpbGRyZW4gY29tcGxldGUgZXZlbiBpZiBzb21lIGZhaWwuXG4gICAqL1xuICBhc3luYyBleGVjdXRlTm9kZUNoaWxkcmVuKFxuICAgIG5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+LFxuICAgIGNvbnRleHQ6IFN0YWdlQ29udGV4dCxcbiAgICBwYXJlbnRCcmVha0ZsYWc/OiB7IHNob3VsZEJyZWFrOiBib29sZWFuIH0sXG4gICAgYnJhbmNoUGF0aD86IHN0cmluZyxcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBOb2RlUmVzdWx0VHlwZT4+IHtcbiAgICBsZXQgYnJlYWtDb3VudCA9IDA7XG4gICAgY29uc3QgdG90YWxDaGlsZHJlbiA9IG5vZGUuY2hpbGRyZW4/Lmxlbmd0aCA/PyAwO1xuICAgIGNvbnN0IGFsbENoaWxkcmVuID0gbm9kZS5jaGlsZHJlbiA/PyBbXTtcblxuICAgIC8vIE5hcnJhdGl2ZTogY2FwdHVyZSB0aGUgZmFuLW91dFxuICAgIGNvbnN0IGNoaWxkRGlzcGxheU5hbWVzID0gYWxsQ2hpbGRyZW4ubWFwKChjKSA9PiBjLm5hbWUpO1xuICAgIHRoaXMuZGVwcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25Gb3JrKG5vZGUubmFtZSwgY2hpbGREaXNwbGF5TmFtZXMsIHRyYXZlcnNhbENvbnRleHQpO1xuXG4gICAgY29uc3QgY2hpbGRQcm9taXNlczogUHJvbWlzZTxOb2RlUmVzdWx0VHlwZT5bXSA9IGFsbENoaWxkcmVuLm1hcCgoY2hpbGQpID0+IHtcbiAgICAgIGNvbnN0IGNoaWxkQnJhbmNoUGF0aCA9IGJyYW5jaFBhdGggfHwgY2hpbGQuaWQ7XG4gICAgICBjb25zdCBjaGlsZENvbnRleHQgPSBjb250ZXh0LmNyZWF0ZUNoaWxkKGNoaWxkQnJhbmNoUGF0aCBhcyBzdHJpbmcsIGNoaWxkLmlkIGFzIHN0cmluZywgY2hpbGQubmFtZSwgY2hpbGQuaWQpO1xuICAgICAgY29uc3QgY2hpbGRCcmVha0ZsYWcgPSB7IHNob3VsZEJyZWFrOiBmYWxzZSB9O1xuXG4gICAgICBjb25zdCB1cGRhdGVQYXJlbnRCcmVha0ZsYWcgPSAoKSA9PiB7XG4gICAgICAgIGlmIChjaGlsZEJyZWFrRmxhZy5zaG91bGRCcmVhaykgYnJlYWtDb3VudCArPSAxO1xuICAgICAgICBpZiAocGFyZW50QnJlYWtGbGFnICYmIGJyZWFrQ291bnQgPT09IHRvdGFsQ2hpbGRyZW4pIHBhcmVudEJyZWFrRmxhZy5zaG91bGRCcmVhayA9IHRydWU7XG4gICAgICB9O1xuXG4gICAgICByZXR1cm4gdGhpcy5leGVjdXRlTm9kZShjaGlsZCwgY2hpbGRDb250ZXh0LCBjaGlsZEJyZWFrRmxhZywgY2hpbGRCcmFuY2hQYXRoKVxuICAgICAgICAudGhlbigocmVzdWx0KSA9PiB7XG4gICAgICAgICAgY2hpbGRDb250ZXh0LmNvbW1pdCgpO1xuICAgICAgICAgIHVwZGF0ZVBhcmVudEJyZWFrRmxhZygpO1xuICAgICAgICAgIHJldHVybiB7IGlkOiBjaGlsZC5pZCEsIHJlc3VsdCwgaXNFcnJvcjogZmFsc2UgfTtcbiAgICAgICAgfSlcbiAgICAgICAgLmNhdGNoKChlcnJvcikgPT4ge1xuICAgICAgICAgIC8vIFBhdXNlU2lnbmFsIGlzIGV4cGVjdGVkIGNvbnRyb2wgZmxvdyDigJQgcmUtdGhyb3cgaW1tZWRpYXRlbHkuXG4gICAgICAgICAgaWYgKGlzUGF1c2VTaWduYWwoZXJyb3IpKSB0aHJvdyBlcnJvcjtcbiAgICAgICAgICBjaGlsZENvbnRleHQuY29tbWl0KCk7XG4gICAgICAgICAgdXBkYXRlUGFyZW50QnJlYWtGbGFnKCk7XG4gICAgICAgICAgdGhpcy5kZXBzLmxvZ2dlci5pbmZvKGBUUkVFIFBJUEVMSU5FOiBleGVjdXRlTm9kZUNoaWxkcmVuIC0gRXJyb3IgZm9yIGlkOiAke2NoaWxkPy5pZH1gLCB7IGVycm9yIH0pO1xuICAgICAgICAgIGlmICh0aGlzLmRlcHMudGhyb3R0bGluZ0Vycm9yQ2hlY2tlciAmJiB0aGlzLmRlcHMudGhyb3R0bGluZ0Vycm9yQ2hlY2tlcihlcnJvcikpIHtcbiAgICAgICAgICAgIGNoaWxkQ29udGV4dC51cGRhdGVPYmplY3QoWydtb25pdG9yJ10sICdpc1Rocm90dGxlZCcsIHRydWUpO1xuICAgICAgICAgIH1cbiAgICAgICAgICByZXR1cm4geyBpZDogY2hpbGQuaWQhLCByZXN1bHQ6IGVycm9yLCBpc0Vycm9yOiB0cnVlIH07XG4gICAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgY29uc3QgY2hpbGRyZW5SZXN1bHRzOiBSZWNvcmQ8c3RyaW5nLCBOb2RlUmVzdWx0VHlwZT4gPSB7fTtcblxuICAgIGlmIChub2RlLmZhaWxGYXN0KSB7XG4gICAgICAvLyBGYWlsLWZhc3Q6IGZpcnN0IGNoaWxkIGVycm9yIHJlamVjdHMgaW1tZWRpYXRlbHkgKHVud3JhcHBlZClcbiAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBQcm9taXNlLmFsbChcbiAgICAgICAgYWxsQ2hpbGRyZW4ubWFwKChjaGlsZCwgaSkgPT5cbiAgICAgICAgICBjaGlsZFByb21pc2VzW2ldLnRoZW4oKHIpID0+IHtcbiAgICAgICAgICAgIGlmIChyLmlzRXJyb3IpIHRocm93IHIucmVzdWx0O1xuICAgICAgICAgICAgcmV0dXJuIHI7XG4gICAgICAgICAgfSksXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgZm9yIChjb25zdCB7IGlkLCByZXN1bHQsIGlzRXJyb3IgfSBvZiByZXN1bHRzKSB7XG4gICAgICAgIGNoaWxkcmVuUmVzdWx0c1tpZF0gPSB7IGlkLCByZXN1bHQsIGlzRXJyb3I6IGlzRXJyb3IgPz8gZmFsc2UgfTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgLy8gRGVmYXVsdDogcnVuIGFsbCBjaGlsZHJlbiB0byBjb21wbGV0aW9uIGV2ZW4gaWYgc29tZSBmYWlsXG4gICAgICBjb25zdCBzZXR0bGVkID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKGNoaWxkUHJvbWlzZXMpO1xuICAgICAgbGV0IHBhdXNlU2lnbmFsOiB1bmtub3duO1xuICAgICAgc2V0dGxlZC5mb3JFYWNoKChzKSA9PiB7XG4gICAgICAgIGlmIChzLnN0YXR1cyA9PT0gJ2Z1bGZpbGxlZCcpIHtcbiAgICAgICAgICBjb25zdCB7IGlkLCByZXN1bHQsIGlzRXJyb3IgfSA9IHMudmFsdWU7XG4gICAgICAgICAgY2hpbGRyZW5SZXN1bHRzW2lkXSA9IHsgaWQsIHJlc3VsdCwgaXNFcnJvcjogaXNFcnJvciA/PyBmYWxzZSB9O1xuICAgICAgICB9IGVsc2UgaWYgKGlzUGF1c2VTaWduYWwocy5yZWFzb24pKSB7XG4gICAgICAgICAgLy8gUGF1c2VTaWduYWwgZnJvbSBhIGNoaWxkIOKAlCByZS10aHJvdyBhZnRlciBhbGwgY2hpbGRyZW4gc2V0dGxlLlxuICAgICAgICAgIC8vIEtlZXAgdGhlIGZpcnN0IHNpZ25hbCBpZiBtdWx0aXBsZSBjaGlsZHJlbiBwYXVzZS5cbiAgICAgICAgICBwYXVzZVNpZ25hbCA/Pz0gcy5yZWFzb247XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgdGhpcy5kZXBzLmxvZ2dlci5lcnJvcihgRXhlY3V0aW9uIGZhaWxlZDogJHtzLnJlYXNvbn1gKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgICAvLyBSZS10aHJvdyBQYXVzZVNpZ25hbCBhZnRlciBhbGwgY2hpbGRyZW4gaGF2ZSBzZXR0bGVkXG4gICAgICBpZiAocGF1c2VTaWduYWwpIHRocm93IHBhdXNlU2lnbmFsO1xuICAgIH1cblxuICAgIHJldHVybiBjaGlsZHJlblJlc3VsdHM7XG4gIH1cblxuICAvKipcbiAgICogRXhlY3V0ZSBzZWxlY3RlZCBjaGlsZHJlbiBiYXNlZCBvbiBzZWxlY3RvciByZXN1bHQuXG4gICAqIFZhbGlkYXRlcyBJRHMsIHJlY29yZHMgc2VsZWN0aW9uIGluZm8sIHRoZW4gZGVsZWdhdGVzIHRvIGV4ZWN1dGVOb2RlQ2hpbGRyZW4uXG4gICAqL1xuICBhc3luYyBleGVjdXRlU2VsZWN0ZWRDaGlsZHJlbihcbiAgICBzZWxlY3RvcjogU2VsZWN0b3IsXG4gICAgY2hpbGRyZW46IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+W10sXG4gICAgaW5wdXQ6IGFueSxcbiAgICBjb250ZXh0OiBTdGFnZUNvbnRleHQsXG4gICAgYnJhbmNoUGF0aDogc3RyaW5nLFxuICAgIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIE5vZGVSZXN1bHRUeXBlPj4ge1xuICAgIGNvbnN0IHNlbGVjdG9yUmVzdWx0ID0gYXdhaXQgc2VsZWN0b3IoaW5wdXQpO1xuICAgIGNvbnN0IHNlbGVjdGVkSWRzID0gQXJyYXkuaXNBcnJheShzZWxlY3RvclJlc3VsdCkgPyBzZWxlY3RvclJlc3VsdCA6IFtzZWxlY3RvclJlc3VsdF07XG5cbiAgICBjb250ZXh0LmFkZExvZygnc2VsZWN0ZWRDaGlsZElkcycsIHNlbGVjdGVkSWRzKTtcbiAgICBjb250ZXh0LmFkZExvZygnc2VsZWN0b3JQYXR0ZXJuJywgJ211bHRpLWNob2ljZScpO1xuXG4gICAgaWYgKHNlbGVjdGVkSWRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY29udGV4dC5hZGRMb2coJ3NraXBwZWRBbGxDaGlsZHJlbicsIHRydWUpO1xuICAgICAgcmV0dXJuIHt9O1xuICAgIH1cblxuICAgIGNvbnN0IHNlbGVjdGVkQ2hpbGRyZW4gPSBjaGlsZHJlbi5maWx0ZXIoKGMpID0+IHNlbGVjdGVkSWRzLmluY2x1ZGVzKGMuaWQhKSk7XG5cbiAgICAvLyBWYWxpZGF0ZSBhbGwgSURzIGV4aXN0IChmYWlsIGZhc3QpXG4gICAgaWYgKHNlbGVjdGVkQ2hpbGRyZW4ubGVuZ3RoICE9PSBzZWxlY3RlZElkcy5sZW5ndGgpIHtcbiAgICAgIGNvbnN0IGNoaWxkSWRzID0gY2hpbGRyZW4ubWFwKChjKSA9PiBjLmlkKTtcbiAgICAgIGNvbnN0IG1pc3NpbmcgPSBzZWxlY3RlZElkcy5maWx0ZXIoKGlkKSA9PiAhY2hpbGRJZHMuaW5jbHVkZXMoaWQpKTtcbiAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGBTZWxlY3RvciByZXR1cm5lZCB1bmtub3duIGNoaWxkIElEczogJHttaXNzaW5nLmpvaW4oJywgJyl9LiBBdmFpbGFibGU6ICR7Y2hpbGRJZHMuam9pbihcbiAgICAgICAgJywgJyxcbiAgICAgICl9YDtcbiAgICAgIHRoaXMuZGVwcy5sb2dnZXIuZXJyb3IoYEVycm9yIGluIHBpcGVsaW5lICgke2JyYW5jaFBhdGh9KTpgLCB7IGVycm9yOiBlcnJvck1lc3NhZ2UgfSk7XG4gICAgICBjb250ZXh0LmFkZEVycm9yKCdzZWxlY3RvckVycm9yJywgZXJyb3JNZXNzYWdlKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpO1xuICAgIH1cblxuICAgIGNvbnN0IHNraXBwZWRJZHMgPSBjaGlsZHJlbi5maWx0ZXIoKGMpID0+ICFzZWxlY3RlZElkcy5pbmNsdWRlcyhjLmlkISkpLm1hcCgoYykgPT4gYy5pZCk7XG4gICAgaWYgKHNraXBwZWRJZHMubGVuZ3RoID4gMCkge1xuICAgICAgY29udGV4dC5hZGRMb2coJ3NraXBwZWRDaGlsZElkcycsIHNraXBwZWRJZHMpO1xuICAgIH1cblxuICAgIGNvbnN0IHNlbGVjdGVkTmFtZXMgPSBzZWxlY3RlZENoaWxkcmVuLm1hcCgoYykgPT4gYy5uYW1lKS5qb2luKCcsICcpO1xuICAgIGNvbnRleHQuYWRkRmxvd0RlYnVnTWVzc2FnZShcbiAgICAgICdzZWxlY3RlZCcsXG4gICAgICBgUnVubmluZyAke3NlbGVjdGVkTmFtZXN9ICgke3NlbGVjdGVkQ2hpbGRyZW4ubGVuZ3RofSBvZiAke2NoaWxkcmVuLmxlbmd0aH0gbWF0Y2hlZClgLFxuICAgICAgeyBjb3VudDogc2VsZWN0ZWRDaGlsZHJlbi5sZW5ndGgsIHRhcmdldFN0YWdlOiBzZWxlY3RlZENoaWxkcmVuLm1hcCgoYykgPT4gYy5uYW1lKSB9LFxuICAgICk7XG5cbiAgICAvLyBOYXJyYXRpdmU6IGNhcHR1cmUgdGhlIHNlbGVjdGlvblxuICAgIGNvbnN0IHNlbGVjdGVkRGlzcGxheU5hbWVzID0gc2VsZWN0ZWRDaGlsZHJlbi5tYXAoKGMpID0+IGMubmFtZSk7XG4gICAgdGhpcy5kZXBzLm5hcnJhdGl2ZUdlbmVyYXRvci5vblNlbGVjdGVkKFxuICAgICAgY29udGV4dC5zdGFnZU5hbWUgfHwgJ3NlbGVjdG9yJyxcbiAgICAgIHNlbGVjdGVkRGlzcGxheU5hbWVzLFxuICAgICAgY2hpbGRyZW4ubGVuZ3RoLFxuICAgICAgdHJhdmVyc2FsQ29udGV4dCxcbiAgICApO1xuXG4gICAgY29uc3QgdGVtcE5vZGU6IFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+ID0ge1xuICAgICAgbmFtZTogJ3NlbGVjdG9yLXRlbXAnLFxuICAgICAgaWQ6ICdzZWxlY3Rvci10ZW1wJyxcbiAgICAgIGNoaWxkcmVuOiBzZWxlY3RlZENoaWxkcmVuLFxuICAgIH07XG4gICAgcmV0dXJuIGF3YWl0IHRoaXMuZXhlY3V0ZU5vZGVDaGlsZHJlbih0ZW1wTm9kZSwgY29udGV4dCwgdW5kZWZpbmVkLCBicmFuY2hQYXRoLCB0cmF2ZXJzYWxDb250ZXh0KTtcbiAgfVxufVxuIl19