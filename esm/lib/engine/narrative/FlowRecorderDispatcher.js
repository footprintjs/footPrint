/**
 * FlowRecorderDispatcher — Fans out control flow events to N attached FlowRecorders.
 *
 * Implements IControlFlowNarrative so it can replace the single
 * ControlFlowNarrativeGenerator in the traverser's HandlerDeps.
 *
 * Design mirrors ScopeFacade._invokeHook: iterate recorders, call optional
 * hooks, swallow errors so a failing recorder never breaks execution.
 *
 * When no recorders are attached, every method is a fast no-op (empty array check).
 */
import { isDevMode } from '../../scope/detectCircular.js';
import { extractErrorInfo } from '../errors/errorInfo.js';
export class FlowRecorderDispatcher {
    constructor() {
        this.recorders = [];
    }
    /** Attach a FlowRecorder. Duplicate IDs are allowed (same as scope Recorder). */
    attach(recorder) {
        this.recorders.push(recorder);
    }
    /** Detach all FlowRecorders with the given ID. */
    detach(id) {
        this.recorders = this.recorders.filter((r) => r.id !== id);
    }
    /** Returns a defensive copy of attached recorders. */
    getRecorders() {
        return [...this.recorders];
    }
    /** Find a recorder by ID. Useful for retrieving built-in recorders like NarrativeFlowRecorder. */
    getRecorderById(id) {
        return this.recorders.find((r) => r.id === id);
    }
    // ── IControlFlowNarrative implementation ──────────────────────────────────
    onStageExecuted(stageName, description, traversalContext) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = { stageName, description, traversalContext };
        for (const r of this.recorders) {
            try {
                (_a = r.onStageExecuted) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onStageExecuted: ${err}`);
            }
        }
    }
    onNext(fromStage, toStage, description, traversalContext) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = { from: fromStage, to: toStage, description, traversalContext };
        for (const r of this.recorders) {
            try {
                (_a = r.onNext) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onNext: ${err}`);
            }
        }
    }
    onDecision(deciderName, chosenBranch, rationale, deciderDescription, traversalContext, evidence) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = {
            decider: deciderName,
            chosen: chosenBranch,
            rationale,
            description: deciderDescription,
            traversalContext,
            evidence,
        };
        for (const r of this.recorders) {
            try {
                (_a = r.onDecision) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onDecision: ${err}`);
            }
        }
    }
    onFork(parentStage, childNames, traversalContext) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = { parent: parentStage, children: childNames, traversalContext };
        for (const r of this.recorders) {
            try {
                (_a = r.onFork) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onFork: ${err}`);
            }
        }
    }
    onSelected(parentStage, selectedNames, totalCount, traversalContext, evidence) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = { parent: parentStage, selected: selectedNames, total: totalCount, traversalContext, evidence };
        for (const r of this.recorders) {
            try {
                (_a = r.onSelected) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSelected: ${err}`);
            }
        }
    }
    onSubflowEntry(subflowName, subflowId, description, traversalContext) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = { name: subflowName, subflowId, description, traversalContext };
        for (const r of this.recorders) {
            try {
                (_a = r.onSubflowEntry) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSubflowEntry: ${err}`);
            }
        }
    }
    onSubflowExit(subflowName, subflowId, traversalContext) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = { name: subflowName, subflowId, traversalContext };
        for (const r of this.recorders) {
            try {
                (_a = r.onSubflowExit) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSubflowExit: ${err}`);
            }
        }
    }
    onSubflowRegistered(subflowId, name, description, specStructure) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = { subflowId, name, description, specStructure };
        for (const r of this.recorders) {
            try {
                (_a = r.onSubflowRegistered) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onSubflowRegistered: ${err}`);
            }
        }
    }
    onLoop(targetStage, iteration, description, traversalContext) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = { target: targetStage, iteration, description, traversalContext };
        for (const r of this.recorders) {
            try {
                (_a = r.onLoop) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onLoop: ${err}`);
            }
        }
    }
    onBreak(stageName, traversalContext) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = { stageName, traversalContext };
        for (const r of this.recorders) {
            try {
                (_a = r.onBreak) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onBreak: ${err}`);
            }
        }
    }
    onError(stageName, errorMessage, error, traversalContext) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const structuredError = extractErrorInfo(error);
        const event = { stageName, message: errorMessage, structuredError, traversalContext };
        for (const r of this.recorders) {
            try {
                (_a = r.onError) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onError: ${err}`);
            }
        }
    }
    onPause(stageName, stageId, pauseData, subflowPath, traversalContext) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = { stageName, stageId, pauseData, subflowPath, traversalContext };
        for (const r of this.recorders) {
            try {
                (_a = r.onPause) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onPause: ${err}`);
            }
        }
    }
    onResume(stageName, stageId, hasInput, traversalContext) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const event = { stageName, stageId, hasInput, traversalContext };
        for (const r of this.recorders) {
            try {
                (_a = r.onResume) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if (isDevMode())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onResume: ${err}`);
            }
        }
    }
    /**
     * Returns sentences from an attached NarrativeFlowRecorder (looked up by ID).
     * Callers that need sentences should attach a NarrativeFlowRecorder with id 'narrative'
     * and retrieve it directly via getRecorderById() if they need typed access.
     */
    getSentences() {
        var _a;
        const narrative = this.getRecorderById('narrative');
        return (_a = narrative === null || narrative === void 0 ? void 0 : narrative.getSentences()) !== null && _a !== void 0 ? _a : [];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd1JlY29yZGVyRGlzcGF0Y2hlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvZW5naW5lL25hcnJhdGl2ZS9GbG93UmVjb3JkZXJEaXNwYXRjaGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7O0dBVUc7QUFHSCxPQUFPLEVBQUUsU0FBUyxFQUFFLE1BQU0sK0JBQStCLENBQUM7QUFDMUQsT0FBTyxFQUFFLGdCQUFnQixFQUFFLE1BQU0sd0JBQXdCLENBQUM7QUFJMUQsTUFBTSxPQUFPLHNCQUFzQjtJQUFuQztRQUNVLGNBQVMsR0FBbUIsRUFBRSxDQUFDO0lBdU96QyxDQUFDO0lBck9DLGlGQUFpRjtJQUNqRixNQUFNLENBQUMsUUFBc0I7UUFDM0IsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDaEMsQ0FBQztJQUVELGtEQUFrRDtJQUNsRCxNQUFNLENBQUMsRUFBVTtRQUNmLElBQUksQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDN0QsQ0FBQztJQUVELHNEQUFzRDtJQUN0RCxZQUFZO1FBQ1YsT0FBTyxDQUFDLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQzdCLENBQUM7SUFFRCxrR0FBa0c7SUFDbEcsZUFBZSxDQUF3QyxFQUFVO1FBQy9ELE9BQU8sSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxFQUFFLEtBQUssRUFBRSxDQUFrQixDQUFDO0lBQ2xFLENBQUM7SUFFRCw2RUFBNkU7SUFFN0UsZUFBZSxDQUFDLFNBQWlCLEVBQUUsV0FBb0IsRUFBRSxnQkFBbUM7O1FBQzFGLElBQUksSUFBSSxDQUFD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Y2VzQ29udGVudCI6WyIvKipcbiAqIEZsb3dSZWNvcmRlckRpc3BhdGNoZXIg4oCUIEZhbnMgb3V0IGNvbnRyb2wgZmxvdyBldmVudHMgdG8gTiBhdHRhY2hlZCBGbG93UmVjb3JkZXJzLlxuICpcbiAqIEltcGxlbWVudHMgSUNvbnRyb2xGbG93TmFycmF0aXZlIHNvIGl0IGNhbiByZXBsYWNlIHRoZSBzaW5nbGVcbiAqIENvbnRyb2xGbG93TmFycmF0aXZlR2VuZXJhdG9yIGluIHRoZSB0cmF2ZXJzZXIncyBIYW5kbGVyRGVwcy5cbiAqXG4gKiBEZXNpZ24gbWlycm9ycyBTY29wZUZhY2FkZS5faW52b2tlSG9vazogaXRlcmF0ZSByZWNvcmRlcnMsIGNhbGwgb3B0aW9uYWxcbiAqIGhvb2tzLCBzd2FsbG93IGVycm9ycyBzbyBhIGZhaWxpbmcgcmVjb3JkZXIgbmV2ZXIgYnJlYWtzIGV4ZWN1dGlvbi5cbiAqXG4gKiBXaGVuIG5vIHJlY29yZGVycyBhcmUgYXR0YWNoZWQsIGV2ZXJ5IG1ldGhvZCBpcyBhIGZhc3Qgbm8tb3AgKGVtcHR5IGFycmF5IGNoZWNrKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IERlY2lzaW9uRXZpZGVuY2UsIFNlbGVjdGlvbkV2aWRlbmNlIH0gZnJvbSAnLi4vLi4vZGVjaWRlL3R5cGVzLmpzJztcbmltcG9ydCB7IGlzRGV2TW9kZSB9IGZyb20gJy4uLy4uL3Njb3BlL2RldGVjdENpcmN1bGFyLmpzJztcbmltcG9ydCB7IGV4dHJhY3RFcnJvckluZm8gfSBmcm9tICcuLi9lcnJvcnMvZXJyb3JJbmZvLmpzJztcbmltcG9ydCB0eXBlIHsgTmFycmF0aXZlRmxvd1JlY29yZGVyIH0gZnJvbSAnLi9OYXJyYXRpdmVGbG93UmVjb3JkZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93UmVjb3JkZXIsIElDb250cm9sRmxvd05hcnJhdGl2ZSwgVHJhdmVyc2FsQ29udGV4dCB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5leHBvcnQgY2xhc3MgRmxvd1JlY29yZGVyRGlzcGF0Y2hlciBpbXBsZW1lbnRzIElDb250cm9sRmxvd05hcnJhdGl2ZSB7XG4gIHByaXZhdGUgcmVjb3JkZXJzOiBGbG93UmVjb3JkZXJbXSA9IFtdO1xuXG4gIC8qKiBBdHRhY2ggYSBGbG93UmVjb3JkZXIuIER1cGxpY2F0ZSBJRHMgYXJlIGFsbG93ZWQgKHNhbWUgYXMgc2NvcGUgUmVjb3JkZXIpLiAqL1xuICBhdHRhY2gocmVjb3JkZXI6IEZsb3dSZWNvcmRlcik6IHZvaWQge1xuICAgIHRoaXMucmVjb3JkZXJzLnB1c2gocmVjb3JkZXIpO1xuICB9XG5cbiAgLyoqIERldGFjaCBhbGwgRmxvd1JlY29yZGVycyB3aXRoIHRoZSBnaXZlbiBJRC4gKi9cbiAgZGV0YWNoKGlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgICB0aGlzLnJlY29yZGVycyA9IHRoaXMucmVjb3JkZXJzLmZpbHRlcigocikgPT4gci5pZCAhPT0gaWQpO1xuICB9XG5cbiAgLyoqIFJldHVybnMgYSBkZWZlbnNpdmUgY29weSBvZiBhdHRhY2hlZCByZWNvcmRlcnMuICovXG4gIGdldFJlY29yZGVycygpOiBGbG93UmVjb3JkZXJbXSB7XG4gICAgcmV0dXJuIFsuLi50aGlzLnJlY29yZGVyc107XG4gIH1cblxuICAvKiogRmluZCBhIHJlY29yZGVyIGJ5IElELiBVc2VmdWwgZm9yIHJldHJpZXZpbmcgYnVpbHQtaW4gcmVjb3JkZXJzIGxpa2UgTmFycmF0aXZlRmxvd1JlY29yZGVyLiAqL1xuICBnZXRSZWNvcmRlckJ5SWQ8VCBleHRlbmRzIEZsb3dSZWNvcmRlciA9IEZsb3dSZWNvcmRlcj4oaWQ6IHN0cmluZyk6IFQgfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLnJlY29yZGVycy5maW5kKChyKSA9PiByLmlkID09PSBpZCkgYXMgVCB8IHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8vIOKUgOKUgCBJQ29udHJvbEZsb3dOYXJyYXRpdmUgaW1wbGVtZW50YXRpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgb25TdGFnZUV4ZWN1dGVkKHN0YWdlTmFtZTogc3RyaW5nLCBkZXNjcmlwdGlvbj86IHN0cmluZywgdHJhdmVyc2FsQ29udGV4dD86IFRyYXZlcnNhbENvbnRleHQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IHN0YWdlTmFtZSwgZGVzY3JpcHRpb24sIHRyYXZlcnNhbENvbnRleHQgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25TdGFnZUV4ZWN1dGVkPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uU3RhZ2VFeGVjdXRlZDogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25OZXh0KGZyb21TdGFnZTogc3RyaW5nLCB0b1N0YWdlOiBzdHJpbmcsIGRlc2NyaXB0aW9uPzogc3RyaW5nLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgZnJvbTogZnJvbVN0YWdlLCB0bzogdG9TdGFnZSwgZGVzY3JpcHRpb24sIHRyYXZlcnNhbENvbnRleHQgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25OZXh0Py4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSkgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvbk5leHQ6ICR7ZXJyfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uRGVjaXNpb24oXG4gICAgZGVjaWRlck5hbWU6IHN0cmluZyxcbiAgICBjaG9zZW5CcmFuY2g6IHN0cmluZyxcbiAgICByYXRpb25hbGU/OiBzdHJpbmcsXG4gICAgZGVjaWRlckRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICAgIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0LFxuICAgIGV2aWRlbmNlPzogRGVjaXNpb25FdmlkZW5jZSxcbiAgKTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGV2ZW50ID0ge1xuICAgICAgZGVjaWRlcjogZGVjaWRlck5hbWUsXG4gICAgICBjaG9zZW46IGNob3NlbkJyYW5jaCxcbiAgICAgIHJhdGlvbmFsZSxcbiAgICAgIGRlc2NyaXB0aW9uOiBkZWNpZGVyRGVzY3JpcHRpb24sXG4gICAgICB0cmF2ZXJzYWxDb250ZXh0LFxuICAgICAgZXZpZGVuY2UsXG4gICAgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25EZWNpc2lvbj8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvbkRlY2lzaW9uOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvbkZvcmsocGFyZW50U3RhZ2U6IHN0cmluZywgY2hpbGROYW1lczogc3RyaW5nW10sIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0KTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGV2ZW50ID0geyBwYXJlbnQ6IHBhcmVudFN0YWdlLCBjaGlsZHJlbjogY2hpbGROYW1lcywgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vbkZvcms/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKSBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uRm9yazogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25TZWxlY3RlZChcbiAgICBwYXJlbnRTdGFnZTogc3RyaW5nLFxuICAgIHNlbGVjdGVkTmFtZXM6IHN0cmluZ1tdLFxuICAgIHRvdGFsQ291bnQ6IG51bWJlcixcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgICBldmlkZW5jZT86IFNlbGVjdGlvbkV2aWRlbmNlLFxuICApOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IHBhcmVudDogcGFyZW50U3RhZ2UsIHNlbGVjdGVkOiBzZWxlY3RlZE5hbWVzLCB0b3RhbDogdG90YWxDb3VudCwgdHJhdmVyc2FsQ29udGV4dCwgZXZpZGVuY2UgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25TZWxlY3RlZD8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvblNlbGVjdGVkOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvblN1YmZsb3dFbnRyeShcbiAgICBzdWJmbG93TmFtZTogc3RyaW5nLFxuICAgIHN1YmZsb3dJZD86IHN0cmluZyxcbiAgICBkZXNjcmlwdGlvbj86IHN0cmluZyxcbiAgICB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCxcbiAgKTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGV2ZW50ID0geyBuYW1lOiBzdWJmbG93TmFtZSwgc3ViZmxvd0lkLCBkZXNjcmlwdGlvbiwgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vblN1YmZsb3dFbnRyeT8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvblN1YmZsb3dFbnRyeTogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25TdWJmbG93RXhpdChzdWJmbG93TmFtZTogc3RyaW5nLCBzdWJmbG93SWQ/OiBzdHJpbmcsIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0KTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGV2ZW50ID0geyBuYW1lOiBzdWJmbG93TmFtZSwgc3ViZmxvd0lkLCB0cmF2ZXJzYWxDb250ZXh0IH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uU3ViZmxvd0V4aXQ/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKVxuICAgICAgICAgIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gRmxvd1JlY29yZGVyRGlzcGF0Y2hlcjogcmVjb3JkZXIgXCIke3IuaWR9XCIgdGhyZXcgaW4gb25TdWJmbG93RXhpdDogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25TdWJmbG93UmVnaXN0ZXJlZChzdWJmbG93SWQ6IHN0cmluZywgbmFtZTogc3RyaW5nLCBkZXNjcmlwdGlvbj86IHN0cmluZywgc3BlY1N0cnVjdHVyZT86IHVua25vd24pOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IHN1YmZsb3dJZCwgbmFtZSwgZGVzY3JpcHRpb24sIHNwZWNTdHJ1Y3R1cmUgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25TdWJmbG93UmVnaXN0ZXJlZD8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvblN1YmZsb3dSZWdpc3RlcmVkOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvbkxvb3AodGFyZ2V0U3RhZ2U6IHN0cmluZywgaXRlcmF0aW9uOiBudW1iZXIsIGRlc2NyaXB0aW9uPzogc3RyaW5nLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgdGFyZ2V0OiB0YXJnZXRTdGFnZSwgaXRlcmF0aW9uLCBkZXNjcmlwdGlvbiwgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vbkxvb3A/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKSBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uTG9vcDogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25CcmVhayhzdGFnZU5hbWU6IHN0cmluZywgdHJhdmVyc2FsQ29udGV4dD86IFRyYXZlcnNhbENvbnRleHQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IHN0YWdlTmFtZSwgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vbkJyZWFrPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uQnJlYWs6ICR7ZXJyfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uRXJyb3Ioc3RhZ2VOYW1lOiBzdHJpbmcsIGVycm9yTWVzc2FnZTogc3RyaW5nLCBlcnJvcjogdW5rbm93biwgdHJhdmVyc2FsQ29udGV4dD86IFRyYXZlcnNhbENvbnRleHQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3Qgc3RydWN0dXJlZEVycm9yID0gZXh0cmFjdEVycm9ySW5mbyhlcnJvcik7XG4gICAgY29uc3QgZXZlbnQgPSB7IHN0YWdlTmFtZSwgbWVzc2FnZTogZXJyb3JNZXNzYWdlLCBzdHJ1Y3R1cmVkRXJyb3IsIHRyYXZlcnNhbENvbnRleHQgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25FcnJvcj8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvbkVycm9yOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvblBhdXNlKFxuICAgIHN0YWdlTmFtZTogc3RyaW5nLFxuICAgIHN0YWdlSWQ6IHN0cmluZyxcbiAgICBwYXVzZURhdGE6IHVua25vd24sXG4gICAgc3ViZmxvd1BhdGg6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICAgIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0LFxuICApOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IHN0YWdlTmFtZSwgc3RhZ2VJZCwgcGF1c2VEYXRhLCBzdWJmbG93UGF0aCwgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vblBhdXNlPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uUGF1c2U6ICR7ZXJyfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uUmVzdW1lKHN0YWdlTmFtZTogc3RyaW5nLCBzdGFnZUlkOiBzdHJpbmcsIGhhc0lucHV0OiBib29sZWFuLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgc3RhZ2VOYW1lLCBzdGFnZUlkLCBoYXNJbnB1dCwgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vblJlc3VtZT8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvblJlc3VtZTogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgc2VudGVuY2VzIGZyb20gYW4gYXR0YWNoZWQgTmFycmF0aXZlRmxvd1JlY29yZGVyIChsb29rZWQgdXAgYnkgSUQpLlxuICAgKiBDYWxsZXJzIHRoYXQgbmVlZCBzZW50ZW5jZXMgc2hvdWxkIGF0dGFjaCBhIE5hcnJhdGl2ZUZsb3dSZWNvcmRlciB3aXRoIGlkICduYXJyYXRpdmUnXG4gICAqIGFuZCByZXRyaWV2ZSBpdCBkaXJlY3RseSB2aWEgZ2V0UmVjb3JkZXJCeUlkKCkgaWYgdGhleSBuZWVkIHR5cGVkIGFjY2Vzcy5cbiAgICovXG4gIGdldFNlbnRlbmNlcygpOiBzdHJpbmdbXSB7XG4gICAgY29uc3QgbmFycmF0aXZlID0gdGhpcy5nZXRSZWNvcmRlckJ5SWQ8TmFycmF0aXZlRmxvd1JlY29yZGVyPignbmFycmF0aXZlJyk7XG4gICAgcmV0dXJuIG5hcnJhdGl2ZT8uZ2V0U2VudGVuY2VzKCkgPz8gW107XG4gIH1cbn1cbiJdfQ==