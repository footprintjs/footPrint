"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.FlowRecorderDispatcher = void 0;
const detectCircular_js_1 = require("../../scope/detectCircular.js");
const errorInfo_js_1 = require("../errors/errorInfo.js");
class FlowRecorderDispatcher {
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
                if ((0, detectCircular_js_1.isDevMode)())
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
                if ((0, detectCircular_js_1.isDevMode)())
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
                if ((0, detectCircular_js_1.isDevMode)())
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
                if ((0, detectCircular_js_1.isDevMode)())
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
                if ((0, detectCircular_js_1.isDevMode)())
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
                if ((0, detectCircular_js_1.isDevMode)())
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
                if ((0, detectCircular_js_1.isDevMode)())
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
                if ((0, detectCircular_js_1.isDevMode)())
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
                if ((0, detectCircular_js_1.isDevMode)())
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
                if ((0, detectCircular_js_1.isDevMode)())
                    console.warn(`[footprint] FlowRecorderDispatcher: recorder "${r.id}" threw in onBreak: ${err}`);
            }
        }
    }
    onError(stageName, errorMessage, error, traversalContext) {
        var _a;
        if (this.recorders.length === 0)
            return;
        const structuredError = (0, errorInfo_js_1.extractErrorInfo)(error);
        const event = { stageName, message: errorMessage, structuredError, traversalContext };
        for (const r of this.recorders) {
            try {
                (_a = r.onError) === null || _a === void 0 ? void 0 : _a.call(r, event);
            }
            catch (err) {
                if ((0, detectCircular_js_1.isDevMode)())
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
                if ((0, detectCircular_js_1.isDevMode)())
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
                if ((0, detectCircular_js_1.isDevMode)())
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
exports.FlowRecorderDispatcher = FlowRecorderDispatcher;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRmxvd1JlY29yZGVyRGlzcGF0Y2hlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvZW5naW5lL25hcnJhdGl2ZS9GbG93UmVjb3JkZXJEaXNwYXRjaGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7OztHQVVHOzs7QUFHSCxxRUFBMEQ7QUFDMUQseURBQTBEO0FBSTFELE1BQWEsc0JBQXNCO0lBQW5DO1FBQ1UsY0FBUyxHQUFtQixFQUFFLENBQUM7SUF1T3pDLENBQUM7SUFyT0MsaUZBQWlGO0lBQ2pGLE1BQU0sQ0FBQyxRQUFzQjtRQUMzQixJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUNoQyxDQUFDO0lBRUQsa0RBQWtEO0lBQ2xELE1BQU0sQ0FBQyxFQUFVO1FBQ2YsSUFBSSxDQUFDLFNBQVMsR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUM3RCxDQUFDO0lBRUQsc0RBQXNEO0lBQ3RELFlBQVk7UUFDVixPQUFPLENBQUMsR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDN0IsQ0FBQztJQUVELGtHQUFrRztJQUNsRyxlQUFlLENBQXdDLEVBQVU7UUFDL0QsT0FBTyxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsS0FBSyxFQUFFLENBQWtCLENBQUM7SUFDbEUsQ0FBQztJQUVELDZFQUE2RTtJQUU3RSxlQUFlLENBQUMsU0FBaUIsRUFBRSxXQUFvQixFQUFFLGdCQUFtQzs7UUFDMUYsSUFBSSxJQUFJLENBQUMsU0FBUyxDQUFDLE1BQU0sS0FBSyxDQUFDO1lBQUUsT0FBTztRQUN4QyxNQUFNLEtBQUssR0FBRyxFQUFFLFNBQVMs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Q0FBQztDQUNGO0FBeE9ELHdEQXdPQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRmxvd1JlY29yZGVyRGlzcGF0Y2hlciDigJQgRmFucyBvdXQgY29udHJvbCBmbG93IGV2ZW50cyB0byBOIGF0dGFjaGVkIEZsb3dSZWNvcmRlcnMuXG4gKlxuICogSW1wbGVtZW50cyBJQ29udHJvbEZsb3dOYXJyYXRpdmUgc28gaXQgY2FuIHJlcGxhY2UgdGhlIHNpbmdsZVxuICogQ29udHJvbEZsb3dOYXJyYXRpdmVHZW5lcmF0b3IgaW4gdGhlIHRyYXZlcnNlcidzIEhhbmRsZXJEZXBzLlxuICpcbiAqIERlc2lnbiBtaXJyb3JzIFNjb3BlRmFjYWRlLl9pbnZva2VIb29rOiBpdGVyYXRlIHJlY29yZGVycywgY2FsbCBvcHRpb25hbFxuICogaG9va3MsIHN3YWxsb3cgZXJyb3JzIHNvIGEgZmFpbGluZyByZWNvcmRlciBuZXZlciBicmVha3MgZXhlY3V0aW9uLlxuICpcbiAqIFdoZW4gbm8gcmVjb3JkZXJzIGFyZSBhdHRhY2hlZCwgZXZlcnkgbWV0aG9kIGlzIGEgZmFzdCBuby1vcCAoZW1wdHkgYXJyYXkgY2hlY2spLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRGVjaXNpb25FdmlkZW5jZSwgU2VsZWN0aW9uRXZpZGVuY2UgfSBmcm9tICcuLi8uLi9kZWNpZGUvdHlwZXMuanMnO1xuaW1wb3J0IHsgaXNEZXZNb2RlIH0gZnJvbSAnLi4vLi4vc2NvcGUvZGV0ZWN0Q2lyY3VsYXIuanMnO1xuaW1wb3J0IHsgZXh0cmFjdEVycm9ySW5mbyB9IGZyb20gJy4uL2Vycm9ycy9lcnJvckluZm8uanMnO1xuaW1wb3J0IHR5cGUgeyBOYXJyYXRpdmVGbG93UmVjb3JkZXIgfSBmcm9tICcuL05hcnJhdGl2ZUZsb3dSZWNvcmRlci5qcyc7XG5pbXBvcnQgdHlwZSB7IEZsb3dSZWNvcmRlciwgSUNvbnRyb2xGbG93TmFycmF0aXZlLCBUcmF2ZXJzYWxDb250ZXh0IH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBjbGFzcyBGbG93UmVjb3JkZXJEaXNwYXRjaGVyIGltcGxlbWVudHMgSUNvbnRyb2xGbG93TmFycmF0aXZlIHtcbiAgcHJpdmF0ZSByZWNvcmRlcnM6IEZsb3dSZWNvcmRlcltdID0gW107XG5cbiAgLyoqIEF0dGFjaCBhIEZsb3dSZWNvcmRlci4gRHVwbGljYXRlIElEcyBhcmUgYWxsb3dlZCAoc2FtZSBhcyBzY29wZSBSZWNvcmRlcikuICovXG4gIGF0dGFjaChyZWNvcmRlcjogRmxvd1JlY29yZGVyKTogdm9pZCB7XG4gICAgdGhpcy5yZWNvcmRlcnMucHVzaChyZWNvcmRlcik7XG4gIH1cblxuICAvKiogRGV0YWNoIGFsbCBGbG93UmVjb3JkZXJzIHdpdGggdGhlIGdpdmVuIElELiAqL1xuICBkZXRhY2goaWQ6IHN0cmluZyk6IHZvaWQge1xuICAgIHRoaXMucmVjb3JkZXJzID0gdGhpcy5yZWNvcmRlcnMuZmlsdGVyKChyKSA9PiByLmlkICE9PSBpZCk7XG4gIH1cblxuICAvKiogUmV0dXJucyBhIGRlZmVuc2l2ZSBjb3B5IG9mIGF0dGFjaGVkIHJlY29yZGVycy4gKi9cbiAgZ2V0UmVjb3JkZXJzKCk6IEZsb3dSZWNvcmRlcltdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMucmVjb3JkZXJzXTtcbiAgfVxuXG4gIC8qKiBGaW5kIGEgcmVjb3JkZXIgYnkgSUQuIFVzZWZ1bCBmb3IgcmV0cmlldmluZyBidWlsdC1pbiByZWNvcmRlcnMgbGlrZSBOYXJyYXRpdmVGbG93UmVjb3JkZXIuICovXG4gIGdldFJlY29yZGVyQnlJZDxUIGV4dGVuZHMgRmxvd1JlY29yZGVyID0gRmxvd1JlY29yZGVyPihpZDogc3RyaW5nKTogVCB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMucmVjb3JkZXJzLmZpbmQoKHIpID0+IHIuaWQgPT09IGlkKSBhcyBUIHwgdW5kZWZpbmVkO1xuICB9XG5cbiAgLy8g4pSA4pSAIElDb250cm9sRmxvd05hcnJhdGl2ZSBpbXBsZW1lbnRhdGlvbiDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBvblN0YWdlRXhlY3V0ZWQoc3RhZ2VOYW1lOiBzdHJpbmcsIGRlc2NyaXB0aW9uPzogc3RyaW5nLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgc3RhZ2VOYW1lLCBkZXNjcmlwdGlvbiwgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vblN0YWdlRXhlY3V0ZWQ/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKVxuICAgICAgICAgIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gRmxvd1JlY29yZGVyRGlzcGF0Y2hlcjogcmVjb3JkZXIgXCIke3IuaWR9XCIgdGhyZXcgaW4gb25TdGFnZUV4ZWN1dGVkOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvbk5leHQoZnJvbVN0YWdlOiBzdHJpbmcsIHRvU3RhZ2U6IHN0cmluZywgZGVzY3JpcHRpb24/OiBzdHJpbmcsIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0KTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGV2ZW50ID0geyBmcm9tOiBmcm9tU3RhZ2UsIHRvOiB0b1N0YWdlLCBkZXNjcmlwdGlvbiwgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vbk5leHQ/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKSBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uTmV4dDogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25EZWNpc2lvbihcbiAgICBkZWNpZGVyTmFtZTogc3RyaW5nLFxuICAgIGNob3NlbkJyYW5jaDogc3RyaW5nLFxuICAgIHJhdGlvbmFsZT86IHN0cmluZyxcbiAgICBkZWNpZGVyRGVzY3JpcHRpb24/OiBzdHJpbmcsXG4gICAgdHJhdmVyc2FsQ29udGV4dD86IFRyYXZlcnNhbENvbnRleHQsXG4gICAgZXZpZGVuY2U/OiBEZWNpc2lvbkV2aWRlbmNlLFxuICApOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7XG4gICAgICBkZWNpZGVyOiBkZWNpZGVyTmFtZSxcbiAgICAgIGNob3NlbjogY2hvc2VuQnJhbmNoLFxuICAgICAgcmF0aW9uYWxlLFxuICAgICAgZGVzY3JpcHRpb246IGRlY2lkZXJEZXNjcmlwdGlvbixcbiAgICAgIHRyYXZlcnNhbENvbnRleHQsXG4gICAgICBldmlkZW5jZSxcbiAgICB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vbkRlY2lzaW9uPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uRGVjaXNpb246ICR7ZXJyfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uRm9yayhwYXJlbnRTdGFnZTogc3RyaW5nLCBjaGlsZE5hbWVzOiBzdHJpbmdbXSwgdHJhdmVyc2FsQ29udGV4dD86IFRyYXZlcnNhbENvbnRleHQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IHBhcmVudDogcGFyZW50U3RhZ2UsIGNoaWxkcmVuOiBjaGlsZE5hbWVzLCB0cmF2ZXJzYWxDb250ZXh0IH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uRm9yaz8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gRmxvd1JlY29yZGVyRGlzcGF0Y2hlcjogcmVjb3JkZXIgXCIke3IuaWR9XCIgdGhyZXcgaW4gb25Gb3JrOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvblNlbGVjdGVkKFxuICAgIHBhcmVudFN0YWdlOiBzdHJpbmcsXG4gICAgc2VsZWN0ZWROYW1lczogc3RyaW5nW10sXG4gICAgdG90YWxDb3VudDogbnVtYmVyLFxuICAgIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0LFxuICAgIGV2aWRlbmNlPzogU2VsZWN0aW9uRXZpZGVuY2UsXG4gICk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgcGFyZW50OiBwYXJlbnRTdGFnZSwgc2VsZWN0ZWQ6IHNlbGVjdGVkTmFtZXMsIHRvdGFsOiB0b3RhbENvdW50LCB0cmF2ZXJzYWxDb250ZXh0LCBldmlkZW5jZSB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vblNlbGVjdGVkPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uU2VsZWN0ZWQ6ICR7ZXJyfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uU3ViZmxvd0VudHJ5KFxuICAgIHN1YmZsb3dOYW1lOiBzdHJpbmcsXG4gICAgc3ViZmxvd0lkPzogc3RyaW5nLFxuICAgIGRlc2NyaXB0aW9uPzogc3RyaW5nLFxuICAgIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0LFxuICApOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IG5hbWU6IHN1YmZsb3dOYW1lLCBzdWJmbG93SWQsIGRlc2NyaXB0aW9uLCB0cmF2ZXJzYWxDb250ZXh0IH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uU3ViZmxvd0VudHJ5Py4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uU3ViZmxvd0VudHJ5OiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvblN1YmZsb3dFeGl0KHN1YmZsb3dOYW1lOiBzdHJpbmcsIHN1YmZsb3dJZD86IHN0cmluZywgdHJhdmVyc2FsQ29udGV4dD86IFRyYXZlcnNhbENvbnRleHQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5yZWNvcmRlcnMubGVuZ3RoID09PSAwKSByZXR1cm47XG4gICAgY29uc3QgZXZlbnQgPSB7IG5hbWU6IHN1YmZsb3dOYW1lLCBzdWJmbG93SWQsIHRyYXZlcnNhbENvbnRleHQgfTtcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5yZWNvcmRlcnMpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIHIub25TdWJmbG93RXhpdD8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpXG4gICAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBGbG93UmVjb3JkZXJEaXNwYXRjaGVyOiByZWNvcmRlciBcIiR7ci5pZH1cIiB0aHJldyBpbiBvblN1YmZsb3dFeGl0OiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvblN1YmZsb3dSZWdpc3RlcmVkKHN1YmZsb3dJZDogc3RyaW5nLCBuYW1lOiBzdHJpbmcsIGRlc2NyaXB0aW9uPzogc3RyaW5nLCBzcGVjU3RydWN0dXJlPzogdW5rbm93bik6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgc3ViZmxvd0lkLCBuYW1lLCBkZXNjcmlwdGlvbiwgc3BlY1N0cnVjdHVyZSB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vblN1YmZsb3dSZWdpc3RlcmVkPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uU3ViZmxvd1JlZ2lzdGVyZWQ6ICR7ZXJyfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uTG9vcCh0YXJnZXRTdGFnZTogc3RyaW5nLCBpdGVyYXRpb246IG51bWJlciwgZGVzY3JpcHRpb24/OiBzdHJpbmcsIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0KTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGV2ZW50ID0geyB0YXJnZXQ6IHRhcmdldFN0YWdlLCBpdGVyYXRpb24sIGRlc2NyaXB0aW9uLCB0cmF2ZXJzYWxDb250ZXh0IH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uTG9vcD8uKGV2ZW50KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBpZiAoaXNEZXZNb2RlKCkpIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gRmxvd1JlY29yZGVyRGlzcGF0Y2hlcjogcmVjb3JkZXIgXCIke3IuaWR9XCIgdGhyZXcgaW4gb25Mb29wOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvbkJyZWFrKHN0YWdlTmFtZTogc3RyaW5nLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgc3RhZ2VOYW1lLCB0cmF2ZXJzYWxDb250ZXh0IH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uQnJlYWs/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKVxuICAgICAgICAgIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gRmxvd1JlY29yZGVyRGlzcGF0Y2hlcjogcmVjb3JkZXIgXCIke3IuaWR9XCIgdGhyZXcgaW4gb25CcmVhazogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25FcnJvcihzdGFnZU5hbWU6IHN0cmluZywgZXJyb3JNZXNzYWdlOiBzdHJpbmcsIGVycm9yOiB1bmtub3duLCB0cmF2ZXJzYWxDb250ZXh0PzogVHJhdmVyc2FsQ29udGV4dCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBzdHJ1Y3R1cmVkRXJyb3IgPSBleHRyYWN0RXJyb3JJbmZvKGVycm9yKTtcbiAgICBjb25zdCBldmVudCA9IHsgc3RhZ2VOYW1lLCBtZXNzYWdlOiBlcnJvck1lc3NhZ2UsIHN0cnVjdHVyZWRFcnJvciwgdHJhdmVyc2FsQ29udGV4dCB9O1xuICAgIGZvciAoY29uc3QgciBvZiB0aGlzLnJlY29yZGVycykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgci5vbkVycm9yPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uRXJyb3I6ICR7ZXJyfWApO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIG9uUGF1c2UoXG4gICAgc3RhZ2VOYW1lOiBzdHJpbmcsXG4gICAgc3RhZ2VJZDogc3RyaW5nLFxuICAgIHBhdXNlRGF0YTogdW5rbm93bixcbiAgICBzdWJmbG93UGF0aDogcmVhZG9ubHkgc3RyaW5nW10sXG4gICAgdHJhdmVyc2FsQ29udGV4dD86IFRyYXZlcnNhbENvbnRleHQsXG4gICk6IHZvaWQge1xuICAgIGlmICh0aGlzLnJlY29yZGVycy5sZW5ndGggPT09IDApIHJldHVybjtcbiAgICBjb25zdCBldmVudCA9IHsgc3RhZ2VOYW1lLCBzdGFnZUlkLCBwYXVzZURhdGEsIHN1YmZsb3dQYXRoLCB0cmF2ZXJzYWxDb250ZXh0IH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uUGF1c2U/LihldmVudCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgaWYgKGlzRGV2TW9kZSgpKVxuICAgICAgICAgIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gRmxvd1JlY29yZGVyRGlzcGF0Y2hlcjogcmVjb3JkZXIgXCIke3IuaWR9XCIgdGhyZXcgaW4gb25QYXVzZTogJHtlcnJ9YCk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgb25SZXN1bWUoc3RhZ2VOYW1lOiBzdHJpbmcsIHN0YWdlSWQ6IHN0cmluZywgaGFzSW5wdXQ6IGJvb2xlYW4sIHRyYXZlcnNhbENvbnRleHQ/OiBUcmF2ZXJzYWxDb250ZXh0KTogdm9pZCB7XG4gICAgaWYgKHRoaXMucmVjb3JkZXJzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xuICAgIGNvbnN0IGV2ZW50ID0geyBzdGFnZU5hbWUsIHN0YWdlSWQsIGhhc0lucHV0LCB0cmF2ZXJzYWxDb250ZXh0IH07XG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMucmVjb3JkZXJzKSB7XG4gICAgICB0cnkge1xuICAgICAgICByLm9uUmVzdW1lPy4oZXZlbnQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGlmIChpc0Rldk1vZGUoKSlcbiAgICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIEZsb3dSZWNvcmRlckRpc3BhdGNoZXI6IHJlY29yZGVyIFwiJHtyLmlkfVwiIHRocmV3IGluIG9uUmVzdW1lOiAke2Vycn1gKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyBzZW50ZW5jZXMgZnJvbSBhbiBhdHRhY2hlZCBOYXJyYXRpdmVGbG93UmVjb3JkZXIgKGxvb2tlZCB1cCBieSBJRCkuXG4gICAqIENhbGxlcnMgdGhhdCBuZWVkIHNlbnRlbmNlcyBzaG91bGQgYXR0YWNoIGEgTmFycmF0aXZlRmxvd1JlY29yZGVyIHdpdGggaWQgJ25hcnJhdGl2ZSdcbiAgICogYW5kIHJldHJpZXZlIGl0IGRpcmVjdGx5IHZpYSBnZXRSZWNvcmRlckJ5SWQoKSBpZiB0aGV5IG5lZWQgdHlwZWQgYWNjZXNzLlxuICAgKi9cbiAgZ2V0U2VudGVuY2VzKCk6IHN0cmluZ1tdIHtcbiAgICBjb25zdCBuYXJyYXRpdmUgPSB0aGlzLmdldFJlY29yZGVyQnlJZDxOYXJyYXRpdmVGbG93UmVjb3JkZXI+KCduYXJyYXRpdmUnKTtcbiAgICByZXR1cm4gbmFycmF0aXZlPy5nZXRTZW50ZW5jZXMoKSA/PyBbXTtcbiAgfVxufVxuIl19