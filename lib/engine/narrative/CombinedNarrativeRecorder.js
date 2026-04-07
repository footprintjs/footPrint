"use strict";
/**
 * CombinedNarrativeRecorder — Inline narrative builder that merges flow + data during traversal.
 *
 * Replaces the post-processing CombinedNarrativeBuilder by implementing BOTH
 * FlowRecorder (control-flow events) and Recorder (scope data events).
 *
 * Event ordering guarantees this works:
 *   1. Scope events (onRead, onWrite) fire DURING stage execution
 *   2. Flow events (onStageExecuted, onDecision) fire AFTER stage execution
 *   3. Both carry the same `stageName` — no matching ambiguity
 *
 * So we buffer scope ops per-stage, then when the flow event arrives,
 * emit the stage entry + flush the buffered ops in one pass.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CombinedNarrativeRecorder = void 0;
const summarizeValue_js_1 = require("../../scope/recorders/summarizeValue.js");
// ── Recorder ───────────────────────────────────────────────────────────────
class CombinedNarrativeRecorder {
    constructor(options) {
        var _a, _b, _c, _d, _e;
        this.entries = [];
        /**
         * Pending scope ops keyed by stageName. Flushed in onStageExecuted/onDecision.
         *
         * Name collisions (two stages with the same name, different IDs) are prevented by
         * the event ordering contract: scope events (onRead/onWrite) for stage N are always
         * flushed by onStageExecuted for stage N before stage N+1's scope events begin.
         * So the key is always uniquely bound to the currently-executing stage.
         */
        this.pendingOps = new Map();
        /** Per-subflow stage counters. Key '' = root flow. */
        this.stageCounters = new Map();
        /** Per-subflow first-stage flags. Key '' = root flow. */
        this.firstStageFlags = new Map();
        this.id = (_a = options === null || options === void 0 ? void 0 : options.id) !== null && _a !== void 0 ? _a : 'combined-narrative';
        this.includeStepNumbers = (_b = options === null || options === void 0 ? void 0 : options.includeStepNumbers) !== null && _b !== void 0 ? _b : true;
        this.includeValues = (_c = options === null || options === void 0 ? void 0 : options.includeValues) !== null && _c !== void 0 ? _c : true;
        this.maxValueLength = (_d = options === null || options === void 0 ? void 0 : options.maxValueLength) !== null && _d !== void 0 ? _d : 80;
        this.formatValue = (_e = options === null || options === void 0 ? void 0 : options.formatValue) !== null && _e !== void 0 ? _e : summarizeValue_js_1.summarizeValue;
        this.renderer = options === null || options === void 0 ? void 0 : options.renderer;
    }
    // ── Scope channel (fires first, during stage execution) ───────────────
    onRead(event) {
        if (!event.key)
            return;
        this.bufferOp(event.stageName, {
            type: 'read',
            key: event.key,
            rawValue: event.value,
        });
    }
    onWrite(event) {
        this.bufferOp(event.stageName, {
            type: 'write',
            key: event.key,
            rawValue: event.value,
            operation: event.operation,
        });
    }
    // ── Flow channel (fires after stage execution) ────────────────────────
    onStageExecuted(event) {
        var _a, _b, _c, _d, _e, _f, _g;
        const stageId = (_a = event.traversalContext) === null || _a === void 0 ? void 0 : _a.stageId;
        const sfKey = (_c = (_b = event.traversalContext) === null || _b === void 0 ? void 0 : _b.subflowId) !== null && _c !== void 0 ? _c : '';
        const stageNum = this.incrementStageCounter(sfKey);
        const isFirst = this.consumeFirstStageFlag(sfKey);
        const ctx = {
            stageName: event.stageName,
            stageNumber: stageNum,
            isFirst,
            description: event.description,
        };
        const text = (_f = (_e = (_d = this.renderer) === null || _d === void 0 ? void 0 : _d.renderStage) === null || _e === void 0 ? void 0 : _e.call(_d, ctx)) !== null && _f !== void 0 ? _f : this.defaultRenderStage(ctx);
        const sfId = (_g = event.traversalContext) === null || _g === void 0 ? void 0 : _g.subflowId;
        this.entries.push({
            type: 'stage',
            text,
            depth: 0,
            stageName: event.stageName,
            stageId,
            subflowId: sfId,
        });
        this.flushOps(event.stageName, sfId, stageId);
    }
    onDecision(event) {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
        const deciderStageIdEarly = (_a = event.traversalContext) === null || _a === void 0 ? void 0 : _a.stageId;
        // Emit the decider stage entry (deciders don't fire onStageExecuted)
        const sfKey = (_c = (_b = event.traversalContext) === null || _b === void 0 ? void 0 : _b.subflowId) !== null && _c !== void 0 ? _c : '';
        const stageNum = this.incrementStageCounter(sfKey);
        const isFirst = this.consumeFirstStageFlag(sfKey);
        const stageCtx = {
            stageName: event.decider,
            stageNumber: stageNum,
            isFirst,
            description: event.description,
        };
        const stageText = (_f = (_e = (_d = this.renderer) === null || _d === void 0 ? void 0 : _d.renderStage) === null || _e === void 0 ? void 0 : _e.call(_d, stageCtx)) !== null && _f !== void 0 ? _f : this.defaultRenderStage(stageCtx);
        this.entries.push({
            type: 'stage',
            text: stageText,
            depth: 0,
            stageName: event.decider,
            stageId: deciderStageIdEarly,
            subflowId: (_g = event.traversalContext) === null || _g === void 0 ? void 0 : _g.subflowId,
        });
        this.flushOps(event.decider, (_h = event.traversalContext) === null || _h === void 0 ? void 0 : _h.subflowId, deciderStageIdEarly);
        // Emit the condition entry as a nested sub-item (depth 1) of the stage above.
        // Decision outcome is a detail of the decider stage, not a separate top-level entry.
        const decisionCtx = {
            decider: event.decider,
            chosen: event.chosen,
            description: event.description,
            rationale: event.rationale,
            evidence: event.evidence,
        };
        const conditionText = (_l = (_k = (_j = this.renderer) === null || _j === void 0 ? void 0 : _j.renderDecision) === null || _k === void 0 ? void 0 : _k.call(_j, decisionCtx)) !== null && _l !== void 0 ? _l : this.defaultRenderDecision(decisionCtx);
        this.entries.push({
            type: 'condition',
            text: conditionText,
            depth: 1,
            stageName: event.decider,
            stageId: deciderStageIdEarly,
            subflowId: (_m = event.traversalContext) === null || _m === void 0 ? void 0 : _m.subflowId,
        });
    }
    onNext() {
        // No-op. onStageExecuted already has the description for the next stage.
        // For deciders (no onStageExecuted), onDecision handles the announcement.
    }
    onFork(event) {
        var _a, _b, _c, _d, _e;
        const ctx = { children: event.children };
        const text = (_c = (_b = (_a = this.renderer) === null || _a === void 0 ? void 0 : _a.renderFork) === null || _b === void 0 ? void 0 : _b.call(_a, ctx)) !== null && _c !== void 0 ? _c : this.defaultRenderFork(ctx);
        this.entries.push({
            type: 'fork',
            text,
            depth: 0,
            stageId: (_d = event.traversalContext) === null || _d === void 0 ? void 0 : _d.stageId,
            subflowId: (_e = event.traversalContext) === null || _e === void 0 ? void 0 : _e.subflowId,
        });
    }
    onSelected(event) {
        var _a, _b, _c, _d, _e;
        const ctx = {
            selected: event.selected,
            total: event.total,
            evidence: event.evidence,
        };
        const text = (_c = (_b = (_a = this.renderer) === null || _a === void 0 ? void 0 : _a.renderSelected) === null || _b === void 0 ? void 0 : _b.call(_a, ctx)) !== null && _c !== void 0 ? _c : this.defaultRenderSelected(ctx);
        this.entries.push({
            type: 'selector',
            text,
            depth: 0,
            stageId: (_d = event.traversalContext) === null || _d === void 0 ? void 0 : _d.stageId,
            subflowId: (_e = event.traversalContext) === null || _e === void 0 ? void 0 : _e.subflowId,
        });
    }
    onSubflowEntry(event) {
        var _a, _b, _c, _d, _e, _f;
        // Reset stage counter for this subflow so stages start at "Stage 1" on re-entry
        const sfKey = (_a = event.subflowId) !== null && _a !== void 0 ? _a : '';
        this.stageCounters.delete(sfKey);
        this.firstStageFlags.delete(sfKey);
        const ctx = {
            name: event.name,
            direction: 'entry',
            description: event.description,
        };
        const text = (_d = (_c = (_b = this.renderer) === null || _b === void 0 ? void 0 : _b.renderSubflow) === null || _c === void 0 ? void 0 : _c.call(_b, ctx)) !== null && _d !== void 0 ? _d : this.defaultRenderSubflow(ctx);
        this.entries.push({
            type: 'subflow',
            text,
            depth: 0,
            stageName: event.name,
            stageId: (_e = event.traversalContext) === null || _e === void 0 ? void 0 : _e.stageId,
            subflowId: (_f = event.traversalContext) === null || _f === void 0 ? void 0 : _f.subflowId,
        });
    }
    onSubflowExit(event) {
        var _a, _b, _c, _d, _e;
        const ctx = {
            name: event.name,
            direction: 'exit',
        };
        const text = (_c = (_b = (_a = this.renderer) === null || _a === void 0 ? void 0 : _a.renderSubflow) === null || _b === void 0 ? void 0 : _b.call(_a, ctx)) !== null && _c !== void 0 ? _c : this.defaultRenderSubflow(ctx);
        this.entries.push({
            type: 'subflow',
            text,
            depth: 0,
            stageName: event.name,
            stageId: (_d = event.traversalContext) === null || _d === void 0 ? void 0 : _d.stageId,
            subflowId: (_e = event.traversalContext) === null || _e === void 0 ? void 0 : _e.subflowId,
        });
    }
    onLoop(event) {
        var _a, _b, _c, _d, _e;
        const ctx = {
            target: event.target,
            iteration: event.iteration,
            description: event.description,
        };
        const text = (_c = (_b = (_a = this.renderer) === null || _a === void 0 ? void 0 : _a.renderLoop) === null || _b === void 0 ? void 0 : _b.call(_a, ctx)) !== null && _c !== void 0 ? _c : this.defaultRenderLoop(ctx);
        this.entries.push({
            type: 'loop',
            text,
            depth: 0,
            stageId: (_d = event.traversalContext) === null || _d === void 0 ? void 0 : _d.stageId,
            subflowId: (_e = event.traversalContext) === null || _e === void 0 ? void 0 : _e.subflowId,
        });
    }
    onBreak(event) {
        var _a, _b, _c, _d, _e;
        const ctx = { stageName: event.stageName };
        const text = (_c = (_b = (_a = this.renderer) === null || _a === void 0 ? void 0 : _a.renderBreak) === null || _b === void 0 ? void 0 : _b.call(_a, ctx)) !== null && _c !== void 0 ? _c : this.defaultRenderBreak(ctx);
        this.entries.push({
            type: 'break',
            text,
            depth: 0,
            stageName: event.stageName,
            stageId: (_d = event.traversalContext) === null || _d === void 0 ? void 0 : _d.stageId,
            subflowId: (_e = event.traversalContext) === null || _e === void 0 ? void 0 : _e.subflowId,
        });
    }
    onPause(event) {
        var _a, _b, _c;
        // Only handle FlowPauseEvent (from FlowRecorder channel); ignore scope PauseEvent.
        // FlowPauseEvent has 'subflowPath', scope PauseEvent has 'pipelineId'.
        if (Object.prototype.hasOwnProperty.call(event, 'pipelineId'))
            return;
        const flowEvent = event;
        if (!flowEvent.stageName || !flowEvent.stageId)
            return;
        const text = `Execution paused at ${flowEvent.stageName}.`;
        this.entries.push({
            type: 'pause',
            text,
            depth: 0,
            stageName: flowEvent.stageName,
            stageId: (_b = (_a = flowEvent.traversalContext) === null || _a === void 0 ? void 0 : _a.stageId) !== null && _b !== void 0 ? _b : flowEvent.stageId,
            subflowId: (_c = flowEvent.traversalContext) === null || _c === void 0 ? void 0 : _c.subflowId,
        });
    }
    onResume(event) {
        var _a, _b, _c;
        // Only handle FlowResumeEvent (from FlowRecorder channel); ignore scope ResumeEvent.
        if (Object.prototype.hasOwnProperty.call(event, 'pipelineId'))
            return;
        const flowEvent = event;
        if (!flowEvent.stageName || !flowEvent.stageId)
            return;
        const suffix = flowEvent.hasInput ? ' with input.' : '.';
        const text = `Execution resumed at ${flowEvent.stageName}${suffix}`;
        this.entries.push({
            type: 'resume',
            text,
            depth: 0,
            stageName: flowEvent.stageName,
            stageId: (_b = (_a = flowEvent.traversalContext) === null || _a === void 0 ? void 0 : _a.stageId) !== null && _b !== void 0 ? _b : flowEvent.stageId,
            subflowId: (_c = flowEvent.traversalContext) === null || _c === void 0 ? void 0 : _c.subflowId,
        });
    }
    /**
     * Handles errors from both channels:
     * - FlowRecorder.onError (FlowErrorEvent with message + structuredError)
     * - Recorder.onError (ErrorEvent from scope system — ignored for narrative)
     */
    onError(event) {
        var _a, _b, _c, _d, _e, _f, _g;
        // Only handle flow errors (which have `message` and `structuredError`)
        if (typeof event.message !== 'string')
            return;
        const flowEvent = event;
        let validationIssues;
        if ((_b = (_a = flowEvent.structuredError) === null || _a === void 0 ? void 0 : _a.issues) === null || _b === void 0 ? void 0 : _b.length) {
            validationIssues = flowEvent.structuredError.issues
                .map((issue) => {
                const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
                return `${path}: ${issue.message}`;
            })
                .join('; ');
        }
        const ctx = {
            stageName: flowEvent.stageName,
            message: flowEvent.message,
            validationIssues,
        };
        const text = (_e = (_d = (_c = this.renderer) === null || _c === void 0 ? void 0 : _c.renderError) === null || _d === void 0 ? void 0 : _d.call(_c, ctx)) !== null && _e !== void 0 ? _e : this.defaultRenderError(ctx);
        this.entries.push({
            type: 'error',
            text,
            depth: 0,
            stageName: flowEvent.stageName,
            stageId: (_f = flowEvent.traversalContext) === null || _f === void 0 ? void 0 : _f.stageId,
            subflowId: (_g = flowEvent.traversalContext) === null || _g === void 0 ? void 0 : _g.subflowId,
        });
    }
    // ── Output ────────────────────────────────────────────────────────────
    /** Returns structured entries for programmatic consumption. */
    getEntries() {
        return [...this.entries];
    }
    /** Returns formatted narrative lines (same output as CombinedNarrativeBuilder.build). */
    getNarrative(indent = '  ') {
        return this.entries.map((entry) => `${indent.repeat(entry.depth)}${entry.text}`);
    }
    /**
     * Returns entries grouped by subflowId for structured access.
     * Root-level entries have subflowId = undefined.
     */
    getEntriesBySubflow() {
        var _a;
        const result = { '': [] };
        for (const entry of this.entries) {
            const key = (_a = entry.subflowId) !== null && _a !== void 0 ? _a : '';
            if (!result[key])
                result[key] = [];
            result[key].push(entry);
        }
        return result;
    }
    /** Clears all state. Called automatically before each run. */
    clear() {
        this.entries = [];
        this.pendingOps.clear();
        this.stageCounters.clear();
        this.firstStageFlags.clear();
    }
    // ── Private helpers ───────────────────────────────────────────────────
    /** Increment and return the stage counter for a given subflow ('' = root). */
    incrementStageCounter(subflowKey) {
        var _a;
        const current = (_a = this.stageCounters.get(subflowKey)) !== null && _a !== void 0 ? _a : 0;
        const next = current + 1;
        this.stageCounters.set(subflowKey, next);
        return next;
    }
    /** Returns true if this is the first stage for the given subflow, consuming the flag. */
    consumeFirstStageFlag(subflowKey) {
        if (!this.firstStageFlags.has(subflowKey)) {
            this.firstStageFlags.set(subflowKey, false);
            return true;
        }
        return false;
    }
    bufferOp(stageName, op) {
        let ops = this.pendingOps.get(stageName);
        if (!ops) {
            ops = [];
            this.pendingOps.set(stageName, ops);
        }
        ops.push({ ...op, stepNumber: ops.length + 1 });
    }
    flushOps(stageName, subflowId, stageId) {
        var _a;
        const ops = this.pendingOps.get(stageName);
        if (!ops || ops.length === 0)
            return;
        for (const op of ops) {
            const valueSummary = this.formatValue(op.rawValue, this.maxValueLength);
            const opCtx = {
                type: op.type,
                key: op.key,
                rawValue: op.rawValue,
                valueSummary,
                operation: op.operation,
                stepNumber: op.stepNumber,
            };
            const text = ((_a = this.renderer) === null || _a === void 0 ? void 0 : _a.renderOp) ? this.renderer.renderOp(opCtx) : this.defaultRenderOp(opCtx);
            if (text == null)
                continue; // renderer excluded this op (null or undefined)
            this.entries.push({
                type: 'step',
                text,
                depth: 1,
                stageName,
                stageId,
                stepNumber: op.stepNumber,
                subflowId,
                key: op.key,
                rawValue: op.rawValue,
            });
        }
        this.pendingOps.delete(stageName);
    }
    // ── Default renderers (used when no custom renderer is provided) ────
    defaultRenderStage(ctx) {
        const inner = ctx.isFirst
            ? ctx.description
                ? `The process began: ${ctx.description}.`
                : `The process began with ${ctx.stageName}.`
            : ctx.description
                ? `Next step: ${ctx.description}.`
                : `Next, it moved on to ${ctx.stageName}.`;
        return `Stage ${ctx.stageNumber}: ${inner}`;
    }
    defaultRenderOp(ctx) {
        const stepPrefix = this.includeStepNumbers ? `Step ${ctx.stepNumber}: ` : '';
        if (ctx.type === 'read') {
            return this.includeValues && ctx.valueSummary
                ? `${stepPrefix}Read ${ctx.key} = ${ctx.valueSummary}`
                : `${stepPrefix}Read ${ctx.key}`;
        }
        if (ctx.operation === 'delete') {
            return `${stepPrefix}Delete ${ctx.key}`;
        }
        if (ctx.operation === 'update') {
            return this.includeValues
                ? `${stepPrefix}Update ${ctx.key} = ${ctx.valueSummary}`
                : `${stepPrefix}Update ${ctx.key}`;
        }
        return this.includeValues ? `${stepPrefix}Write ${ctx.key} = ${ctx.valueSummary}` : `${stepPrefix}Write ${ctx.key}`;
    }
    defaultRenderDecision(ctx) {
        var _a, _b, _c;
        const branchName = ctx.chosen;
        let conditionText;
        if (ctx.evidence) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const evidence = ctx.evidence;
            const matchedRule = (_a = evidence.rules) === null || _a === void 0 ? void 0 : _a.find((r) => r.matched);
            if (matchedRule) {
                const label = matchedRule.label ? ` "${matchedRule.label}"` : '';
                if (matchedRule.type === 'filter') {
                    const parts = matchedRule.conditions.map((c) => `${c.key} ${c.actualSummary} ${c.op} ${JSON.stringify(c.threshold)} ${c.result ? '\u2713' : '\u2717'}`);
                    conditionText = `It evaluated Rule ${matchedRule.ruleIndex}${label}: ${parts.join(', ')}, and chose ${branchName}.`;
                }
                else {
                    const parts = matchedRule.inputs.map((i) => `${i.key}=${i.valueSummary}`);
                    conditionText = `It examined${label}: ${parts.join(', ')}, and chose ${branchName}.`;
                }
            }
            else {
                const erroredCount = (_c = (_b = evidence.rules) === null || _b === void 0 ? void 0 : _b.filter((r) => r.matchError !== undefined).length) !== null && _c !== void 0 ? _c : 0;
                const errorNote = erroredCount > 0 ? ` (${erroredCount} rule${erroredCount > 1 ? 's' : ''} threw errors)` : '';
                conditionText = `No rules matched${errorNote}, fell back to default: ${branchName}.`;
            }
        }
        else if (ctx.description && ctx.rationale) {
            conditionText = `It ${ctx.description}: ${ctx.rationale}, so it chose ${branchName}.`;
        }
        else if (ctx.description) {
            conditionText = `It ${ctx.description} and chose ${branchName}.`;
        }
        else if (ctx.rationale) {
            conditionText = `A decision was made: ${ctx.rationale}, so the path taken was ${branchName}.`;
        }
        else {
            conditionText = `A decision was made, and the path taken was ${branchName}.`;
        }
        return `[Condition]: ${conditionText}`;
    }
    defaultRenderFork(ctx) {
        const names = ctx.children.join(', ');
        return `[Parallel]: Forking into ${ctx.children.length} parallel paths: ${names}.`;
    }
    defaultRenderSelected(ctx) {
        var _a, _b;
        if (ctx.evidence) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const evidence = ctx.evidence;
            const matched = (_b = (_a = evidence.rules) === null || _a === void 0 ? void 0 : _a.filter((r) => r.matched)) !== null && _b !== void 0 ? _b : [];
            const parts = matched.map((r) => {
                const label = r.label ? ` "${r.label}"` : '';
                if (r.type === 'filter') {
                    const conds = r.conditions
                        .map((c) => `${c.key} ${c.actualSummary} ${c.op} ${JSON.stringify(c.threshold)} ${c.result ? '\u2713' : '\u2717'}`)
                        .join(', ');
                    return `${r.branch}${label} (${conds})`;
                }
                const inputs = r.inputs.map((i) => `${i.key}=${i.valueSummary}`).join(', ');
                return `${r.branch}${label} (${inputs})`;
            });
            return `[Selected]: ${ctx.selected.length} of ${ctx.total} paths selected: ${parts.join('; ')}.`;
        }
        const names = ctx.selected.join(', ');
        return `[Selected]: ${ctx.selected.length} of ${ctx.total} paths selected for execution: ${names}.`;
    }
    defaultRenderSubflow(ctx) {
        if (ctx.direction === 'exit') {
            return `Exiting the ${ctx.name} subflow.`;
        }
        return ctx.description
            ? `Entering the ${ctx.name} subflow: ${ctx.description}.`
            : `Entering the ${ctx.name} subflow.`;
    }
    defaultRenderLoop(ctx) {
        return ctx.description
            ? `On pass ${ctx.iteration}: ${ctx.description} again.`
            : `On pass ${ctx.iteration} through ${ctx.target}.`;
    }
    defaultRenderBreak(ctx) {
        return `Execution stopped at ${ctx.stageName}.`;
    }
    defaultRenderError(ctx) {
        let text = `An error occurred at ${ctx.stageName}: ${ctx.message}.`;
        if (ctx.validationIssues) {
            text += ` Validation issues: ${ctx.validationIssues}.`;
        }
        return `[Error]: ${text}`;
    }
}
exports.CombinedNarrativeRecorder = CombinedNarrativeRecorder;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvZW5naW5lL25hcnJhdGl2ZS9Db21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7OztHQWFHOzs7QUFFSCwrRUFBeUU7QUFtRHpFLDhFQUE4RTtBQUU5RSxNQUFhLHlCQUF5QjtJQXdCcEMsWUFBWSxPQUE0RDs7UUFyQmhFLFlBQU8sR0FBNkIsRUFBRSxDQUFDO1FBQy9DOzs7Ozs7O1dBT0c7UUFDSyxlQUFVLEdBQUcsSUFBSSxHQUFHLEVBQXdCLENBQUM7UUFDckQsc0RBQXNEO1FBQzlDLGtCQUFhLEdBQUcsSUFBSSxHQUFHLEVBQWtCLENBQUM7UUFDbEQseURBQXlEO1FBQ2pELG9CQUFlLEdBQUcsSUFBSSxHQUFHLEVBQW1CLENBQUM7UUFTbkQsSUFBSSxDQUFDLEVBQUUsR0FBRyxNQUFBLE9BQU8sYUFBUCxPQUFPLHVCQUFQLE9BQU8sQ0FBRSxFQUFFLG1DQUFJLG9CQUFvQixDQUFDO1FBQzlDLElBQUksQ0FBQyxrQkFBa0IsR0FBRyxNQUFBLE9BQU8sYUFBUCxPQUFPLHVCQUFQLE9BQU8sQ0FBRSxrQkFBa0IsbUNBQUksSUFBSSxDQUFDO1FBQzlELElBQUksQ0FBQyxhQUFhLEdBQUcsTUFBQSxPQUFPLGFBQVAsT0FBTyx1QkFBUCxPQUFPLENBQUUsYUFBYSxtQ0FBSSxJQUFJLENBQUM7UUFDcEQsSUFBSSxDQUFDLGNBQWMsR0FBRyxNQUFBLE9BQU8sYUFBUCxPQUFPLHVCQUFQLE9BQU8sQ0FBRSxjQUFjLG1DQUFJLEVBQUUsQ0FBQztRQUNwRCxJQUFJLENBQUMsV0FBVyxHQUFHLE1BQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLFdBQVcsbUNBQUksa0NBQWMsQ0FBQztRQUMxRCxJQUFJLENBQUMsUUFBUSxHQUFHLE9BQU8sYUFBUCxP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QztRQUM1QyxDQUFDO1FBQ0QsT0FBTyxHQUFHLENBQUMsV0FBVztZQUNwQixDQUFDLENBQUMsZ0JBQWdCLEdBQUcsQ0FBQyxJQUFJLGFBQWEsR0FBRyxDQUFDLFdBQVcsR0FBRztZQUN6RCxDQUFDLENBQUMsZ0JBQWdCLEdBQUcsQ0FBQyxJQUFJLFdBQVcsQ0FBQztJQUMxQyxDQUFDO0lBRU8saUJBQWlCLENBQUMsR0FBc0I7UUFDOUMsT0FBTyxHQUFHLENBQUMsV0FBVztZQUNwQixDQUFDLENBQUMsV0FBVyxHQUFHLENBQUMsU0FBUyxLQUFLLEdBQUcsQ0FBQyxXQUFXLFNBQVM7WUFDdkQsQ0FBQyxDQUFDLFdBQVcsR0FBRyxDQUFDLFNBQVMsWUFBWSxHQUFHLENBQUMsTUFBTSxHQUFHLENBQUM7SUFDeEQsQ0FBQztJQUVPLGtCQUFrQixDQUFDLEdBQXVCO1FBQ2hELE9BQU8sd0JBQXdCLEdBQUcsQ0FBQyxTQUFTLEdBQUcsQ0FBQztJQUNsRCxDQUFDO0lBRU8sa0JBQWtCLENBQUMsR0FBdUI7UUFDaEQsSUFBSSxJQUFJLEdBQUcsd0JBQXdCLEdBQUcsQ0FBQyxTQUFTLEtBQUssR0FBRyxDQUFDLE9BQU8sR0FBRyxDQUFDO1FBQ3BFLElBQUksR0FBRyxDQUFDLGdCQUFnQixFQUFFLENBQUM7WUFDekIsSUFBSSxJQUFJLHVCQUF1QixHQUFHLENBQUMsZ0JBQWdCLEdBQUcsQ0FBQztRQUN6RCxDQUFDO1FBQ0QsT0FBTyxZQUFZLElBQUksRUFBRSxDQUFDO0lBQzVCLENBQUM7Q0FDRjtBQXZnQkQsOERBdWdCQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlciDigJQgSW5saW5lIG5hcnJhdGl2ZSBidWlsZGVyIHRoYXQgbWVyZ2VzIGZsb3cgKyBkYXRhIGR1cmluZyB0cmF2ZXJzYWwuXG4gKlxuICogUmVwbGFjZXMgdGhlIHBvc3QtcHJvY2Vzc2luZyBDb21iaW5lZE5hcnJhdGl2ZUJ1aWxkZXIgYnkgaW1wbGVtZW50aW5nIEJPVEhcbiAqIEZsb3dSZWNvcmRlciAoY29udHJvbC1mbG93IGV2ZW50cykgYW5kIFJlY29yZGVyIChzY29wZSBkYXRhIGV2ZW50cykuXG4gKlxuICogRXZlbnQgb3JkZXJpbmcgZ3VhcmFudGVlcyB0aGlzIHdvcmtzOlxuICogICAxLiBTY29wZSBldmVudHMgKG9uUmVhZCwgb25Xcml0ZSkgZmlyZSBEVVJJTkcgc3RhZ2UgZXhlY3V0aW9uXG4gKiAgIDIuIEZsb3cgZXZlbnRzIChvblN0YWdlRXhlY3V0ZWQsIG9uRGVjaXNpb24pIGZpcmUgQUZURVIgc3RhZ2UgZXhlY3V0aW9uXG4gKiAgIDMuIEJvdGggY2FycnkgdGhlIHNhbWUgYHN0YWdlTmFtZWAg4oCUIG5vIG1hdGNoaW5nIGFtYmlndWl0eVxuICpcbiAqIFNvIHdlIGJ1ZmZlciBzY29wZSBvcHMgcGVyLXN0YWdlLCB0aGVuIHdoZW4gdGhlIGZsb3cgZXZlbnQgYXJyaXZlcyxcbiAqIGVtaXQgdGhlIHN0YWdlIGVudHJ5ICsgZmx1c2ggdGhlIGJ1ZmZlcmVkIG9wcyBpbiBvbmUgcGFzcy5cbiAqL1xuXG5pbXBvcnQgeyBzdW1tYXJpemVWYWx1ZSB9IGZyb20gJy4uLy4uL3Njb3BlL3JlY29yZGVycy9zdW1tYXJpemVWYWx1ZS5qcyc7XG5pbXBvcnQgdHlwZSB7IFJlYWRFdmVudCwgUmVjb3JkZXIsIFdyaXRlRXZlbnQgfSBmcm9tICcuLi8uLi9zY29wZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7XG4gIEJyZWFrUmVuZGVyQ29udGV4dCxcbiAgQ29tYmluZWROYXJyYXRpdmVFbnRyeSxcbiAgRGVjaXNpb25SZW5kZXJDb250ZXh0LFxuICBFcnJvclJlbmRlckNvbnRleHQsXG4gIEZvcmtSZW5kZXJDb250ZXh0LFxuICBMb29wUmVuZGVyQ29udGV4dCxcbiAgTmFycmF0aXZlUmVuZGVyZXIsXG4gIE9wUmVuZGVyQ29udGV4dCxcbiAgU2VsZWN0ZWRSZW5kZXJDb250ZXh0LFxuICBTdGFnZVJlbmRlckNvbnRleHQsXG4gIFN1YmZsb3dSZW5kZXJDb250ZXh0LFxufSBmcm9tICcuL25hcnJhdGl2ZVR5cGVzLmpzJztcbmltcG9ydCB0eXBlIHtcbiAgRmxvd0JyZWFrRXZlbnQsXG4gIEZsb3dEZWNpc2lvbkV2ZW50LFxuICBGbG93RXJyb3JFdmVudCxcbiAgRmxvd0ZvcmtFdmVudCxcbiAgRmxvd0xvb3BFdmVudCxcbiAgRmxvd1BhdXNlRXZlbnQsXG4gIEZsb3dSZWNvcmRlcixcbiAgRmxvd1Jlc3VtZUV2ZW50LFxuICBGbG93U2VsZWN0ZWRFdmVudCxcbiAgRmxvd1N0YWdlRXZlbnQsXG4gIEZsb3dTdWJmbG93RXZlbnQsXG59IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyDilIDilIAgVHlwZXMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmludGVyZmFjZSBCdWZmZXJlZE9wIHtcbiAgdHlwZTogJ3JlYWQnIHwgJ3dyaXRlJztcbiAga2V5OiBzdHJpbmc7XG4gIHJhd1ZhbHVlOiB1bmtub3duO1xuICBvcGVyYXRpb24/OiAnc2V0JyB8ICd1cGRhdGUnIHwgJ2RlbGV0ZSc7XG4gIHN0ZXBOdW1iZXI6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBDb21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyT3B0aW9ucyB7XG4gIGluY2x1ZGVTdGVwTnVtYmVycz86IGJvb2xlYW47XG4gIGluY2x1ZGVWYWx1ZXM/OiBib29sZWFuO1xuICBtYXhWYWx1ZUxlbmd0aD86IG51bWJlcjtcbiAgLyoqIEN1c3RvbSB2YWx1ZSBmb3JtYXR0ZXIuIENhbGxlZCBhdCByZW5kZXIgdGltZSAoZmx1c2hPcHMpLCBub3QgY2FwdHVyZSB0aW1lLlxuICAgKiAgUmVjZWl2ZXMgdGhlIHJhdyB2YWx1ZSBhbmQgbWF4VmFsdWVMZW5ndGguIERlZmF1bHRzIHRvIHN1bW1hcml6ZVZhbHVlKCkuICovXG4gIGZvcm1hdFZhbHVlPzogKHZhbHVlOiB1bmtub3duLCBtYXhMZW46IG51bWJlcikgPT4gc3RyaW5nO1xuICAvKiogUGx1Z2dhYmxlIHJlbmRlcmVyIGZvciBjdXN0b21pemluZyBuYXJyYXRpdmUgb3V0cHV0LiBVbmltcGxlbWVudGVkIG1ldGhvZHNcbiAgICogIGZhbGwgYmFjayB0byB0aGUgZGVmYXVsdCBFbmdsaXNoIHJlbmRlcmVyLiBTZWUgTmFycmF0aXZlUmVuZGVyZXIgZG9jcy4gKi9cbiAgcmVuZGVyZXI/OiBOYXJyYXRpdmVSZW5kZXJlcjtcbn1cblxuLy8g4pSA4pSAIFJlY29yZGVyIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5leHBvcnQgY2xhc3MgQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlciBpbXBsZW1lbnRzIEZsb3dSZWNvcmRlciwgUmVjb3JkZXIge1xuICByZWFkb25seSBpZDogc3RyaW5nO1xuXG4gIHByaXZhdGUgZW50cmllczogQ29tYmluZWROYXJyYXRpdmVFbnRyeVtdID0gW107XG4gIC8qKlxuICAgKiBQZW5kaW5nIHNjb3BlIG9wcyBrZXllZCBieSBzdGFnZU5hbWUuIEZsdXNoZWQgaW4gb25TdGFnZUV4ZWN1dGVkL29uRGVjaXNpb24uXG4gICAqXG4gICAqIE5hbWUgY29sbGlzaW9ucyAodHdvIHN0YWdlcyB3aXRoIHRoZSBzYW1lIG5hbWUsIGRpZmZlcmVudCBJRHMpIGFyZSBwcmV2ZW50ZWQgYnlcbiAgICogdGhlIGV2ZW50IG9yZGVyaW5nIGNvbnRyYWN0OiBzY29wZSBldmVudHMgKG9uUmVhZC9vbldyaXRlKSBmb3Igc3RhZ2UgTiBhcmUgYWx3YXlzXG4gICAqIGZsdXNoZWQgYnkgb25TdGFnZUV4ZWN1dGVkIGZvciBzdGFnZSBOIGJlZm9yZSBzdGFnZSBOKzEncyBzY29wZSBldmVudHMgYmVnaW4uXG4gICAqIFNvIHRoZSBrZXkgaXMgYWx3YXlzIHVuaXF1ZWx5IGJvdW5kIHRvIHRoZSBjdXJyZW50bHktZXhlY3V0aW5nIHN0YWdlLlxuICAgKi9cbiAgcHJpdmF0ZSBwZW5kaW5nT3BzID0gbmV3IE1hcDxzdHJpbmcsIEJ1ZmZlcmVkT3BbXT4oKTtcbiAgLyoqIFBlci1zdWJmbG93IHN0YWdlIGNvdW50ZXJzLiBLZXkgJycgPSByb290IGZsb3cuICovXG4gIHByaXZhdGUgc3RhZ2VDb3VudGVycyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIC8qKiBQZXItc3ViZmxvdyBmaXJzdC1zdGFnZSBmbGFncy4gS2V5ICcnID0gcm9vdCBmbG93LiAqL1xuICBwcml2YXRlIGZpcnN0U3RhZ2VGbGFncyA9IG5ldyBNYXA8c3RyaW5nLCBib29sZWFuPigpO1xuXG4gIHByaXZhdGUgaW5jbHVkZVN0ZXBOdW1iZXJzOiBib29sZWFuO1xuICBwcml2YXRlIGluY2x1ZGVWYWx1ZXM6IGJvb2xlYW47XG4gIHByaXZhdGUgbWF4VmFsdWVMZW5ndGg6IG51bWJlcjtcbiAgcHJpdmF0ZSBmb3JtYXRWYWx1ZTogKHZhbHVlOiB1bmtub3duLCBtYXhMZW46IG51bWJlcikgPT4gc3RyaW5nO1xuICBwcml2YXRlIHJlbmRlcmVyPzogTmFycmF0aXZlUmVuZGVyZXI7XG5cbiAgY29uc3RydWN0b3Iob3B0aW9ucz86IENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXJPcHRpb25zICYgeyBpZD86IHN0cmluZyB9KSB7XG4gICAgdGhpcy5pZCA9IG9wdGlvbnM/LmlkID8/ICdjb21iaW5lZC1uYXJyYXRpdmUnO1xuICAgIHRoaXMuaW5jbHVkZVN0ZXBOdW1iZXJzID0gb3B0aW9ucz8uaW5jbHVkZVN0ZXBOdW1iZXJzID8/IHRydWU7XG4gICAgdGhpcy5pbmNsdWRlVmFsdWVzID0gb3B0aW9ucz8uaW5jbHVkZVZhbHVlcyA/PyB0cnVlO1xuICAgIHRoaXMubWF4VmFsdWVMZW5ndGggPSBvcHRpb25zPy5tYXhWYWx1ZUxlbmd0aCA/PyA4MDtcbiAgICB0aGlzLmZvcm1hdFZhbHVlID0gb3B0aW9ucz8uZm9ybWF0VmFsdWUgPz8gc3VtbWFyaXplVmFsdWU7XG4gICAgdGhpcy5yZW5kZXJlciA9IG9wdGlvbnM/LnJlbmRlcmVyO1xuICB9XG5cbiAgLy8g4pSA4pSAIFNjb3BlIGNoYW5uZWwgKGZpcmVzIGZpcnN0LCBkdXJpbmcgc3RhZ2UgZXhlY3V0aW9uKSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICBvblJlYWQoZXZlbnQ6IFJlYWRFdmVudCk6IHZvaWQge1xuICAgIGlmICghZXZlbnQua2V5KSByZXR1cm47XG4gICAgdGhpcy5idWZmZXJPcChldmVudC5zdGFnZU5hbWUsIHtcbiAgICAgIHR5cGU6ICdyZWFkJyxcbiAgICAgIGtleTogZXZlbnQua2V5LFxuICAgICAgcmF3VmFsdWU6IGV2ZW50LnZhbHVlLFxuICAgIH0pO1xuICB9XG5cbiAgb25Xcml0ZShldmVudDogV3JpdGVFdmVudCk6IHZvaWQge1xuICAgIHRoaXMuYnVmZmVyT3AoZXZlbnQuc3RhZ2VOYW1lLCB7XG4gICAgICB0eXBlOiAnd3JpdGUnLFxuICAgICAga2V5OiBldmVudC5rZXksXG4gICAgICByYXdWYWx1ZTogZXZlbnQudmFsdWUsXG4gICAgICBvcGVyYXRpb246IGV2ZW50Lm9wZXJhdGlvbixcbiAgICB9KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBGbG93IGNoYW5uZWwgKGZpcmVzIGFmdGVyIHN0YWdlIGV4ZWN1dGlvbikg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgb25TdGFnZUV4ZWN1dGVkKGV2ZW50OiBGbG93U3RhZ2VFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IHN0YWdlSWQgPSBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkO1xuICAgIGNvbnN0IHNmS2V5ID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkID8/ICcnO1xuICAgIGNvbnN0IHN0YWdlTnVtID0gdGhpcy5pbmNyZW1lbnRTdGFnZUNvdW50ZXIoc2ZLZXkpO1xuICAgIGNvbnN0IGlzRmlyc3QgPSB0aGlzLmNvbnN1bWVGaXJzdFN0YWdlRmxhZyhzZktleSk7XG5cbiAgICBjb25zdCBjdHg6IFN0YWdlUmVuZGVyQ29udGV4dCA9IHtcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgc3RhZ2VOdW1iZXI6IHN0YWdlTnVtLFxuICAgICAgaXNGaXJzdCxcbiAgICAgIGRlc2NyaXB0aW9uOiBldmVudC5kZXNjcmlwdGlvbixcbiAgICB9O1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcmVyPy5yZW5kZXJTdGFnZT8uKGN0eCkgPz8gdGhpcy5kZWZhdWx0UmVuZGVyU3RhZ2UoY3R4KTtcblxuICAgIGNvbnN0IHNmSWQgPSBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQ7XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgIHRleHQsXG4gICAgICBkZXB0aDogMCxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgc3RhZ2VJZCxcbiAgICAgIHN1YmZsb3dJZDogc2ZJZCxcbiAgICB9KTtcbiAgICB0aGlzLmZsdXNoT3BzKGV2ZW50LnN0YWdlTmFtZSwgc2ZJZCwgc3RhZ2VJZCk7XG4gIH1cblxuICBvbkRlY2lzaW9uKGV2ZW50OiBGbG93RGVjaXNpb25FdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IGRlY2lkZXJTdGFnZUlkRWFybHkgPSBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkO1xuXG4gICAgLy8gRW1pdCB0aGUgZGVjaWRlciBzdGFnZSBlbnRyeSAoZGVjaWRlcnMgZG9uJ3QgZmlyZSBvblN0YWdlRXhlY3V0ZWQpXG4gICAgY29uc3Qgc2ZLZXkgPSBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQgPz8gJyc7XG4gICAgY29uc3Qgc3RhZ2VOdW0gPSB0aGlzLmluY3JlbWVudFN0YWdlQ291bnRlcihzZktleSk7XG4gICAgY29uc3QgaXNGaXJzdCA9IHRoaXMuY29uc3VtZUZpcnN0U3RhZ2VGbGFnKHNmS2V5KTtcblxuICAgIGNvbnN0IHN0YWdlQ3R4OiBTdGFnZVJlbmRlckNvbnRleHQgPSB7XG4gICAgICBzdGFnZU5hbWU6IGV2ZW50LmRlY2lkZXIsXG4gICAgICBzdGFnZU51bWJlcjogc3RhZ2VOdW0sXG4gICAgICBpc0ZpcnN0LFxuICAgICAgZGVzY3JpcHRpb246IGV2ZW50LmRlc2NyaXB0aW9uLFxuICAgIH07XG4gICAgY29uc3Qgc3RhZ2VUZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyU3RhZ2U/LihzdGFnZUN0eCkgPz8gdGhpcy5kZWZhdWx0UmVuZGVyU3RhZ2Uoc3RhZ2VDdHgpO1xuXG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ3N0YWdlJyxcbiAgICAgIHRleHQ6IHN0YWdlVGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5kZWNpZGVyLFxuICAgICAgc3RhZ2VJZDogZGVjaWRlclN0YWdlSWRFYXJseSxcbiAgICAgIHN1YmZsb3dJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICAgIHRoaXMuZmx1c2hPcHMoZXZlbnQuZGVjaWRlciwgZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLCBkZWNpZGVyU3RhZ2VJZEVhcmx5KTtcblxuICAgIC8vIEVtaXQgdGhlIGNvbmRpdGlvbiBlbnRyeSBhcyBhIG5lc3RlZCBzdWItaXRlbSAoZGVwdGggMSkgb2YgdGhlIHN0YWdlIGFib3ZlLlxuICAgIC8vIERlY2lzaW9uIG91dGNvbWUgaXMgYSBkZXRhaWwgb2YgdGhlIGRlY2lkZXIgc3RhZ2UsIG5vdCBhIHNlcGFyYXRlIHRvcC1sZXZlbCBlbnRyeS5cbiAgICBjb25zdCBkZWNpc2lvbkN0eDogRGVjaXNpb25SZW5kZXJDb250ZXh0ID0ge1xuICAgICAgZGVjaWRlcjogZXZlbnQuZGVjaWRlcixcbiAgICAgIGNob3NlbjogZXZlbnQuY2hvc2VuLFxuICAgICAgZGVzY3JpcHRpb246IGV2ZW50LmRlc2NyaXB0aW9uLFxuICAgICAgcmF0aW9uYWxlOiBldmVudC5yYXRpb25hbGUsXG4gICAgICBldmlkZW5jZTogZXZlbnQuZXZpZGVuY2UsXG4gICAgfTtcbiAgICBjb25zdCBjb25kaXRpb25UZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyRGVjaXNpb24/LihkZWNpc2lvbkN0eCkgPz8gdGhpcy5kZWZhdWx0UmVuZGVyRGVjaXNpb24oZGVjaXNpb25DdHgpO1xuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdjb25kaXRpb24nLFxuICAgICAgdGV4dDogY29uZGl0aW9uVGV4dCxcbiAgICAgIGRlcHRoOiAxLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5kZWNpZGVyLFxuICAgICAgc3RhZ2VJZDogZGVjaWRlclN0YWdlSWRFYXJseSxcbiAgICAgIHN1YmZsb3dJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICB9XG5cbiAgb25OZXh0KCk6IHZvaWQge1xuICAgIC8vIE5vLW9wLiBvblN0YWdlRXhlY3V0ZWQgYWxyZWFkeSBoYXMgdGhlIGRlc2NyaXB0aW9uIGZvciB0aGUgbmV4dCBzdGFnZS5cbiAgICAvLyBGb3IgZGVjaWRlcnMgKG5vIG9uU3RhZ2VFeGVjdXRlZCksIG9uRGVjaXNpb24gaGFuZGxlcyB0aGUgYW5ub3VuY2VtZW50LlxuICB9XG5cbiAgb25Gb3JrKGV2ZW50OiBGbG93Rm9ya0V2ZW50KTogdm9pZCB7XG4gICAgY29uc3QgY3R4OiBGb3JrUmVuZGVyQ29udGV4dCA9IHsgY2hpbGRyZW46IGV2ZW50LmNoaWxkcmVuIH07XG4gICAgY29uc3QgdGV4dCA9IHRoaXMucmVuZGVyZXI/LnJlbmRlckZvcms/LihjdHgpID8/IHRoaXMuZGVmYXVsdFJlbmRlckZvcmsoY3R4KTtcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAnZm9yaycsXG4gICAgICB0ZXh0LFxuICAgICAgZGVwdGg6IDAsXG4gICAgICBzdGFnZUlkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkLFxuICAgICAgc3ViZmxvd0lkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQsXG4gICAgfSk7XG4gIH1cblxuICBvblNlbGVjdGVkKGV2ZW50OiBGbG93U2VsZWN0ZWRFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IGN0eDogU2VsZWN0ZWRSZW5kZXJDb250ZXh0ID0ge1xuICAgICAgc2VsZWN0ZWQ6IGV2ZW50LnNlbGVjdGVkLFxuICAgICAgdG90YWw6IGV2ZW50LnRvdGFsLFxuICAgICAgZXZpZGVuY2U6IGV2ZW50LmV2aWRlbmNlLFxuICAgIH07XG4gICAgY29uc3QgdGV4dCA9IHRoaXMucmVuZGVyZXI/LnJlbmRlclNlbGVjdGVkPy4oY3R4KSA/PyB0aGlzLmRlZmF1bHRSZW5kZXJTZWxlY3RlZChjdHgpO1xuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdzZWxlY3RvcicsXG4gICAgICB0ZXh0LFxuICAgICAgZGVwdGg6IDAsXG4gICAgICBzdGFnZUlkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkLFxuICAgICAgc3ViZmxvd0lkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQsXG4gICAgfSk7XG4gIH1cblxuICBvblN1YmZsb3dFbnRyeShldmVudDogRmxvd1N1YmZsb3dFdmVudCk6IHZvaWQge1xuICAgIC8vIFJlc2V0IHN0YWdlIGNvdW50ZXIgZm9yIHRoaXMgc3ViZmxvdyBzbyBzdGFnZXMgc3RhcnQgYXQgXCJTdGFnZSAxXCIgb24gcmUtZW50cnlcbiAgICBjb25zdCBzZktleSA9IGV2ZW50LnN1YmZsb3dJZCA/PyAnJztcbiAgICB0aGlzLnN0YWdlQ291bnRlcnMuZGVsZXRlKHNmS2V5KTtcbiAgICB0aGlzLmZpcnN0U3RhZ2VGbGFncy5kZWxldGUoc2ZLZXkpO1xuXG4gICAgY29uc3QgY3R4OiBTdWJmbG93UmVuZGVyQ29udGV4dCA9IHtcbiAgICAgIG5hbWU6IGV2ZW50Lm5hbWUsXG4gICAgICBkaXJlY3Rpb246ICdlbnRyeScsXG4gICAgICBkZXNjcmlwdGlvbjogZXZlbnQuZGVzY3JpcHRpb24sXG4gICAgfTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyU3ViZmxvdz8uKGN0eCkgPz8gdGhpcy5kZWZhdWx0UmVuZGVyU3ViZmxvdyhjdHgpO1xuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdzdWJmbG93JyxcbiAgICAgIHRleHQsXG4gICAgICBkZXB0aDogMCxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQubmFtZSxcbiAgICAgIHN0YWdlSWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN0YWdlSWQsXG4gICAgICBzdWJmbG93SWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCxcbiAgICB9KTtcbiAgfVxuXG4gIG9uU3ViZmxvd0V4aXQoZXZlbnQ6IEZsb3dTdWJmbG93RXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBjdHg6IFN1YmZsb3dSZW5kZXJDb250ZXh0ID0ge1xuICAgICAgbmFtZTogZXZlbnQubmFtZSxcbiAgICAgIGRpcmVjdGlvbjogJ2V4aXQnLFxuICAgIH07XG4gICAgY29uc3QgdGV4dCA9IHRoaXMucmVuZGVyZXI/LnJlbmRlclN1YmZsb3c/LihjdHgpID8/IHRoaXMuZGVmYXVsdFJlbmRlclN1YmZsb3coY3R4KTtcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAnc3ViZmxvdycsXG4gICAgICB0ZXh0LFxuICAgICAgZGVwdGg6IDAsXG4gICAgICBzdGFnZU5hbWU6IGV2ZW50Lm5hbWUsXG4gICAgICBzdGFnZUlkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkLFxuICAgICAgc3ViZmxvd0lkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQsXG4gICAgfSk7XG4gIH1cblxuICBvbkxvb3AoZXZlbnQ6IEZsb3dMb29wRXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBjdHg6IExvb3BSZW5kZXJDb250ZXh0ID0ge1xuICAgICAgdGFyZ2V0OiBldmVudC50YXJnZXQsXG4gICAgICBpdGVyYXRpb246IGV2ZW50Lml0ZXJhdGlvbixcbiAgICAgIGRlc2NyaXB0aW9uOiBldmVudC5kZXNjcmlwdGlvbixcbiAgICB9O1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcmVyPy5yZW5kZXJMb29wPy4oY3R4KSA/PyB0aGlzLmRlZmF1bHRSZW5kZXJMb29wKGN0eCk7XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ2xvb3AnLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3RhZ2VJZCxcbiAgICAgIHN1YmZsb3dJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICB9XG5cbiAgb25CcmVhayhldmVudDogRmxvd0JyZWFrRXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBjdHg6IEJyZWFrUmVuZGVyQ29udGV4dCA9IHsgc3RhZ2VOYW1lOiBldmVudC5zdGFnZU5hbWUgfTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyQnJlYWs/LihjdHgpID8/IHRoaXMuZGVmYXVsdFJlbmRlckJyZWFrKGN0eCk7XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ2JyZWFrJyxcbiAgICAgIHRleHQsXG4gICAgICBkZXB0aDogMCxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgc3RhZ2VJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3RhZ2VJZCxcbiAgICAgIHN1YmZsb3dJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICB9XG5cbiAgb25QYXVzZShldmVudDogRmxvd1BhdXNlRXZlbnQgfCB7IHN0YWdlTmFtZT86IHN0cmluZzsgc3RhZ2VJZD86IHN0cmluZyB9KTogdm9pZCB7XG4gICAgLy8gT25seSBoYW5kbGUgRmxvd1BhdXNlRXZlbnQgKGZyb20gRmxvd1JlY29yZGVyIGNoYW5uZWwpOyBpZ25vcmUgc2NvcGUgUGF1c2VFdmVudC5cbiAgICAvLyBGbG93UGF1c2VFdmVudCBoYXMgJ3N1YmZsb3dQYXRoJywgc2NvcGUgUGF1c2VFdmVudCBoYXMgJ3BpcGVsaW5lSWQnLlxuICAgIGlmIChPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwoZXZlbnQsICdwaXBlbGluZUlkJykpIHJldHVybjtcbiAgICBjb25zdCBmbG93RXZlbnQgPSBldmVudCBhcyBGbG93UGF1c2VFdmVudDtcbiAgICBpZiAoIWZsb3dFdmVudC5zdGFnZU5hbWUgfHwgIWZsb3dFdmVudC5zdGFnZUlkKSByZXR1cm47XG4gICAgY29uc3QgdGV4dCA9IGBFeGVjdXRpb24gcGF1c2VkIGF0ICR7Zmxvd0V2ZW50LnN0YWdlTmFtZX0uYDtcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAncGF1c2UnLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VOYW1lOiBmbG93RXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgc3RhZ2VJZDogZmxvd0V2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN0YWdlSWQgPz8gZmxvd0V2ZW50LnN0YWdlSWQsXG4gICAgICBzdWJmbG93SWQ6IGZsb3dFdmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQsXG4gICAgfSk7XG4gIH1cblxuICBvblJlc3VtZShldmVudDogRmxvd1Jlc3VtZUV2ZW50IHwgeyBzdGFnZU5hbWU/OiBzdHJpbmc7IHN0YWdlSWQ/OiBzdHJpbmcgfSk6IHZvaWQge1xuICAgIC8vIE9ubHkgaGFuZGxlIEZsb3dSZXN1bWVFdmVudCAoZnJvbSBGbG93UmVjb3JkZXIgY2hhbm5lbCk7IGlnbm9yZSBzY29wZSBSZXN1bWVFdmVudC5cbiAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGV2ZW50LCAncGlwZWxpbmVJZCcpKSByZXR1cm47XG4gICAgY29uc3QgZmxvd0V2ZW50ID0gZXZlbnQgYXMgRmxvd1Jlc3VtZUV2ZW50O1xuICAgIGlmICghZmxvd0V2ZW50LnN0YWdlTmFtZSB8fCAhZmxvd0V2ZW50LnN0YWdlSWQpIHJldHVybjtcbiAgICBjb25zdCBzdWZmaXggPSBmbG93RXZlbnQuaGFzSW5wdXQgPyAnIHdpdGggaW5wdXQuJyA6ICcuJztcbiAgICBjb25zdCB0ZXh0ID0gYEV4ZWN1dGlvbiByZXN1bWVkIGF0ICR7Zmxvd0V2ZW50LnN0YWdlTmFtZX0ke3N1ZmZpeH1gO1xuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdyZXN1bWUnLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VOYW1lOiBmbG93RXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgc3RhZ2VJZDogZmxvd0V2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN0YWdlSWQgPz8gZmxvd0V2ZW50LnN0YWdlSWQsXG4gICAgICBzdWJmbG93SWQ6IGZsb3dFdmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQsXG4gICAgfSk7XG4gIH1cblxuICAvKipcbiAgICogSGFuZGxlcyBlcnJvcnMgZnJvbSBib3RoIGNoYW5uZWxzOlxuICAgKiAtIEZsb3dSZWNvcmRlci5vbkVycm9yIChGbG93RXJyb3JFdmVudCB3aXRoIG1lc3NhZ2UgKyBzdHJ1Y3R1cmVkRXJyb3IpXG4gICAqIC0gUmVjb3JkZXIub25FcnJvciAoRXJyb3JFdmVudCBmcm9tIHNjb3BlIHN5c3RlbSDigJQgaWdub3JlZCBmb3IgbmFycmF0aXZlKVxuICAgKi9cbiAgb25FcnJvcihldmVudDogRmxvd0Vycm9yRXZlbnQgfCB7IHN0YWdlTmFtZT86IHN0cmluZzsgbWVzc2FnZT86IHN0cmluZyB9KTogdm9pZCB7XG4gICAgLy8gT25seSBoYW5kbGUgZmxvdyBlcnJvcnMgKHdoaWNoIGhhdmUgYG1lc3NhZ2VgIGFuZCBgc3RydWN0dXJlZEVycm9yYClcbiAgICBpZiAodHlwZW9mIChldmVudCBhcyBGbG93RXJyb3JFdmVudCkubWVzc2FnZSAhPT0gJ3N0cmluZycpIHJldHVybjtcbiAgICBjb25zdCBmbG93RXZlbnQgPSBldmVudCBhcyBGbG93RXJyb3JFdmVudDtcblxuICAgIGxldCB2YWxpZGF0aW9uSXNzdWVzOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgaWYgKGZsb3dFdmVudC5zdHJ1Y3R1cmVkRXJyb3I/Lmlzc3Vlcz8ubGVuZ3RoKSB7XG4gICAgICB2YWxpZGF0aW9uSXNzdWVzID0gZmxvd0V2ZW50LnN0cnVjdHVyZWRFcnJvci5pc3N1ZXNcbiAgICAgICAgLm1hcCgoaXNzdWUpID0+IHtcbiAgICAgICAgICBjb25zdCBwYXRoID0gaXNzdWUucGF0aC5sZW5ndGggPiAwID8gaXNzdWUucGF0aC5qb2luKCcuJykgOiAnKHJvb3QpJztcbiAgICAgICAgICByZXR1cm4gYCR7cGF0aH06ICR7aXNzdWUubWVzc2FnZX1gO1xuICAgICAgICB9KVxuICAgICAgICAuam9pbignOyAnKTtcbiAgICB9XG5cbiAgICBjb25zdCBjdHg6IEVycm9yUmVuZGVyQ29udGV4dCA9IHtcbiAgICAgIHN0YWdlTmFtZTogZmxvd0V2ZW50LnN0YWdlTmFtZSxcbiAgICAgIG1lc3NhZ2U6IGZsb3dFdmVudC5tZXNzYWdlLFxuICAgICAgdmFsaWRhdGlvbklzc3VlcyxcbiAgICB9O1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcmVyPy5yZW5kZXJFcnJvcj8uKGN0eCkgPz8gdGhpcy5kZWZhdWx0UmVuZGVyRXJyb3IoY3R4KTtcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAnZXJyb3InLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VOYW1lOiBmbG93RXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgc3RhZ2VJZDogZmxvd0V2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN0YWdlSWQsXG4gICAgICBzdWJmbG93SWQ6IGZsb3dFdmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQsXG4gICAgfSk7XG4gIH1cblxuICAvLyDilIDilIAgT3V0cHV0IOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIC8qKiBSZXR1cm5zIHN0cnVjdHVyZWQgZW50cmllcyBmb3IgcHJvZ3JhbW1hdGljIGNvbnN1bXB0aW9uLiAqL1xuICBnZXRFbnRyaWVzKCk6IENvbWJpbmVkTmFycmF0aXZlRW50cnlbXSB7XG4gICAgcmV0dXJuIFsuLi50aGlzLmVudHJpZXNdO1xuICB9XG5cbiAgLyoqIFJldHVybnMgZm9ybWF0dGVkIG5hcnJhdGl2ZSBsaW5lcyAoc2FtZSBvdXRwdXQgYXMgQ29tYmluZWROYXJyYXRpdmVCdWlsZGVyLmJ1aWxkKS4gKi9cbiAgZ2V0TmFycmF0aXZlKGluZGVudCA9ICcgICcpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIHRoaXMuZW50cmllcy5tYXAoKGVudHJ5KSA9PiBgJHtpbmRlbnQucmVwZWF0KGVudHJ5LmRlcHRoKX0ke2VudHJ5LnRleHR9YCk7XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyBlbnRyaWVzIGdyb3VwZWQgYnkgc3ViZmxvd0lkIGZvciBzdHJ1Y3R1cmVkIGFjY2Vzcy5cbiAgICogUm9vdC1sZXZlbCBlbnRyaWVzIGhhdmUgc3ViZmxvd0lkID0gdW5kZWZpbmVkLlxuICAgKi9cbiAgZ2V0RW50cmllc0J5U3ViZmxvdygpOiBSZWNvcmQ8c3RyaW5nLCBDb21iaW5lZE5hcnJhdGl2ZUVudHJ5W10+IHtcbiAgICBjb25zdCByZXN1bHQ6IFJlY29yZDxzdHJpbmcsIENvbWJpbmVkTmFycmF0aXZlRW50cnlbXT4gPSB7ICcnOiBbXSB9O1xuICAgIGZvciAoY29uc3QgZW50cnkgb2YgdGhpcy5lbnRyaWVzKSB7XG4gICAgICBjb25zdCBrZXkgPSBlbnRyeS5zdWJmbG93SWQgPz8gJyc7XG4gICAgICBpZiAoIXJlc3VsdFtrZXldKSByZXN1bHRba2V5XSA9IFtdO1xuICAgICAgcmVzdWx0W2tleV0ucHVzaChlbnRyeSk7XG4gICAgfVxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvKiogQ2xlYXJzIGFsbCBzdGF0ZS4gQ2FsbGVkIGF1dG9tYXRpY2FsbHkgYmVmb3JlIGVhY2ggcnVuLiAqL1xuICBjbGVhcigpOiB2b2lkIHtcbiAgICB0aGlzLmVudHJpZXMgPSBbXTtcbiAgICB0aGlzLnBlbmRpbmdPcHMuY2xlYXIoKTtcbiAgICB0aGlzLnN0YWdlQ291bnRlcnMuY2xlYXIoKTtcbiAgICB0aGlzLmZpcnN0U3RhZ2VGbGFncy5jbGVhcigpO1xuICB9XG5cbiAgLy8g4pSA4pSAIFByaXZhdGUgaGVscGVycyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogSW5jcmVtZW50IGFuZCByZXR1cm4gdGhlIHN0YWdlIGNvdW50ZXIgZm9yIGEgZ2l2ZW4gc3ViZmxvdyAoJycgPSByb290KS4gKi9cbiAgcHJpdmF0ZSBpbmNyZW1lbnRTdGFnZUNvdW50ZXIoc3ViZmxvd0tleTogc3RyaW5nKTogbnVtYmVyIHtcbiAgICBjb25zdCBjdXJyZW50ID0gdGhpcy5zdGFnZUNvdW50ZXJzLmdldChzdWJmbG93S2V5KSA/PyAwO1xuICAgIGNvbnN0IG5leHQgPSBjdXJyZW50ICsgMTtcbiAgICB0aGlzLnN0YWdlQ291bnRlcnMuc2V0KHN1YmZsb3dLZXksIG5leHQpO1xuICAgIHJldHVybiBuZXh0O1xuICB9XG5cbiAgLyoqIFJldHVybnMgdHJ1ZSBpZiB0aGlzIGlzIHRoZSBmaXJzdCBzdGFnZSBmb3IgdGhlIGdpdmVuIHN1YmZsb3csIGNvbnN1bWluZyB0aGUgZmxhZy4gKi9cbiAgcHJpdmF0ZSBjb25zdW1lRmlyc3RTdGFnZUZsYWcoc3ViZmxvd0tleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgaWYgKCF0aGlzLmZpcnN0U3RhZ2VGbGFncy5oYXMoc3ViZmxvd0tleSkpIHtcbiAgICAgIHRoaXMuZmlyc3RTdGFnZUZsYWdzLnNldChzdWJmbG93S2V5LCBmYWxzZSk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgcHJpdmF0ZSBidWZmZXJPcChzdGFnZU5hbWU6IHN0cmluZywgb3A6IE9taXQ8QnVmZmVyZWRPcCwgJ3N0ZXBOdW1iZXInPik6IHZvaWQge1xuICAgIGxldCBvcHMgPSB0aGlzLnBlbmRpbmdPcHMuZ2V0KHN0YWdlTmFtZSk7XG4gICAgaWYgKCFvcHMpIHtcbiAgICAgIG9wcyA9IFtdO1xuICAgICAgdGhpcy5wZW5kaW5nT3BzLnNldChzdGFnZU5hbWUsIG9wcyk7XG4gICAgfVxuICAgIG9wcy5wdXNoKHsgLi4ub3AsIHN0ZXBOdW1iZXI6IG9wcy5sZW5ndGggKyAxIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBmbHVzaE9wcyhzdGFnZU5hbWU6IHN0cmluZywgc3ViZmxvd0lkPzogc3RyaW5nLCBzdGFnZUlkPzogc3RyaW5nKTogdm9pZCB7XG4gICAgY29uc3Qgb3BzID0gdGhpcy5wZW5kaW5nT3BzLmdldChzdGFnZU5hbWUpO1xuICAgIGlmICghb3BzIHx8IG9wcy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICAgIGZvciAoY29uc3Qgb3Agb2Ygb3BzKSB7XG4gICAgICBjb25zdCB2YWx1ZVN1bW1hcnkgPSB0aGlzLmZvcm1hdFZhbHVlKG9wLnJhd1ZhbHVlLCB0aGlzLm1heFZhbHVlTGVuZ3RoKTtcbiAgICAgIGNvbnN0IG9wQ3R4OiBPcFJlbmRlckNvbnRleHQgPSB7XG4gICAgICAgIHR5cGU6IG9wLnR5cGUsXG4gICAgICAgIGtleTogb3Aua2V5LFxuICAgICAgICByYXdWYWx1ZTogb3AucmF3VmFsdWUsXG4gICAgICAgIHZhbHVlU3VtbWFyeSxcbiAgICAgICAgb3BlcmF0aW9uOiBvcC5vcGVyYXRpb24sXG4gICAgICAgIHN0ZXBOdW1iZXI6IG9wLnN0ZXBOdW1iZXIsXG4gICAgICB9O1xuXG4gICAgICBjb25zdCB0ZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyT3AgPyB0aGlzLnJlbmRlcmVyLnJlbmRlck9wKG9wQ3R4KSA6IHRoaXMuZGVmYXVsdFJlbmRlck9wKG9wQ3R4KTtcblxuICAgICAgaWYgKHRleHQgPT0gbnVsbCkgY29udGludWU7IC8vIHJlbmRlcmVyIGV4Y2x1ZGVkIHRoaXMgb3AgKG51bGwgb3IgdW5kZWZpbmVkKVxuXG4gICAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICAgIHR5cGU6ICdzdGVwJyxcbiAgICAgICAgdGV4dCxcbiAgICAgICAgZGVwdGg6IDEsXG4gICAgICAgIHN0YWdlTmFtZSxcbiAgICAgICAgc3RhZ2VJZCxcbiAgICAgICAgc3RlcE51bWJlcjogb3Auc3RlcE51bWJlcixcbiAgICAgICAgc3ViZmxvd0lkLFxuICAgICAgICBrZXk6IG9wLmtleSxcbiAgICAgICAgcmF3VmFsdWU6IG9wLnJhd1ZhbHVlLFxuICAgICAgfSk7XG4gICAgfVxuXG4gICAgdGhpcy5wZW5kaW5nT3BzLmRlbGV0ZShzdGFnZU5hbWUpO1xuICB9XG5cbiAgLy8g4pSA4pSAIERlZmF1bHQgcmVuZGVyZXJzICh1c2VkIHdoZW4gbm8gY3VzdG9tIHJlbmRlcmVyIGlzIHByb3ZpZGVkKSDilIDilIDilIDilIBcblxuICBwcml2YXRlIGRlZmF1bHRSZW5kZXJTdGFnZShjdHg6IFN0YWdlUmVuZGVyQ29udGV4dCk6IHN0cmluZyB7XG4gICAgY29uc3QgaW5uZXIgPSBjdHguaXNGaXJzdFxuICAgICAgPyBjdHguZGVzY3JpcHRpb25cbiAgICAgICAgPyBgVGhlIHByb2Nlc3MgYmVnYW46ICR7Y3R4LmRlc2NyaXB0aW9ufS5gXG4gICAgICAgIDogYFRoZSBwcm9jZXNzIGJlZ2FuIHdpdGggJHtjdHguc3RhZ2VOYW1lfS5gXG4gICAgICA6IGN0eC5kZXNjcmlwdGlvblxuICAgICAgPyBgTmV4dCBzdGVwOiAke2N0eC5kZXNjcmlwdGlvbn0uYFxuICAgICAgOiBgTmV4dCwgaXQgbW92ZWQgb24gdG8gJHtjdHguc3RhZ2VOYW1lfS5gO1xuICAgIHJldHVybiBgU3RhZ2UgJHtjdHguc3RhZ2VOdW1iZXJ9OiAke2lubmVyfWA7XG4gIH1cblxuICBwcml2YXRlIGRlZmF1bHRSZW5kZXJPcChjdHg6IE9wUmVuZGVyQ29udGV4dCk6IHN0cmluZyB7XG4gICAgY29uc3Qgc3RlcFByZWZpeCA9IHRoaXMuaW5jbHVkZVN0ZXBOdW1iZXJzID8gYFN0ZXAgJHtjdHguc3RlcE51bWJlcn06IGAgOiAnJztcbiAgICBpZiAoY3R4LnR5cGUgPT09ICdyZWFkJykge1xuICAgICAgcmV0dXJuIHRoaXMuaW5jbHVkZVZhbHVlcyAmJiBjdHgudmFsdWVTdW1tYXJ5XG4gICAgICAgID8gYCR7c3RlcFByZWZpeH1SZWFkICR7Y3R4LmtleX0gPSAke2N0eC52YWx1ZVN1bW1hcnl9YFxuICAgICAgICA6IGAke3N0ZXBQcmVmaXh9UmVhZCAke2N0eC5rZXl9YDtcbiAgICB9XG4gICAgaWYgKGN0eC5vcGVyYXRpb24gPT09ICdkZWxldGUnKSB7XG4gICAgICByZXR1cm4gYCR7c3RlcFByZWZpeH1EZWxldGUgJHtjdHgua2V5fWA7XG4gICAgfVxuICAgIGlmIChjdHgub3BlcmF0aW9uID09PSAndXBkYXRlJykge1xuICAgICAgcmV0dXJuIHRoaXMuaW5jbHVkZVZhbHVlc1xuICAgICAgICA/IGAke3N0ZXBQcmVmaXh9VXBkYXRlICR7Y3R4LmtleX0gPSAke2N0eC52YWx1ZVN1bW1hcnl9YFxuICAgICAgICA6IGAke3N0ZXBQcmVmaXh9VXBkYXRlICR7Y3R4LmtleX1gO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5pbmNsdWRlVmFsdWVzID8gYCR7c3RlcFByZWZpeH1Xcml0ZSAke2N0eC5rZXl9ID0gJHtjdHgudmFsdWVTdW1tYXJ5fWAgOiBgJHtzdGVwUHJlZml4fVdyaXRlICR7Y3R4LmtleX1gO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyRGVjaXNpb24oY3R4OiBEZWNpc2lvblJlbmRlckNvbnRleHQpOiBzdHJpbmcge1xuICAgIGNvbnN0IGJyYW5jaE5hbWUgPSBjdHguY2hvc2VuO1xuICAgIGxldCBjb25kaXRpb25UZXh0OiBzdHJpbmc7XG4gICAgaWYgKGN0eC5ldmlkZW5jZSkge1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnlcbiAgICAgIGNvbnN0IGV2aWRlbmNlID0gY3R4LmV2aWRlbmNlIGFzIGFueTtcbiAgICAgIGNvbnN0IG1hdGNoZWRSdWxlID0gZXZpZGVuY2UucnVsZXM/LmZpbmQoKHI6IGFueSkgPT4gci5tYXRjaGVkKTtcbiAgICAgIGlmIChtYXRjaGVkUnVsZSkge1xuICAgICAgICBjb25zdCBsYWJlbCA9IG1hdGNoZWRSdWxlLmxhYmVsID8gYCBcIiR7bWF0Y2hlZFJ1bGUubGFiZWx9XCJgIDogJyc7XG4gICAgICAgIGlmIChtYXRjaGVkUnVsZS50eXBlID09PSAnZmlsdGVyJykge1xuICAgICAgICAgIGNvbnN0IHBhcnRzID0gbWF0Y2hlZFJ1bGUuY29uZGl0aW9ucy5tYXAoXG4gICAgICAgICAgICAoYzogYW55KSA9PlxuICAgICAgICAgICAgICBgJHtjLmtleX0gJHtjLmFjdHVhbFN1bW1hcnl9ICR7Yy5vcH0gJHtKU09OLnN0cmluZ2lmeShjLnRocmVzaG9sZCl9ICR7Yy5yZXN1bHQgPyAnXFx1MjcxMycgOiAnXFx1MjcxNyd9YCxcbiAgICAgICAgICApO1xuICAgICAgICAgIGNvbmRpdGlvblRleHQgPSBgSXQgZXZhbHVhdGVkIFJ1bGUgJHttYXRjaGVkUnVsZS5ydWxlSW5kZXh9JHtsYWJlbH06ICR7cGFydHMuam9pbihcbiAgICAgICAgICAgICcsICcsXG4gICAgICAgICAgKX0sIGFuZCBjaG9zZSAke2JyYW5jaE5hbWV9LmA7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgY29uc3QgcGFydHMgPSBtYXRjaGVkUnVsZS5pbnB1dHMubWFwKChpOiBhbnkpID0+IGAke2kua2V5fT0ke2kudmFsdWVTdW1tYXJ5fWApO1xuICAgICAgICAgIGNvbmRpdGlvblRleHQgPSBgSXQgZXhhbWluZWQke2xhYmVsfTogJHtwYXJ0cy5qb2luKCcsICcpfSwgYW5kIGNob3NlICR7YnJhbmNoTmFtZX0uYDtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgZXJyb3JlZENvdW50ID0gZXZpZGVuY2UucnVsZXM/LmZpbHRlcigocjogYW55KSA9PiByLm1hdGNoRXJyb3IgIT09IHVuZGVmaW5lZCkubGVuZ3RoID8/IDA7XG4gICAgICAgIGNvbnN0IGVycm9yTm90ZSA9IGVycm9yZWRDb3VudCA+IDAgPyBgICgke2Vycm9yZWRDb3VudH0gcnVsZSR7ZXJyb3JlZENvdW50ID4gMSA/ICdzJyA6ICcnfSB0aHJldyBlcnJvcnMpYCA6ICcnO1xuICAgICAgICBjb25kaXRpb25UZXh0ID0gYE5vIHJ1bGVzIG1hdGNoZWQke2Vycm9yTm90ZX0sIGZlbGwgYmFjayB0byBkZWZhdWx0OiAke2JyYW5jaE5hbWV9LmA7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChjdHguZGVzY3JpcHRpb24gJiYgY3R4LnJhdGlvbmFsZSkge1xuICAgICAgY29uZGl0aW9uVGV4dCA9IGBJdCAke2N0eC5kZXNjcmlwdGlvbn06ICR7Y3R4LnJhdGlvbmFsZX0sIHNvIGl0IGNob3NlICR7YnJhbmNoTmFtZX0uYDtcbiAgICB9IGVsc2UgaWYgKGN0eC5kZXNjcmlwdGlvbikge1xuICAgICAgY29uZGl0aW9uVGV4dCA9IGBJdCAke2N0eC5kZXNjcmlwdGlvbn0gYW5kIGNob3NlICR7YnJhbmNoTmFtZX0uYDtcbiAgICB9IGVsc2UgaWYgKGN0eC5yYXRpb25hbGUpIHtcbiAgICAgIGNvbmRpdGlvblRleHQgPSBgQSBkZWNpc2lvbiB3YXMgbWFkZTogJHtjdHgucmF0aW9uYWxlfSwgc28gdGhlIHBhdGggdGFrZW4gd2FzICR7YnJhbmNoTmFtZX0uYDtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uZGl0aW9uVGV4dCA9IGBBIGRlY2lzaW9uIHdhcyBtYWRlLCBhbmQgdGhlIHBhdGggdGFrZW4gd2FzICR7YnJhbmNoTmFtZX0uYDtcbiAgICB9XG4gICAgcmV0dXJuIGBbQ29uZGl0aW9uXTogJHtjb25kaXRpb25UZXh0fWA7XG4gIH1cblxuICBwcml2YXRlIGRlZmF1bHRSZW5kZXJGb3JrKGN0eDogRm9ya1JlbmRlckNvbnRleHQpOiBzdHJpbmcge1xuICAgIGNvbnN0IG5hbWVzID0gY3R4LmNoaWxkcmVuLmpvaW4oJywgJyk7XG4gICAgcmV0dXJuIGBbUGFyYWxsZWxdOiBGb3JraW5nIGludG8gJHtjdHguY2hpbGRyZW4ubGVuZ3RofSBwYXJhbGxlbCBwYXRoczogJHtuYW1lc30uYDtcbiAgfVxuXG4gIHByaXZhdGUgZGVmYXVsdFJlbmRlclNlbGVjdGVkKGN0eDogU2VsZWN0ZWRSZW5kZXJDb250ZXh0KTogc3RyaW5nIHtcbiAgICBpZiAoY3R4LmV2aWRlbmNlKSB7XG4gICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWV4cGxpY2l0LWFueVxuICAgICAgY29uc3QgZXZpZGVuY2UgPSBjdHguZXZpZGVuY2UgYXMgYW55O1xuICAgICAgY29uc3QgbWF0Y2hlZCA9IGV2aWRlbmNlLnJ1bGVzPy5maWx0ZXIoKHI6IGFueSkgPT4gci5tYXRjaGVkKSA/PyBbXTtcbiAgICAgIGNvbnN0IHBhcnRzID0gbWF0Y2hlZC5tYXAoKHI6IGFueSkgPT4ge1xuICAgICAgICBjb25zdCBsYWJlbCA9IHIubGFiZWwgPyBgIFwiJHtyLmxhYmVsfVwiYCA6ICcnO1xuICAgICAgICBpZiAoci50eXBlID09PSAnZmlsdGVyJykge1xuICAgICAgICAgIGNvbnN0IGNvbmRzID0gci5jb25kaXRpb25zXG4gICAgICAgICAgICAubWFwKFxuICAgICAgICAgICAgICAoYzogYW55KSA9PlxuICAgICAgICAgICAgICAgIGAke2Mua2V5fSAke2MuYWN0dWFsU3VtbWFyeX0gJHtjLm9wfSAke0pTT04uc3RyaW5naWZ5KGMudGhyZXNob2xkKX0gJHtjLnJlc3VsdCA/ICdcXHUyNzEzJyA6ICdcXHUyNzE3J31gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgLmpvaW4oJywgJyk7XG4gICAgICAgICAgcmV0dXJuIGAke3IuYnJhbmNofSR7bGFiZWx9ICgke2NvbmRzfSlgO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGlucHV0cyA9IHIuaW5wdXRzLm1hcCgoaTogYW55KSA9PiBgJHtpLmtleX09JHtpLnZhbHVlU3VtbWFyeX1gKS5qb2luKCcsICcpO1xuICAgICAgICByZXR1cm4gYCR7ci5icmFuY2h9JHtsYWJlbH0gKCR7aW5wdXRzfSlgO1xuICAgICAgfSk7XG4gICAgICByZXR1cm4gYFtTZWxlY3RlZF06ICR7Y3R4LnNlbGVjdGVkLmxlbmd0aH0gb2YgJHtjdHgudG90YWx9IHBhdGhzIHNlbGVjdGVkOiAke3BhcnRzLmpvaW4oJzsgJyl9LmA7XG4gICAgfVxuICAgIGNvbnN0IG5hbWVzID0gY3R4LnNlbGVjdGVkLmpvaW4oJywgJyk7XG4gICAgcmV0dXJuIGBbU2VsZWN0ZWRdOiAke2N0eC5zZWxlY3RlZC5sZW5ndGh9IG9mICR7Y3R4LnRvdGFsfSBwYXRocyBzZWxlY3RlZCBmb3IgZXhlY3V0aW9uOiAke25hbWVzfS5gO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyU3ViZmxvdyhjdHg6IFN1YmZsb3dSZW5kZXJDb250ZXh0KTogc3RyaW5nIHtcbiAgICBpZiAoY3R4LmRpcmVjdGlvbiA9PT0gJ2V4aXQnKSB7XG4gICAgICByZXR1cm4gYEV4aXRpbmcgdGhlICR7Y3R4Lm5hbWV9IHN1YmZsb3cuYDtcbiAgICB9XG4gICAgcmV0dXJuIGN0eC5kZXNjcmlwdGlvblxuICAgICAgPyBgRW50ZXJpbmcgdGhlICR7Y3R4Lm5hbWV9IHN1YmZsb3c6ICR7Y3R4LmRlc2NyaXB0aW9ufS5gXG4gICAgICA6IGBFbnRlcmluZyB0aGUgJHtjdHgubmFtZX0gc3ViZmxvdy5gO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyTG9vcChjdHg6IExvb3BSZW5kZXJDb250ZXh0KTogc3RyaW5nIHtcbiAgICByZXR1cm4gY3R4LmRlc2NyaXB0aW9uXG4gICAgICA/IGBPbiBwYXNzICR7Y3R4Lml0ZXJhdGlvbn06ICR7Y3R4LmRlc2NyaXB0aW9ufSBhZ2Fpbi5gXG4gICAgICA6IGBPbiBwYXNzICR7Y3R4Lml0ZXJhdGlvbn0gdGhyb3VnaCAke2N0eC50YXJnZXR9LmA7XG4gIH1cblxuICBwcml2YXRlIGRlZmF1bHRSZW5kZXJCcmVhayhjdHg6IEJyZWFrUmVuZGVyQ29udGV4dCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGBFeGVjdXRpb24gc3RvcHBlZCBhdCAke2N0eC5zdGFnZU5hbWV9LmA7XG4gIH1cblxuICBwcml2YXRlIGRlZmF1bHRSZW5kZXJFcnJvcihjdHg6IEVycm9yUmVuZGVyQ29udGV4dCk6IHN0cmluZyB7XG4gICAgbGV0IHRleHQgPSBgQW4gZXJyb3Igb2NjdXJyZWQgYXQgJHtjdHguc3RhZ2VOYW1lfTogJHtjdHgubWVzc2FnZX0uYDtcbiAgICBpZiAoY3R4LnZhbGlkYXRpb25Jc3N1ZXMpIHtcbiAgICAgIHRleHQgKz0gYCBWYWxpZGF0aW9uIGlzc3VlczogJHtjdHgudmFsaWRhdGlvbklzc3Vlc30uYDtcbiAgICB9XG4gICAgcmV0dXJuIGBbRXJyb3JdOiAke3RleHR9YDtcbiAgfVxufVxuIl19