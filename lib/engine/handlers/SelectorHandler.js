"use strict";
/**
 * SelectorHandler — Multi-choice filtered fan-out.
 *
 * Responsibilities:
 * - Execute scope-based selector nodes (stage → commit → resolve children → parallel execution)
 * - The selector function IS a stage: reads scope, returns string[] of branch IDs
 * - Delegates parallel execution of selected children to ChildrenExecutor
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SelectorHandler = void 0;
const types_js_1 = require("../../decide/types.js");
const types_js_2 = require("../../pause/types.js");
class SelectorHandler {
    constructor(deps, childrenExecutor) {
        this.deps = deps;
        this.childrenExecutor = childrenExecutor;
    }
    /**
     * Handle a scope-based selector node (created via addSelectorFunction).
     * The stage function IS the selector — its return value contains branch IDs.
     * Execution order: runStage(fn) → commit → resolve children → parallel execute.
     */
    async handleScopeBased(node, stageFunc, context, breakFlag, branchPath, runStage, executeNode, callExtractor, getStagePath, traversalContext) {
        var _a;
        const breakFn = () => (breakFlag.shouldBreak = true);
        let selectedIds;
        let selectionEvidence;
        try {
            const stageOutput = await runStage(node, stageFunc, context, breakFn);
            // Detect SelectionResult from select() helper via Symbol brand
            if (stageOutput &&
                typeof stageOutput === 'object' &&
                Reflect.has(stageOutput, types_js_1.DECISION_RESULT) &&
                Array.isArray(stageOutput.branches)) {
                selectedIds = stageOutput.branches;
                selectionEvidence = stageOutput.evidence;
            }
            else {
                selectedIds = Array.isArray(stageOutput) ? stageOutput.map(String) : [String(stageOutput)];
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
        callExtractor(node, context, getStagePath(node, branchPath, context.stageName), selectedIds);
        if (breakFlag.shouldBreak) {
            this.deps.logger.info(`Execution stopped in pipeline (${branchPath}) after ${node.name} due to break condition.`);
            return {};
        }
        context.addLog('selectedChildIds', selectedIds);
        context.addLog('selectorPattern', 'scope-based-multi-choice');
        if (selectedIds.length === 0) {
            context.addLog('skippedAllChildren', true);
            context.addFlowDebugMessage('selected', 'No children selected — skipping all branches.', {
                count: 0,
                targetStage: [],
            });
            this.deps.narrativeGenerator.onSelected(node.name, [], ((_a = node.children) !== null && _a !== void 0 ? _a : []).length, traversalContext);
            return {};
        }
        // Resolve children by matching selected IDs against node.children.
        // Match branchId first (original unprefixed ID), fall back to id for backward compat.
        const children = node.children;
        const selectedChildren = children.filter((c) => { var _a; return selectedIds.includes((_a = c.branchId) !== null && _a !== void 0 ? _a : c.id); });
        // Validate all IDs exist (fail fast)
        if (selectedChildren.length !== selectedIds.length) {
            const childIds = children.map((c) => { var _a; return (_a = c.branchId) !== null && _a !== void 0 ? _a : c.id; });
            const missing = selectedIds.filter((id) => !childIds.includes(id));
            const errorMessage = `Scope-based selector '${node.name}' returned unknown child IDs: ${missing.join(', ')}. Available: ${childIds.join(', ')}`;
            this.deps.logger.error(`Error in pipeline (${branchPath}):`, { error: errorMessage });
            context.addError('selectorError', errorMessage);
            throw new Error(errorMessage);
        }
        const skippedIds = children
            .filter((c) => { var _a; return !selectedIds.includes((_a = c.branchId) !== null && _a !== void 0 ? _a : c.id); })
            .map((c) => { var _a; return (_a = c.branchId) !== null && _a !== void 0 ? _a : c.id; });
        if (skippedIds.length > 0) {
            context.addLog('skippedChildIds', skippedIds);
        }
        const selectedNames = selectedChildren.map((c) => c.name).join(', ');
        context.addFlowDebugMessage('selected', `Running ${selectedNames} (${selectedChildren.length} of ${children.length} matched)`, { count: selectedChildren.length, targetStage: selectedChildren.map((c) => c.name) });
        const selectedDisplayNames = selectedChildren.map((c) => c.name);
        this.deps.narrativeGenerator.onSelected(node.name, selectedDisplayNames, children.length, traversalContext, selectionEvidence);
        const tempNode = {
            name: 'selector-temp',
            id: 'selector-temp',
            children: selectedChildren,
        };
        return await this.childrenExecutor.executeNodeChildren(tempNode, context, undefined, branchPath, traversalContext);
    }
}
exports.SelectorHandler = SelectorHandler;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU2VsZWN0b3JIYW5kbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvaGFuZGxlcnMvU2VsZWN0b3JIYW5kbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7OztHQU9HOzs7QUFHSCxvREFBd0Q7QUFFeEQsbURBQXFEO0FBT3JELE1BQWEsZUFBZTtJQUMxQixZQUNtQixJQUErQixFQUMvQixnQkFBZ0Q7UUFEaEQsU0FBSSxHQUFKLElBQUksQ0FBMkI7UUFDL0IscUJBQWdCLEdBQWhCLGdCQUFnQixDQUFnQztJQUNoRSxDQUFDO0lBRUo7Ozs7T0FJRztJQUNILEtBQUssQ0FBQyxnQkFBZ0IsQ0FDcEIsSUFBNkIsRUFDN0IsU0FBc0MsRUFDdEMsT0FBcUIsRUFDckIsU0FBbUMsRUFDbkMsVUFBOEIsRUFDOUIsUUFBa0MsRUFDbEMsV0FBd0MsRUFDeEMsYUFBNEMsRUFDNUMsWUFBMEMsRUFDMUMsZ0JBQW1DOztRQUVuQyxNQUFNLE9BQU8sR0FBRyxHQUFHLEVBQUUsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxXQUFXLEdBQUcsSUFBSSxDQUFDLENBQUM7UUFFckQsSUFBSSxXQUFxQixDQUFDO1FBQzFCLElBQUksaUJBQWdELENBQUM7UUFDckQsSUFBSSxDQUFDO1lBQ0gsTUFBTSxXQUFXLEdBQUcsTUFBTSxRQUFRLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUUsT0FBTyxDQUFDLENBQUM7WUFDdEUsK0RBQStEO1lBQy9ELElBQ0UsV0FBVztnQkFDWCxPQUFPLFdBQVcsS0FBSyxRQUFRO2dCQUMvQixPQUFPLENBQUMsR0FBRyxDQUFDLFdBQXFCLEVBQUUsMEJBQWUsQ0FBQztnQkFDbkQsS0FBSyxDQUFDLE9BQU8sQ0FBRSxXQUFtQixDQUFDLFFBQVEsQ0FBQyxFQUM1QyxDQUFDO2dCQUNELFdBQVcsR0FBSSxXQUFtQixDQUFDLFFBQVEsQ0FBQztnQkFDNUMsaUJBQWlCLEdB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U0FDM0IsQ0FBQztRQUNGLE9BQU8sTUFBTSxJQUFJLENBQUMsZ0JBQWdCLENBQUMsbUJBQW1CLENBQUMsUUFBUSxFQUFFLE9BQU8sRUFBRSxTQUFTLEVBQUUsVUFBVSxFQUFFLGdCQUFnQixDQUFDLENBQUM7SUFDckgsQ0FBQztDQUNGO0FBOUhELDBDQThIQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2VsZWN0b3JIYW5kbGVyIOKAlCBNdWx0aS1jaG9pY2UgZmlsdGVyZWQgZmFuLW91dC5cbiAqXG4gKiBSZXNwb25zaWJpbGl0aWVzOlxuICogLSBFeGVjdXRlIHNjb3BlLWJhc2VkIHNlbGVjdG9yIG5vZGVzIChzdGFnZSDihpIgY29tbWl0IOKGkiByZXNvbHZlIGNoaWxkcmVuIOKGkiBwYXJhbGxlbCBleGVjdXRpb24pXG4gKiAtIFRoZSBzZWxlY3RvciBmdW5jdGlvbiBJUyBhIHN0YWdlOiByZWFkcyBzY29wZSwgcmV0dXJucyBzdHJpbmdbXSBvZiBicmFuY2ggSURzXG4gKiAtIERlbGVnYXRlcyBwYXJhbGxlbCBleGVjdXRpb24gb2Ygc2VsZWN0ZWQgY2hpbGRyZW4gdG8gQ2hpbGRyZW5FeGVjdXRvclxuICovXG5cbmltcG9ydCB0eXBlIHsgU2VsZWN0aW9uRXZpZGVuY2UgfSBmcm9tICcuLi8uLi9kZWNpZGUvdHlwZXMuanMnO1xuaW1wb3J0IHsgREVDSVNJT05fUkVTVUxUIH0gZnJvbSAnLi4vLi4vZGVjaWRlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgU3RhZ2VDb250ZXh0IH0gZnJvbSAnLi4vLi4vbWVtb3J5L1N0YWdlQ29udGV4dC5qcyc7XG5pbXBvcnQgeyBpc1BhdXNlU2lnbmFsIH0gZnJvbSAnLi4vLi4vcGF1c2UvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBTdGFnZU5vZGUgfSBmcm9tICcuLi9ncmFwaC9TdGFnZU5vZGUuanMnO1xuaW1wb3J0IHR5cGUgeyBUcmF2ZXJzYWxDb250ZXh0IH0gZnJvbSAnLi4vbmFycmF0aXZlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgSGFuZGxlckRlcHMsIE5vZGVSZXN1bHRUeXBlLCBTdGFnZUZ1bmN0aW9uIH0gZnJvbSAnLi4vdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBDaGlsZHJlbkV4ZWN1dG9yIH0gZnJvbSAnLi9DaGlsZHJlbkV4ZWN1dG9yLmpzJztcbmltcG9ydCB0eXBlIHsgQ2FsbEV4dHJhY3RvckZuLCBFeGVjdXRlTm9kZUZuLCBHZXRTdGFnZVBhdGhGbiwgUnVuU3RhZ2VGbiB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5leHBvcnQgY2xhc3MgU2VsZWN0b3JIYW5kbGVyPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBjb25zdHJ1Y3RvcihcbiAgICBwcml2YXRlIHJlYWRvbmx5IGRlcHM6IEhhbmRsZXJEZXBzPFRPdXQsIFRTY29wZT4sXG4gICAgcHJpdmF0ZSByZWFkb25seSBjaGlsZHJlbkV4ZWN1dG9yOiBDaGlsZHJlbkV4ZWN1dG9yPFRPdXQsIFRTY29wZT4sXG4gICkge31cblxuICAvKipcbiAgICogSGFuZGxlIGEgc2NvcGUtYmFzZWQgc2VsZWN0b3Igbm9kZSAoY3JlYXRlZCB2aWEgYWRkU2VsZWN0b3JGdW5jdGlvbikuXG4gICAqIFRoZSBzdGFnZSBmdW5jdGlvbiBJUyB0aGUgc2VsZWN0b3Ig4oCUIGl0cyByZXR1cm4gdmFsdWUgY29udGFpbnMgYnJhbmNoIElEcy5cbiAgICogRXhlY3V0aW9uIG9yZGVyOiBydW5TdGFnZShmbikg4oaSIGNvbW1pdCDihpIgcmVzb2x2ZSBjaGlsZHJlbiDihpIgcGFyYWxsZWwgZXhlY3V0ZS5cbiAgICovXG4gIGFzeW5jIGhhbmRsZVNjb3BlQmFzZWQoXG4gICAgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgc3RhZ2VGdW5jOiBTdGFnZUZ1bmN0aW9uPFRPdXQsIFRTY29wZT4sXG4gICAgY29udGV4dDogU3RhZ2VDb250ZXh0LFxuICAgIGJyZWFrRmxhZzogeyBzaG91bGRCcmVhazogYm9vbGVhbiB9LFxuICAgIGJyYW5jaFBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBydW5TdGFnZTogUnVuU3RhZ2VGbjxUT3V0LCBUU2NvcGU+LFxuICAgIGV4ZWN1dGVOb2RlOiBFeGVjdXRlTm9kZUZuPFRPdXQsIFRTY29wZT4sXG4gICAgY2FsbEV4dHJhY3RvcjogQ2FsbEV4dHJhY3RvckZuPFRPdXQsIFRTY29wZT4sXG4gICAgZ2V0U3RhZ2VQYXRoOiBHZXRTdGFnZVBhdGhGbjxUT3V0LCBUU2NvcGU+LFxuICAgIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0LFxuICApOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIE5vZGVSZXN1bHRUeXBlPj4ge1xuICAgIGNvbnN0IGJyZWFrRm4gPSAoKSA9PiAoYnJlYWtGbGFnLnNob3VsZEJyZWFrID0gdHJ1ZSk7XG5cbiAgICBsZXQgc2VsZWN0ZWRJZHM6IHN0cmluZ1tdO1xuICAgIGxldCBzZWxlY3Rpb25FdmlkZW5jZTogU2VsZWN0aW9uRXZpZGVuY2UgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHN0YWdlT3V0cHV0ID0gYXdhaXQgcnVuU3RhZ2Uobm9kZSwgc3RhZ2VGdW5jLCBjb250ZXh0LCBicmVha0ZuKTtcbiAgICAgIC8vIERldGVjdCBTZWxlY3Rpb25SZXN1bHQgZnJvbSBzZWxlY3QoKSBoZWxwZXIgdmlhIFN5bWJvbCBicmFuZFxuICAgICAgaWYgKFxuICAgICAgICBzdGFnZU91dHB1dCAmJlxuICAgICAgICB0eXBlb2Ygc3RhZ2VPdXRwdXQgPT09ICdvYmplY3QnICYmXG4gICAgICAgIFJlZmxlY3QuaGFzKHN0YWdlT3V0cHV0IGFzIG9iamVjdCwgREVDSVNJT05fUkVTVUxUKSAmJlxuICAgICAgICBBcnJheS5pc0FycmF5KChzdGFnZU91dHB1dCBhcyBhbnkpLmJyYW5jaGVzKVxuICAgICAgKSB7XG4gICAgICAgIHNlbGVjdGVkSWRzID0gKHN0YWdlT3V0cHV0IGFzIGFueSkuYnJhbmNoZXM7XG4gICAgICAgIHNlbGVjdGlvbkV2aWRlbmNlID0gKHN0YWdlT3V0cHV0IGFzIGFueSkuZXZpZGVuY2U7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZWxlY3RlZElkcyA9IEFycmF5LmlzQXJyYXkoc3RhZ2VPdXRwdXQpID8gc3RhZ2VPdXRwdXQubWFwKFN0cmluZykgOiBbU3RyaW5nKHN0YWdlT3V0cHV0KV07XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgLy8gUGF1c2VTaWduYWwgaXMgZXhwZWN0ZWQgY29udHJvbCBmbG93IOKAlCBjb21taXQgYW5kIHJlLXRocm93IHdpdGhvdXQgZXJyb3IgbG9nZ2luZy5cbiAgICAgIGlmIChpc1BhdXNlU2lnbmFsKGVycm9yKSkge1xuICAgICAgICBjb250ZXh0LmNvbW1pdCgpO1xuICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgIH1cbiAgICAgIGNvbnRleHQuY29tbWl0KCk7XG4gICAgICBjYWxsRXh0cmFjdG9yKG5vZGUsIGNvbnRleHQsIGdldFN0YWdlUGF0aChub2RlLCBicmFuY2hQYXRoLCBjb250ZXh0LnN0YWdlTmFtZSksIHVuZGVmaW5lZCwge1xuICAgICAgICB0eXBlOiAnc3RhZ2VFeGVjdXRpb25FcnJvcicsXG4gICAgICAgIG1lc3NhZ2U6IGVycm9yLnRvU3RyaW5nKCksXG4gICAgICB9KTtcbiAgICAgIHRoaXMuZGVwcy5sb2dnZXIuZXJyb3IoYEVycm9yIGluIHBpcGVsaW5lICgke2JyYW5jaFBhdGh9KSBzdGFnZSBbJHtub2RlLm5hbWV9XTpgLCB7IGVycm9yIH0pO1xuICAgICAgY29udGV4dC5hZGRFcnJvcignc3RhZ2VFeGVjdXRpb25FcnJvcicsIGVycm9yLnRvU3RyaW5nKCkpO1xuICAgICAgdGhpcy5kZXBzLm5hcnJhdGl2ZUdlbmVyYXRvci5vbkVycm9yKG5vZGUubmFtZSwgZXJyb3IudG9TdHJpbmcoKSwgZXJyb3IsIHRyYXZlcnNhbENvbnRleHQpO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuXG4gICAgY29udGV4dC5jb21taXQoKTtcbiAgICBjYWxsRXh0cmFjdG9yKG5vZGUsIGNvbnRleHQsIGdldFN0YWdlUGF0aChub2RlLCBicmFuY2hQYXRoLCBjb250ZXh0LnN0YWdlTmFtZSksIHNlbGVjdGVkSWRzKTtcblxuICAgIGlmIChicmVha0ZsYWcuc2hvdWxkQnJlYWspIHtcbiAgICAgIHRoaXMuZGVwcy5sb2dnZXIuaW5mbyhgRXhlY3V0aW9uIHN0b3BwZWQgaW4gcGlwZWxpbmUgKCR7YnJhbmNoUGF0aH0pIGFmdGVyICR7bm9kZS5uYW1lfSBkdWUgdG8gYnJlYWsgY29uZGl0aW9uLmApO1xuICAgICAgcmV0dXJuIHt9O1xuICAgIH1cblxuICAgIGNvbnRleHQuYWRkTG9nKCdzZWxlY3RlZENoaWxkSWRzJywgc2VsZWN0ZWRJZHMpO1xuICAgIGNvbnRleHQuYWRkTG9nKCdzZWxlY3RvclBhdHRlcm4nLCAnc2NvcGUtYmFzZWQtbXVsdGktY2hvaWNlJyk7XG5cbiAgICBpZiAoc2VsZWN0ZWRJZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBjb250ZXh0LmFkZExvZygnc2tpcHBlZEFsbENoaWxkcmVuJywgdHJ1ZSk7XG4gICAgICBjb250ZXh0LmFkZEZsb3dEZWJ1Z01lc3NhZ2UoJ3NlbGVjdGVkJywgJ05vIGNoaWxkcmVuIHNlbGVjdGVkIOKAlCBza2lwcGluZyBhbGwgYnJhbmNoZXMuJywge1xuICAgICAgICBjb3VudDogMCxcbiAgICAgICAgdGFyZ2V0U3RhZ2U6IFtdLFxuICAgICAgfSk7XG4gICAgICB0aGlzLmRlcHMubmFycmF0aXZlR2VuZXJhdG9yLm9uU2VsZWN0ZWQobm9kZS5uYW1lLCBbXSwgKG5vZGUuY2hpbGRyZW4gPz8gW10pLmxlbmd0aCwgdHJhdmVyc2FsQ29udGV4dCk7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuXG4gICAgLy8gUmVzb2x2ZSBjaGlsZHJlbiBieSBtYXRjaGluZyBzZWxlY3RlZCBJRHMgYWdhaW5zdCBub2RlLmNoaWxkcmVuLlxuICAgIC8vIE1hdGNoIGJyYW5jaElkIGZpcnN0IChvcmlnaW5hbCB1bnByZWZpeGVkIElEKSwgZmFsbCBiYWNrIHRvIGlkIGZvciBiYWNrd2FyZCBjb21wYXQuXG4gICAgY29uc3QgY2hpbGRyZW4gPSBub2RlLmNoaWxkcmVuIGFzIFN0YWdlTm9kZTxUT3V0LCBUU2NvcGU+W107XG4gICAgY29uc3Qgc2VsZWN0ZWRDaGlsZHJlbiA9IGNoaWxkcmVuLmZpbHRlcigoYykgPT4gc2VsZWN0ZWRJZHMuaW5jbHVkZXMoYy5icmFuY2hJZCA/PyBjLmlkISkpO1xuXG4gICAgLy8gVmFsaWRhdGUgYWxsIElEcyBleGlzdCAoZmFpbCBmYXN0KVxuICAgIGlmIChzZWxlY3RlZENoaWxkcmVuLmxlbmd0aCAhPT0gc2VsZWN0ZWRJZHMubGVuZ3RoKSB7XG4gICAgICBjb25zdCBjaGlsZElkcyA9IGNoaWxkcmVuLm1hcCgoYykgPT4gYy5icmFuY2hJZCA/PyBjLmlkKTtcbiAgICAgIGNvbnN0IG1pc3NpbmcgPSBzZWxlY3RlZElkcy5maWx0ZXIoKGlkKSA9PiAhY2hpbGRJZHMuaW5jbHVkZXMoaWQpKTtcbiAgICAgIGNvbnN0IGVycm9yTWVzc2FnZSA9IGBTY29wZS1iYXNlZCBzZWxlY3RvciAnJHtub2RlLm5hbWV9JyByZXR1cm5lZCB1bmtub3duIGNoaWxkIElEczogJHttaXNzaW5nLmpvaW4oXG4gICAgICAgICcsICcsXG4gICAgICApfS4gQXZhaWxhYmxlOiAke2NoaWxkSWRzLmpvaW4oJywgJyl9YDtcbiAgICAgIHRoaXMuZGVwcy5sb2dnZXIuZXJyb3IoYEVycm9yIGluIHBpcGVsaW5lICgke2JyYW5jaFBhdGh9KTpgLCB7IGVycm9yOiBlcnJvck1lc3NhZ2UgfSk7XG4gICAgICBjb250ZXh0LmFkZEVycm9yKCdzZWxlY3RvckVycm9yJywgZXJyb3JNZXNzYWdlKTtcbiAgICAgIHRocm93IG5ldyBFcnJvcihlcnJvck1lc3NhZ2UpO1xuICAgIH1cblxuICAgIGNvbnN0IHNraXBwZWRJZHMgPSBjaGlsZHJlblxuICAgICAgLmZpbHRlcigoYykgPT4gIXNlbGVjdGVkSWRzLmluY2x1ZGVzKGMuYnJhbmNoSWQgPz8gYy5pZCEpKVxuICAgICAgLm1hcCgoYykgPT4gYy5icmFuY2hJZCA/PyBjLmlkKTtcbiAgICBpZiAoc2tpcHBlZElkcy5sZW5ndGggPiAwKSB7XG4gICAgICBjb250ZXh0LmFkZExvZygnc2tpcHBlZENoaWxkSWRzJywgc2tpcHBlZElkcyk7XG4gICAgfVxuXG4gICAgY29uc3Qgc2VsZWN0ZWROYW1lcyA9IHNlbGVjdGVkQ2hpbGRyZW4ubWFwKChjKSA9PiBjLm5hbWUpLmpvaW4oJywgJyk7XG4gICAgY29udGV4dC5hZGRGbG93RGVidWdNZXNzYWdlKFxuICAgICAgJ3NlbGVjdGVkJyxcbiAgICAgIGBSdW5uaW5nICR7c2VsZWN0ZWROYW1lc30gKCR7c2VsZWN0ZWRDaGlsZHJlbi5sZW5ndGh9IG9mICR7Y2hpbGRyZW4ubGVuZ3RofSBtYXRjaGVkKWAsXG4gICAgICB7IGNvdW50OiBzZWxlY3RlZENoaWxkcmVuLmxlbmd0aCwgdGFyZ2V0U3RhZ2U6IHNlbGVjdGVkQ2hpbGRyZW4ubWFwKChjKSA9PiBjLm5hbWUpIH0sXG4gICAgKTtcblxuICAgIGNvbnN0IHNlbGVjdGVkRGlzcGxheU5hbWVzID0gc2VsZWN0ZWRDaGlsZHJlbi5tYXAoKGMpID0+IGMubmFtZSk7XG4gICAgdGhpcy5kZXBzLm5hcnJhdGl2ZUdlbmVyYXRvci5vblNlbGVjdGVkKFxuICAgICAgbm9kZS5uYW1lLFxuICAgICAgc2VsZWN0ZWREaXNwbGF5TmFtZXMsXG4gICAgICBjaGlsZHJlbi5sZW5ndGgsXG4gICAgICB0cmF2ZXJzYWxDb250ZXh0LFxuICAgICAgc2VsZWN0aW9uRXZpZGVuY2UsXG4gICAgKTtcblxuICAgIGNvbnN0IHRlbXBOb2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIG5hbWU6ICdzZWxlY3Rvci10ZW1wJyxcbiAgICAgIGlkOiAnc2VsZWN0b3ItdGVtcCcsXG4gICAgICBjaGlsZHJlbjogc2VsZWN0ZWRDaGlsZHJlbixcbiAgICB9O1xuICAgIHJldHVybiBhd2FpdCB0aGlzLmNoaWxkcmVuRXhlY3V0b3IuZXhlY3V0ZU5vZGVDaGlsZHJlbih0ZW1wTm9kZSwgY29udGV4dCwgdW5kZWZpbmVkLCBicmFuY2hQYXRoLCB0cmF2ZXJzYWxDb250ZXh0KTtcbiAgfVxufVxuIl19