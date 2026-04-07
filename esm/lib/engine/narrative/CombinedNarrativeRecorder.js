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
import { summarizeValue } from '../../scope/recorders/summarizeValue.js';
// ── Recorder ───────────────────────────────────────────────────────────────
export class CombinedNarrativeRecorder {
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
        this.formatValue = (_e = options === null || options === void 0 ? void 0 : options.formatValue) !== null && _e !== void 0 ? _e : summarizeValue;
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvZW5naW5lL25hcnJhdGl2ZS9Db21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7O0dBYUc7QUFFSCxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0seUNBQXlDLENBQUM7QUFtRHpFLDhFQUE4RTtBQUU5RSxNQUFNLE9BQU8seUJBQXlCO0lBd0JwQyxZQUFZLE9BQTREOztRQXJCaEUsWUFBTyxHQUE2QixFQUFFLENBQUM7UUFDL0M7Ozs7Ozs7V0FPRztRQUNLLGVBQVUsR0FBRyxJQUFJLEdBQUcsRUFBd0IsQ0FBQztRQUNyRCxzREFBc0Q7UUFDOUMsa0JBQWEsR0FBRyxJQUFJLEdBQUcsRUFBa0IsQ0FBQztRQUNsRCx5REFBeUQ7UUFDakQsb0JBQWUsR0FBRyxJQUFJLEdBQUcsRUFBbUIsQ0FBQztRQVNuRCxJQUFJLENBQUMsRUFBRSxHQUFHLE1BQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLEVBQUUsbUNBQUksb0JBQW9CLENBQUM7UUFDOUMsSUFBSSxDQUFDLGtCQUFrQixHQUFHLE1BQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLGtCQUFrQixtQ0FBSSxJQUFJLENBQUM7UUFDOUQsSUFBSSxDQUFDLGFBQWEsR0FBRyxNQUFBLE9BQU8sYUFBUCxPQUFPLHVCQUFQLE9BQU8sQ0FBRSxhQUFhLG1DQUFJLElBQUksQ0FBQztRQUNwRCxJQUFJLENBQUMsY0FBYyxHQUFHLE1BQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLGNBQWMsbUNBQUksRUFBRSxDQUFDO1FBQ3BELElBQUksQ0FBQyxXQUFXLEdBQUcsTUFBQSxPQUFPLGFBQVAsT0FBTyx1QkFBUCxPQUFPLENBQUUsV0FBVyxtQ0FBSSxjQUFjLENBQUM7UUFDMUQsSUFBSSxDQUFDLFFBQVEsR0FBRyxPQUFPLGFBQVAsT0FBTyx1QkFBUCxPQUFPLENBQUUsUUFBUSxDQUFDO0lBQ3BDLENBQUM7SUFFRCx5RUFBeUU7SUFFekUsTUFBTSxDQUFDLEtBQWdCO1FBQ3JCLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRztZQUFFLE9BQU87UUFDdkIsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsU0FBUyxFQUFFO1lBQzdCLElBQUksRUFBRSxNQUFNO1lBQ1osR0FBRyxFQUFFLEtBQUssQ0FBQyxHQUFHO1lBQ2QsUUFBUSxFQUFFLEtBQUssQ0FBQyxLQUFLO1NBQ3RCLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRCxPQUFPLENBQUMsS0FBaUI7UUFDdkIsSUFBSSxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsU0FBUyxFQUFFO1lBQzdCLElBQUksRUFBRSxPQUFPO1lBQ2IsR0FBRyxFQUFFLEtBQUssQ0FBQyxHQUFHO1lBQ2QsUUFBUSxFQUFFLEtBQUssQ0FBQyxLQUFLO1lBQ3JCLFNBQVMsRUFBRSxLQUFLLENBQUMsU0FBUztTQUMzQixDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQseUVBQXlFO0lBRXpFLGVBQWUsQ0FBQyxLQUFxQjs7UUFDbkMsTUFBTSxPQUFPLEdBQUcsTUFBQSxLQUFLLENBQUMsZ0JBQWdCLDBDQUFFLE9BQU8sQ0FBQztRQUNoRCxNQUFNLEtBQUssR0FBRyxNQUFBLE1BQUEsS0FBSyxDQUFDLGdCQUFnQiwwQ0FBRSxTQUFTLG1DQUFJLEVBQUUsQ0FBQztRQUN0RCxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMscUJBQXFCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDbkQsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLHFCQUFxQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRWxELE1BQU0sR0FBRyxHQUF1QjtZQUM5QixTQUFTLEVBQUUsS0FBSyxDQUFDLFNBQVM7WUFDMUIsV0FBVyxFQUFFLFFBQVE7WUFDckIsT0FBTztZQUNQLFdBQVcsRUFBRSxLQUFLLENBQUMsV0FBVztTQUMvQixDQUFDO1FBQ0YsTUFBTSxJQUFJLEdBQUcsTUFBQSxNQUFBLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsV0FBVyxtREFBRyxHQUFHLENBQUMsbUNBQUksSUFBSSxDQUFDLGtCQUFrQixDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBRS9FLE1BQU0sSUFBSSxHQUFHLE1BQUEsS0FBSyxDQUFDLGdCQUFnQiwwQ0FBRSxTQUFTLENBQUM7UUFDL0MsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7WUFDaEIsSUFBSSxFQUFFLE9BQU87WUFDYixJQUFJO1lBQ0osS0FBSyxFQUFFLENBQUM7WUFDUixTQUFTLEVBQUUsS0FBSyxDQUFDLFNBQVM7WUFDMUIsT0FBTztZQUNQLFNBQVMsRUFBRSxJQUFJO1NBQ2hCLENBQUMsQ0FBQztRQUNILElBQUksQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLFNBQVMsRUFBRSxJQUFJLEVBQUUsT0FBTyxDQUFDLENBQUM7SUFDaEQsQ0FBQztJQUVELFVBQVUsQ0FBQyxLQUF3Qjs7UUFDakMsTUFBTSxtQkFBbUIsR0FBRyxNQUFBLEtBQUssQ0FBQyxnQkFBZ0IsMENBQUUsT0FBTyxDQUFDO1FBRTVELHFFQUFxRTtRQUNyRSxNQUFNLEtBQUssR0FBRyxNQUFBLE1BQUEsS0FBSyxDQUFDLGdCQUFnQiwwQ0FBRSxTQUFTLG1DQUFJLEVBQUUsQ0FBQztRQUN0RCxNQUFNLFFBQVEsR0FBRyxJQUFJLENBQUMscUJBQXFCLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDbkQsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLHFCQUFxQixDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRWxELE1BQU0sUUFBUSxHQUF1QjtZQUNuQyxTQUFTLEVBQUUsS0FBSyxDQUFDLE9BQU87WUFDeEIsV0FBVyxFQUFFLFFBQVE7WUFDckIsT0FBTztZQUNQLFdBQVcsRUFBRSxLQUFLLENBQUMsV0FBVztTQUMvQixDQUFDO1FBQ0YsTUFBTSxTQUFTLEdBQUcsTUFBQSxNQUFBLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsV0FBVyxtREFBRyxRQUFRLENBQUMsbUNBQUksSUFBSSxDQUFDLGtCQUFrQixDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBRTlGLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO1lBQ2hCLElBQUksRUFBRSxPQUFPO1lBQ2IsSUFBSSxFQUFFLFNBQVM7WUFDZixLQUFLLEVBQUUsQ0FBQztZQUNSLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTztZQUN4QixPQUFPLEVBQUUsbUJBQW1CO1lBQzVCLFNBQVMsRUFBRSxNQUFBLEtBQUssQ0FBQyxnQkFBZ0IsMENBQUUsU0FBUztTQUM3QyxDQUFDLENBQUM7UUFDSCxJQUFJLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxPQUFPLEVBQUUsTUFBQSxLQUFLLENBQUMsZ0JBQWdCLDBDQUFFLFNBQVMsRUFBRSxtQkFBbUIsQ0FBQyxDQUFDO1FBRXJGLDhFQUE4RTtRQUM5RSxxRkFBcUY7UUFDckYsTUFBTSxXQUFXLEdBQTBCO1lBQ3pDLE9BQU8sRUFBRSxLQUFLLENBQUMsT0FBTztZQUN0QixNQUFNLEVBQUUsS0FBSyxDQUFDLE1BQU07WUFDcEIsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO1lBQzlCLFNBQVMsRUFBRSxLQUFLLENBQUMsU0FBUztZQUMxQixRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVE7U0FDekIsQ0FBQztRQUNGLE1BQU0sYUFBYSxHQUFHLE1BQUEsTUFBQSxNQUFBLElBQUksQ0FBQyxRQUFRLDBDQUFFLGNBQWMsbURBQUcsV0FBVyxDQUFDLG1DQUFJLElBQUksQ0FBQyxxQkFBcUIsQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUM5RyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQztZQUNoQixJQUFJLEVBQUUsV0FBVztZQUNqQixJQUFJLEVBQUUsYUFBYTtZQUNuQixLQUFLLEVBQUUsQ0FBQztZQUNSLFNBQVMsRUFBRSxLQUFLLENBQUMsT0FBTztZQUN4QixPQUFPLEVBQUUsbUJBQW1CO1lBQzVCLFNBQVMsRUFBRSxNQUFBLEtBQUssQ0FBQyxnQkFBZ0IsMENBQUUsU0FBUztTQUM3QyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQsTUFBTTtRQUNKLHlFQUF5RTtRQUN6RSwwRUFBMEU7SUFDNUUsQ0FBQztJQUVELE1BQU0sQ0FBQyxLQUFvQjs7UUFDekIsTUFBTSxHQUFHLEdBQXNCLEVBQUUsUUFBUSxFQUFFLEtBQUssQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUM1RCxNQUFNLElBQUksR0FBRyxNQUFBLE1BQUEsTUFBQSxJQUFJLENBQUMsUUFBUSwwQ0FBRSxVQUFVLG1EQUFHLEdBQUcsQ0FBQyxtQ0FBSSxJQUFJLENBQUMsaUJBQWlCLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDN0UsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7WUFDaEIsSUFBSSxFQUFFLE1BQU07WUFDWixJQUFJO1lBQ0osS0FBSyxFQUFFLENBQUM7WUFDUixPQUFPLEVBQUUsTUFBQSxLQUFLLENBQUMsZ0JBQWdCLDBDQUFFLE9BQU87WUFDeEMsU0FBUyxFQUFFLE1BQUEsS0FBSyxDQUFDLGdCQUFnQiwwQ0FBRSxTQUFTO1NBQzdDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRCxVQUFVLENBQUMsS0FBd0I7O1FBQ2pDLE1BQU0sR0FBRyxHQUEwQjtZQUNqQyxRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVE7WUFDeEIsS0FBSyxFQUFFLEtBQUssQ0FBQyxLQUFLO1lBQ2xCLFFBQVEsRUFBRSxLQUFLLENBQUMsUUFBUTtTQUN6QixDQUFDO1FBQ0YsTUFBTSxJQUFJLEdBQUcsTUFBQSxNQUFBLE1BQUEsSUFBSSxDQUFDLFFBQVEsMENBQUUsY0FBYyxtREFBRyxHQUFHLENBQUMsbUNBQUksSUFBSSxDQUFDLHFCQUFxQixDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ3JGLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO1lBQ2hCLElBQUksRUFBRSxVQUFVO1lBQ2hCLElBQUk7WUFDSixLQUFLLEVBQUUsQ0FBQztZQUNSLE9BQU8sRUFBRSxNQUFBLEtBQUssQ0FBQyxnQkFBZ0IsMENBQUUsT0FBTztZQUN4QyxTQUFTLEVBQUUsTUFBQSxLQUFLLENBQUMsZ0JBQWdCLDBDQUFFLFNBQVM7U0FDN0MsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVELGNBQWMsQ0FBQyxLQUF1Qjs7UUFDcEMsZ0ZBQWdGO1FBQ2hGLE1BQU0sS0FBSyxHQUFHLE1BQUEsS0FBSyxDQUFDLFNBQVMsbUNBQUksRUFBRSxDQUFDO1FBQ3BDLElBQUksQ0FBQyxhQUFhLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2pDLElBQUksQ0FBQyxlQUFlLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRW5DLE1BQU0sR0FBRyxHQUF5QjtZQUNoQyxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUk7WUFDaEIsU0FBUyxFQUFFLE9BQU87WUFDbEIsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO1NBQy9CLENBQUM7UUFDRixNQUFNLElBQUksR0FBRyxNQUFBLE1BQUEsTUFBQSxJQUFJLENBQUMsUUFBUSwwQ0FBRSxhQUFhLG1EQUFHLEdBQUcsQ0FBQyxtQ0FBSSxJQUFJLENBQUMsb0JBQW9CLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDbkYsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7WUFDaEIsSUFBSSxFQUFFLFNBQVM7WUFDZixJQUFJO1lBQ0osS0FBSyxFQUFFLENBQUM7WUFDUixTQUFTLEVBQUUsS0FBSyxDQUFDLElBQUk7WUFDckIsT0FBTyxFQUFFLE1BQUEsS0FBSyxDQUFDLGdCQUFnQiwwQ0FBRSxPQUFPO1lBQ3hDLFNBQVMsRUFBRSxNQUFBLEtBQUssQ0FBQyxnQkFBZ0IsMENBQUUsU0FBUztTQUM3QyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQsYUFBYSxDQUFDLEtBQXVCOztRQUNuQyxNQUFNLEdBQUcsR0FBeUI7WUFDaEMsSUFBSSxFQUFFLEtBQUssQ0FBQyxJQUFJO1lBQ2hCLFNBQVMsRUFBRSxNQUFNO1NBQ2xCLENBQUM7UUFDRixNQUFNLElBQUksR0FBRyxNQUFBLE1BQUEsTUFBQSxJQUFJLENBQUMsUUFBUSwwQ0FBRSxhQUFhLG1EQUFHLEdBQUcsQ0FBQyxtQ0FBSSxJQUFJLENBQUMsb0JBQW9CLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDbkYsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7WUFDaEIsSUFBSSxFQUFFLFNBQVM7WUFDZixJQUFJO1lBQ0osS0FBSyxFQUFFLENBQUM7WUFDUixTQUFTLEVBQUUsS0FBSyxDQUFDLElBQUk7WUFDckIsT0FBTyxFQUFFLE1BQUEsS0FBSyxDQUFDLGdCQUFnQiwwQ0FBRSxPQUFPO1lBQ3hDLFNBQVMsRUFBRSxNQUFBLEtBQUssQ0FBQyxnQkFBZ0IsMENBQUUsU0FBUztTQUM3QyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQsTUFBTSxDQUFDLEtBQW9COztRQUN6QixNQUFNLEdBQUcsR0FBc0I7WUFDN0IsTUFBTSxFQUFFLEtBQUssQ0FBQyxNQUFNO1lBQ3BCLFNBQVMsRUFBRSxLQUFLLENBQUMsU0FBUztZQUMxQixXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVc7U0FDL0IsQ0FBQztRQUNGLE1BQU0sSUFBSSxHQUFHLE1BQUEsTUFBQSxNQUFBLElBQUksQ0FBQyxRQUFRLDBDQUFFLFVBQVUsbURBQUcsR0FBRyxDQUFDLG1DQUFJLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUM3RSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQztZQUNoQixJQUFJLEVBQUUsTUFBTTtZQUNaLElBQUk7WUFDSixLQUFLLEVBQUUsQ0FBQztZQUNSLE9BQU8sRUFBRSxNQUFBLEtBQUssQ0FBQyxnQkFBZ0IsMENBQUUsT0FBTztZQUN4QyxTQUFTLEVBQUUsTUFBQSxLQUFLLENBQUMsZ0JBQWdCLDBDQUFFLFNBQVM7U0FDN0MsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVELE9BQU8sQ0FBQyxLQUFxQjs7UUFDM0IsTUFBTSxHQUFHLEdBQXVCLEVBQUUsU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTLEVBQUUsQ0FBQztRQUMvRCxNQUFNLElBQUksR0FBRyxNQUFBLE1BQUEsTUFBQSxJQUFJLENBQUMsUUFBUSwwQ0FBRSxXQUFXLG1EQUFHLEdBQUcsQ0FBQyxtQ0FBSSxJQUFJLENBQUMsa0JBQWtCLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDL0UsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7WUFDaEIsSUFBSSxFQUFFLE9BQU87WUFDYixJQUFJO1lBQ0osS0FBSyxFQUFFLENBQUM7WUFDUixTQUFTLEVBQUUsS0FBSyxDQUFDLFNBQVM7WUFDMUIsT0FBTyxFQUFFLE1BQUEsS0FBSyxDQUFDLGdCQUFnQiwwQ0FBRSxPQUFPO1lBQ3hDLFNBQVMsRUFBRSxNQUFBLEtBQUssQ0FBQyxnQkFBZ0IsMENBQUUsU0FBUztTQUM3QyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQsT0FBTyxDQUFDLEtBQWdFOztRQUN0RSxtRkFBbUY7UUFDbkYsdUVBQXVFO1FBQ3ZFLElBQUksTUFBTSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxZQUFZLENBQUM7WUFBRSxPQUFPO1FBQ3RFLE1BQU0sU0FBUyxHQUFHLEtBQXVCLENBQUM7UUFDMUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxTQUFTLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTztZQUFFLE9BQU87UUFDdkQsTUFBTSxJQUFJLEdBQUcsdUJBQXVCLFNBQVMsQ0FBQyxTQUFTLEdBQUcsQ0FBQztRQUMzRCxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQztZQUNoQixJQUFJLEVBQUUsT0FBTztZQUNiLElBQUk7WUFDSixLQUFLLEVBQUUsQ0FBQztZQUNSLFNBQVMsRUFBRSxTQUFTLENBQUMsU0FBUztZQUM5QixPQUFPLEVBQUUsTUFBQSxNQUFBLFNBQVMsQ0FBQyxnQkFBZ0IsMENBQUUsT0FBTyxtQ0FBSSxTQUFTLENBQUMsT0FBTztZQUNqRSxTQUFTLEVBQUUsTUFBQSxTQUFTLENBQUMsZ0JBQWdCLDBDQUFFLFNBQVM7U0FDakQsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVELFFBQVEsQ0FBQyxLQUFpRTs7UUFDeEUscUZBQXFGO1FBQ3JGLElBQUksTUFBTSxDQUFDLFNBQVMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLEtBQUssRUFBRSxZQUFZLENBQUM7WUFBRSxPQUFPO1FBQ3RFLE1BQU0sU0FBUyxHQUFHLEtBQXdCLENBQUM7UUFDM0MsSUFBSSxDQUFDLFNBQVMsQ0FBQyxTQUFTLElBQUksQ0FBQyxTQUFTLENBQUMsT0FBTztZQUFFLE9BQU87UUFDdkQsTUFBTSxNQUFNLEdBQUcsU0FBUyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUM7UUFDekQsTUFBTSxJQUFJLEdBQUcsd0JBQXdCLFNBQVMsQ0FBQyxTQUFTLEdBQUcsTUFBTSxFQUFFLENBQUM7UUFDcEUsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUM7WUFDaEIsSUFBSSxFQUFFLFFBQVE7WUFDZCxJQUFJO1lBQ0osS0FBSyxFQUFFLENBQUM7WUFDUixTQUFTLEVBQUUsU0FBUyxDQUFDLFNBQVM7WUFDOUIsT0FBTyxFQUFFLE1BQUEsTUFBQSxTQUFTLENBQUMsZ0JBQWdCLDBDQUFFLE9BQU8sbUNBQUksU0FBUyxDQUFDLE9BQU87WUFDakUsU0FBUyxFQUFFLE1BQUEsU0FBUyxDQUFDLGdCQUFnQiwwQ0FBRSxTQUFTO1NBQ2pELENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRDs7OztPQUlHO0lBQ0gsT0FBTyxDQUFDLEtBQWdFOztRQUN0RSx1RUFBdUU7UUFDdkUsSUFBSSxPQUFRLEtBQXdCLENBQUMsT0FBTyxLQUFLLFFBQVE7WUFBRSxPQUFPO1FBQ2xFLE1BQU0sU0FBUyxHQUFHLEtBQXVCLENBQUM7UUFFMUMsSUFBSSxnQkFBb0MsQ0FBQztRQUN6QyxJQUFJLE1BQUEsTUFBQSxTQUFTLENBQUMsZUFBZSwwQ0FBRSxNQUFNLDBDQUFFLE1BQU0sRUFBRSxDQUFDO1lBQzlDLGdCQUFnQixHQUFHLFNBQVMsQ0FBQyxlQUFlLENBQUMsTUFBTTtpQkFDaEQsR0FBRyxDQUFDLENBQUMsS0FBSyxFQUFFLEVBQUU7Z0JBQ2IsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDLElBQUksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDO2dCQUNyRSxPQUFPLEdBQUcsSUFBSSxLQUFLLEtBQUssQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUNyQyxDQUFDLENBQUM7aUJBQ0QsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ2hCLENBQUM7UUFFRCxNQUFNLEdBQUcsR0FBdUI7WUFDOUIsU0FBUyxFQUFFLFNBQVMsQ0FBQyxTQUFTO1lBQzlCLE9BQU8sRUFBRSxTQUFTLENBQUMsT0FBTztZQUMxQixnQkFBZ0I7U0FDakIsQ0FBQztRQUNGLE1BQU0sSUFBSSxHQUFHLE1BQUEsTUFBQSxNQUFBLElBQUksQ0FBQyxRQUFRLDBDQUFFLFdBQVcsbURBQUcsR0FBRyxDQUFDLG1DQUFJLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUMvRSxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQztZQUNoQixJQUFJLEVBQUUsT0FBTztZQUNiLElBQUk7WUFDSixLQUFLLEVBQUUsQ0FBQztZQUNSLFNBQVMsRUFBRSxTQUFTLENBQUMsU0FBUztZQUM5QixPQUFPLEVBQUUsTUFBQSxTQUFTLENBQUMsZ0JBQWdCLDBDQUFFLE9BQU87WUFDNUMsU0FBUyxFQUFFLE1BQUEsU0FBUyxDQUFDLGdCQUFnQiwwQ0FBRSxTQUFTO1NBQ2pELENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRCx5RUFBeUU7SUFFekUsK0RBQStEO0lBQy9ELFVBQVU7UUFDUixPQUFPLENBQUMsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDM0IsQ0FBQztJQUVELHlGQUF5RjtJQUN6RixZQUFZLENBQUMsTUFBTSxHQUFHLElBQUk7UUFDeEIsT0FBTyxJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsR0FBRyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztJQUNuRixDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsbUJBQW1COztRQUNqQixNQUFNLE1BQU0sR0FBNkMsRUFBRSxFQUFFLEVBQUUsRUFBRSxFQUFFLENBQUM7UUFDcEUsS0FBSyxNQUFNLEtBQUssSUFBSSxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDakMsTUFBTSxHQUFHLEdBQUcsTUFBQSxLQUFLLENBQUMsU0FBUyxtQ0FBSSxFQUFFLENBQUM7WUFDbEMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUM7Z0JBQUUsTUFBTSxDQUFDLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztZQUNuQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQzFCLENBQUM7UUFDRCxPQUFPLE1BQU0sQ0FBQztJQUNoQixDQUFDO0lBRUQsOERBQThEO0lBQzlELEtBQUs7UUFDSCxJQUFJLENBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztRQUNsQixJQUFJLENBQUMsVUFBVSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ3hCLElBQUksQ0FBQyxhQUFhLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDM0IsSUFBSSxDQUFDLGVBQWUsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUMvQixDQUFDO0lBRUQseUVBQXlFO0lBRXpFLDhFQUE4RTtJQUN0RSxxQkFBcUIsQ0FBQyxVQUFrQjs7UUFDOUMsTUFBTSxPQUFPLEdBQUcsTUFBQSxJQUFJLENBQUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxVQUFVLENBQUMsbUNBQUksQ0FBQyxDQUFDO1FBQ3hELE1BQU0sSUFBSSxHQUFHLE9BQU8sR0FBRyxDQUFDLENBQUM7UUFDekIsSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsVUFBVSxFQUFFLElBQUksQ0FBQyxDQUFDO1FBQ3pDLE9BQU8sSUFBSSxDQUFDO0lBQ2QsQ0FBQztJQUVELHlGQUF5RjtJQUNqRixxQkFBcUIsQ0FBQyxVQUFrQjtRQUM5QyxJQUFJLENBQUMsSUFBSSxDQUFDLGVBQWUsQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQztZQUMxQyxJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsQ0FBQyxVQUFVLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDNUMsT0FBTyxJQUFJLENBQUM7UUFDZCxDQUFDO1FBQ0QsT0FBTyxLQUFLLENBQUM7SUFDZixDQUFDO0lBRU8sUUFBUSxDQUFDLFNBQWlCLEVBQUUsRUFBa0M7UUFDcEUsSUFBSSxHQUFHLEdBQUcsSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDekMsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDO1lBQ1QsR0FBRyxHQUFHLEVBQUUsQ0FBQztZQUNULElBQUksQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLFNBQVMsRUFBRSxHQUFHLENBQUMsQ0FBQztRQUN0QyxDQUFDO1FBQ0QsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLEdBQUcsRUFBRSxFQUFFLFVBQVUsRUFBRSxHQUFHLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUM7SUFDbEQsQ0FBQztJQUVPLFFBQVEsQ0FBQyxTQUFpQixFQUFFLFNBQWtCLEVBQUUsT0FBZ0I7O1FBQ3RFLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQzNDLElBQUksQ0FBQyxHQUFHLElBQUksR0FBRyxDQUFDLE1BQU0sS0FBSyxDQUFDO1lBQUUsT0FBTztRQUVyQyxLQUFLLE1BQU0sRUFBRSxJQUFJLEdBQUcsRUFBRSxDQUFDO1lBQ3JCLE1BQU0sWUFBWSxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsRUFBRSxDQUFDLFFBQVEsRUFBRSxJQUFJLENBQUMsY0FBYyxDQUFDLENBQUM7WUFDeEUsTUFBTSxLQUFLLEdBQW9CO2dCQUM3QixJQUFJLEVBQUUsRUFBRSxDQUFDLElBQUk7Z0JBQ2IsR0FBRyxFQUFFLEVBQUUsQ0FBQyxHQUFHO2dCQUNYLFFBQVEsRUFBRSxFQUFFLENBQUMsUUFBUTtnQkFDckIsWUFBWTtnQkFDWixTQUFTLEVBQUUsRUFBRSxDQUFDLFNBQVM7Z0JBQ3ZCLFVBQVUsRUFBRSxFQUFFLENBQUMsVUFBVTthQUMxQixDQUFDO1lBRUYsTUFBTSxJQUFJLEdBQUcsQ0FBQSxNQUFBLElBQUksQ0FBQyxRQUFRLDBDQUFFLFFBQVEsRUFBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsS0FBSyxDQUFDLENBQUM7WUFFbkcsSUFBSSxJQUFJLElBQUksSUFBSTtnQkFBRSxTQUFTLENBQUMsZ0RBQWdEO1lBRTVFLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO2dCQUNoQixJQUFJLEVBQUUsTUFBTTtnQkFDWixJQUFJO2dCQUNKLEtBQUssRUFBRSxDQUFDO2dCQUNSLFNBQVM7Z0JBQ1QsT0FBTztnQkFDUCxVQUFVLEVBQUUsRUFBRSxDQUFDLFVBQVU7Z0JBQ3pCLFNBQVM7Z0JBQ1QsR0FBRyxFQUFFLEVBQUUsQ0FBQyxHQUFHO2dCQUNYLFFBQVEsRUFBRSxFQUFFLENBQUMsUUFBUTthQUN0QixDQUFDLENBQUM7UUFDTCxDQUFDO1FBRUQsSUFBSSxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDcEMsQ0FBQztJQUVELHVFQUF1RTtJQUUvRCxrQkFBa0IsQ0FBQyxHQUF1QjtRQUNoRCxNQUFNLEtBQUssR0FBRyxHQUFHLENBQUMsT0FBTztZQUN2QixDQUFDLENBQUMsR0FBRyxDQUFDLFdBQVc7Z0JBQ2YsQ0FBQyxDQUFDLHNCQUFzQixHQUFHLENBQUMsV0FBVyxHQUFHO2dCQUMxQyxDQUFDLENBQUMsMEJBQTBCLEdBQUcsQ0FBQyxTQUFTLEdBQUc7WUFDOUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXO2dCQUNqQixDQUFDLENBQUMsY0FBYyxHQUFHLENBQUMsV0FBVyxHQUFHO2dCQUNsQyxDQUFDLENBQUMsd0JBQXdCLEdBQUcsQ0FBQyxTQUFTLEdBQUcsQ0FBQztRQUM3QyxPQUFPLFNBQVMsR0FBRyxDQUFDLFdBQVcsS0FBSyxLQUFLLEVBQUUsQ0FBQztJQUM5QyxDQUFDO0lBRU8sZUFBZSxDQUFDLEdBQW9CO1FBQzFDLE1BQU0sVUFBVSxHQUFHLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsUUFBUSxHQUFHLENBQUMsVUFBVSxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztRQUM3RSxJQUFJLEdBQUcsQ0FBQyxJQUFJLEtBQUssTUFBTSxFQUFFLENBQUM7WUFDeEIsT0FBTyxJQUFJLENBQUMsYUFBYSxJQUFJLEdBQUcsQ0FBQyxZQUFZO2dCQUMzQyxDQUFDLENBQUMsR0FBRyxVQUFVLFFBQVEsR0FBRyxDQUFDLEdBQUcsTUFBTSxHQUFHLENBQUMsWUFBWSxFQUFFO2dCQUN0RCxDQUFDLENBQUMsR0FBRyxVQUFVLFFBQVEsR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQ3JDLENBQUM7UUFDRCxJQUFJLEdBQUcsQ0FBQyxTQUFTLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDL0IsT0FBTyxHQUFHLFVBQVUsVUFBVSxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7UUFDMUMsQ0FBQztRQUNELElBQUksR0FBRyxDQUFDLFNBQVMsS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUMvQixPQUFPLElBQUksQ0FBQyxhQUFhO2dCQUN2QixDQUFDLENBQUMsR0FBRyxVQUFVLFVBQVUsR0FBRyxDQUFDLEdBQUcsTUFBTSxHQUFHLENBQUMsWUFBWSxFQUFFO2dCQUN4RCxDQUFDLENBQUMsR0FBRyxVQUFVLFVBQVUsR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQ3ZDLENBQUM7UUFDRCxPQUFPLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLEdBQUcsVUFBVSxTQUFTLEdBQUcsQ0FBQyxHQUFHLE1BQU0sR0FBRyxDQUFDLFlBQVksRUFBRSxDQUFDLENBQUMsQ0FBQyxHQUFHLFVBQVUsU0FBUyxHQUFHLENBQUMsR0FBRyxFQUFFLENBQUM7SUFDdEgsQ0FBQztJQUVPLHFCQUFxQixDQUFDLEdBQTBCOztRQUN0RCxNQUFNLFVBQVUsR0FBRyxHQUFHLENBQUMsTUFBTSxDQUFDO1FBQzlCLElBQUksYUFBcUIsQ0FBQztRQUMxQixJQUFJLEdBQUcsQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNqQiw4REFBOEQ7WUFDOUQsTUFBTSxRQUFRLEdBQUcsR0FBRyxDQUFDLFFBQWUsQ0FBQztZQUNyQyxNQUFNLFdBQVcsR0FBRyxNQUFBLFFBQVEsQ0FBQyxLQUFLLDBDQUFFLElBQUksQ0FBQyxDQUFDLENBQU0sRUFBRSxFQUFFLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQ2hFLElBQUksV0FBVyxFQUFFLENBQUM7Z0JBQ2hCLE1BQU0sS0FBSyxHQUFHLFdBQVcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssV0FBVyxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7Z0JBQ2pFLElBQUksV0FBVyxDQUFDLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztvQkFDbEMsTUFBTSxLQUFLLEdBQUcsV0FBVyxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQ3RDLENBQUMsQ0FBTSxFQUFFLEVBQUUsQ0FDVCxHQUFHLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDLGFBQWEsSUFBSSxDQUFDLENBQUMsRUFBRSxJQUFJLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsUUFBUSxFQUFFLENBQ3pHLENBQUM7b0JBQ0YsYUFBYSxHQUFHLHFCQUFxQixXQUFXLENBQUMsU0FBUyxHQUFHLEtBQUssS0FBSyxLQUFLLENBQUMsSUFBSSxDQUMvRSxJQUFJLENBQ0wsZUFBZSxVQUFVLEdBQUcsQ0FBQztnQkFDaEMsQ0FBQztxQkFBTSxDQUFDO29CQUNOLE1BQU0sS0FBSyxHQUFHLFdBQVcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBTSxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDLFlBQVksRUFBRSxDQUFDLENBQUM7b0JBQy9FLGFBQWEsR0FBRyxjQUFjLEtBQUssS0FBSyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxlQUFlLFVBQVUsR0FBRyxDQUFDO2dCQUN2RixDQUFDO1lBQ0gsQ0FBQztpQkFBTSxDQUFDO2dCQUNOLE1BQU0sWUFBWSxHQUFHLE1BQUEsTUFBQSxRQUFRLENBQUMsS0FBSywwQ0FBRSxNQUFNLENBQUMsQ0FBQyxDQUFNLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxVQUFVLEtBQUssU0FBUyxFQUFFLE1BQU0sbUNBQUksQ0FBQyxDQUFDO2dCQUNoRyxNQUFNLFNBQVMsR0FBRyxZQUFZLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLFlBQVksUUFBUSxZQUFZLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztnQkFDL0csYUFBYSxHQUFHLG1CQUFtQixTQUFTLDJCQUEyQixVQUFVLEdBQUcsQ0FBQztZQUN2RixDQUFDO1FBQ0gsQ0FBQzthQUFNLElBQUksR0FBRyxDQUFDLFdBQVcsSUFBSSxHQUFHLENBQUMsU0FBUyxFQUFFLENBQUM7WUFDNUMsYUFBYSxHQUFHLE1BQU0sR0FBRyxDQUFDLFdBQVcsS0FBSyxHQUFHLENBQUMsU0FBUyxpQkFBaUIsVUFBVSxHQUFHLENBQUM7UUFDeEYsQ0FBQzthQUFNLElBQUksR0FBRyxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQzNCLGFBQWEsR0FBRyxNQUFNLEdBQUcsQ0FBQyxXQUFXLGNBQWMsVUFBVSxHQUFHLENBQUM7UUFDbkUsQ0FBQzthQUFNLElBQUksR0FBRyxDQUFDLFNBQVMsRUFBRSxDQUFDO1lBQ3pCLGFBQWEsR0FBRyx3QkFBd0IsR0FBRyxDQUFDLFNBQVMsMkJBQTJCLFVBQVUsR0FBRyxDQUFDO1FBQ2hHLENBQUM7YUFBTSxDQUFDO1lBQ04sYUFBYSxHQUFHLCtDQUErQyxVQUFVLEdBQUcsQ0FBQztRQUMvRSxDQUFDO1FBQ0QsT0FBTyxnQkFBZ0IsYUFBYSxFQUFFLENBQUM7SUFDekMsQ0FBQztJQUVPLGlCQUFpQixDQUFDLEdBQXNCO1FBQzlDLE1BQU0sS0FBSyxHQUFHLEdBQUcsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ3RDLE9BQU8sNEJBQTRCLEdBQUcsQ0FBQyxRQUFRLENBQUMsTUFBTSxvQkFBb0IsS0FBSyxHQUFHLENBQUM7SUFDckYsQ0FBQztJQUVPLHFCQUFxQixDQUFDLEdBQTBCOztRQUN0RCxJQUFJLEdBQUcsQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNqQiw4REFBOEQ7WUFDOUQsTUFBTSxRQUFRLEdBQUcsR0FBRyxDQUFDLFFBQWUsQ0FBQztZQUNyQyxNQUFNLE9BQU8sR0FBRyxNQUFBLE1BQUEsUUFBUSxDQUFDLEtBQUssMENBQUUsTUFBTSxDQUFDLENBQUMsQ0FBTSxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLG1DQUFJLEVBQUUsQ0FBQztZQUNwRSxNQUFNLEtBQUssR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBTSxFQUFFLEVBQUU7Z0JBQ25DLE1BQU0sS0FBSyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7Z0JBQzdDLElBQUksQ0FBQyxDQUFDLElBQUksS0FBSyxRQUFRLEVBQUUsQ0FBQztvQkFDeEIsTUFBTSxLQUFLLEdBQUcsQ0FBQyxDQUFDLFVBQVU7eUJBQ3ZCLEdBQUcsQ0FDRixDQUFDLENBQU0sRUFBRSxFQUFFLENBQ1QsR0FBRyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUMsQ0FBQyxhQUFhLElBQUksQ0FBQyxDQUFDLEVBQUUsSUFBSSxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFFBQVEsRUFBRSxDQUN6Rzt5QkFDQSxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7b0JBQ2QsT0FBTyxHQUFHLENBQUMsQ0FBQyxNQUFNLEdBQUcsS0FBSyxLQUFLLEtBQUssR0FBRyxDQUFDO2dCQUMxQyxDQUFDO2dCQUNELE1BQU0sTUFBTSxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBTSxFQUFFLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLElBQUksQ0FBQyxDQUFDLFlBQVksRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO2dCQUNqRixPQUFPLEdBQUcsQ0FBQyxDQUFDLE1BQU0sR0FBRyxLQUFLLEtBQUssTUFBTSxHQUFHLENBQUM7WUFDM0MsQ0FBQyxDQUFDLENBQUM7WUFDSCxPQUFPLGVBQWUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxNQUFNLE9BQU8sR0FBRyxDQUFDLEtBQUssb0JBQW9CLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQztRQUNuRyxDQUFDO1FBQ0QsTUFBTSxLQUFLLEdBQUcsR0FBRyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDdEMsT0FBTyxlQUFlLEdBQUcsQ0FBQyxRQUFRLENBQUMsTUFBTSxPQUFPLEdBQUcsQ0FBQyxLQUFLLGtDQUFrQyxLQUFLLEdBQUcsQ0FBQztJQUN0RyxDQUFDO0lBRU8sb0JBQW9CLENBQUMsR0FBeUI7UUFDcEQsSUFBSSxHQUFHLENBQUMsU0FBUyxLQUFLLE1BQU0sRUFBRSxDQUFDO1lBQzdCLE9BQU8sZUFBZSxHQUFHLENBQUMsSUFBSSxXQUFXLENBQUM7UUFDNUMsQ0FBQztRQUNELE9BQU8sR0FBRyxDQUFDLFdBQVc7WUFDcEIsQ0FBQyxDQUFDLGdCQUFnQixHQUFHLENBQUMsSUFBSSxhQUFhLEdBQUcsQ0FBQyxXQUFXLEdBQUc7WUFDekQsQ0FBQyxDQUFDLGdCQUFnQixHQUFHLENBQUMsSUFBSSxXQUFXLENBQUM7SUFDMUMsQ0FBQztJQUVPLGlCQUFpQixDQUFDLEdBQXNCO1FBQzlDLE9BQU8sR0FBRyxDQUFDLFdBQVc7WUFDcEIsQ0FBQyxDQUFDLFdBQVcsR0FBRyxDQUFDLFNBQVMsS0FBSyxHQUFHLENBQUMsV0FBVyxTQUFTO1lBQ3ZELENBQUMsQ0FBQyxXQUFXLEdBQUcsQ0FBQyxTQUFTLFlBQVksR0FBRyxDQUFDLE1BQU0sR0FBRyxDQUFDO0lBQ3hELENBQUM7SUFFTyxrQkFBa0IsQ0FBQyxHQUF1QjtRQUNoRCxPQUFPLHdCQUF3QixHQUFHLENBQUMsU0FBUyxHQUFHLENBQUM7SUFDbEQsQ0FBQztJQUVPLGtCQUFrQixDQUFDLEdBQXVCO1FBQ2hELElBQUksSUFBSSxHQUFHLHdCQUF3QixHQUFHLENBQUMsU0FBUyxLQUFLLEdBQUcsQ0FBQyxPQUFPLEdBQUcsQ0FBQztRQUNwRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1lBQ3pCLElBQUksSUFBSSx1QkFBdUIsR0FBRyxDQUFDLGdCQUFnQixHQUFHLENBQUM7UUFDekQsQ0FBQztRQUNELE9BQU8sWUFBWSxJQUFJLEVBQUUsQ0FBQztJQUM1QixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIg4oCUIElubGluZSBuYXJyYXRpdmUgYnVpbGRlciB0aGF0IG1lcmdlcyBmbG93ICsgZGF0YSBkdXJpbmcgdHJhdmVyc2FsLlxuICpcbiAqIFJlcGxhY2VzIHRoZSBwb3N0LXByb2Nlc3NpbmcgQ29tYmluZWROYXJyYXRpdmVCdWlsZGVyIGJ5IGltcGxlbWVudGluZyBCT1RIXG4gKiBGbG93UmVjb3JkZXIgKGNvbnRyb2wtZmxvdyBldmVudHMpIGFuZCBSZWNvcmRlciAoc2NvcGUgZGF0YSBldmVudHMpLlxuICpcbiAqIEV2ZW50IG9yZGVyaW5nIGd1YXJhbnRlZXMgdGhpcyB3b3JrczpcbiAqICAgMS4gU2NvcGUgZXZlbnRzIChvblJlYWQsIG9uV3JpdGUpIGZpcmUgRFVSSU5HIHN0YWdlIGV4ZWN1dGlvblxuICogICAyLiBGbG93IGV2ZW50cyAob25TdGFnZUV4ZWN1dGVkLCBvbkRlY2lzaW9uKSBmaXJlIEFGVEVSIHN0YWdlIGV4ZWN1dGlvblxuICogICAzLiBCb3RoIGNhcnJ5IHRoZSBzYW1lIGBzdGFnZU5hbWVgIOKAlCBubyBtYXRjaGluZyBhbWJpZ3VpdHlcbiAqXG4gKiBTbyB3ZSBidWZmZXIgc2NvcGUgb3BzIHBlci1zdGFnZSwgdGhlbiB3aGVuIHRoZSBmbG93IGV2ZW50IGFycml2ZXMsXG4gKiBlbWl0IHRoZSBzdGFnZSBlbnRyeSArIGZsdXNoIHRoZSBidWZmZXJlZCBvcHMgaW4gb25lIHBhc3MuXG4gKi9cblxuaW1wb3J0IHsgc3VtbWFyaXplVmFsdWUgfSBmcm9tICcuLi8uLi9zY29wZS9yZWNvcmRlcnMvc3VtbWFyaXplVmFsdWUuanMnO1xuaW1wb3J0IHR5cGUgeyBSZWFkRXZlbnQsIFJlY29yZGVyLCBXcml0ZUV2ZW50IH0gZnJvbSAnLi4vLi4vc2NvcGUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUge1xuICBCcmVha1JlbmRlckNvbnRleHQsXG4gIENvbWJpbmVkTmFycmF0aXZlRW50cnksXG4gIERlY2lzaW9uUmVuZGVyQ29udGV4dCxcbiAgRXJyb3JSZW5kZXJDb250ZXh0LFxuICBGb3JrUmVuZGVyQ29udGV4dCxcbiAgTG9vcFJlbmRlckNvbnRleHQsXG4gIE5hcnJhdGl2ZVJlbmRlcmVyLFxuICBPcFJlbmRlckNvbnRleHQsXG4gIFNlbGVjdGVkUmVuZGVyQ29udGV4dCxcbiAgU3RhZ2VSZW5kZXJDb250ZXh0LFxuICBTdWJmbG93UmVuZGVyQ29udGV4dCxcbn0gZnJvbSAnLi9uYXJyYXRpdmVUeXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7XG4gIEZsb3dCcmVha0V2ZW50LFxuICBGbG93RGVjaXNpb25FdmVudCxcbiAgRmxvd0Vycm9yRXZlbnQsXG4gIEZsb3dGb3JrRXZlbnQsXG4gIEZsb3dMb29wRXZlbnQsXG4gIEZsb3dQYXVzZUV2ZW50LFxuICBGbG93UmVjb3JkZXIsXG4gIEZsb3dSZXN1bWVFdmVudCxcbiAgRmxvd1NlbGVjdGVkRXZlbnQsXG4gIEZsb3dTdGFnZUV2ZW50LFxuICBGbG93U3ViZmxvd0V2ZW50LFxufSBmcm9tICcuL3R5cGVzLmpzJztcblxuLy8g4pSA4pSAIFR5cGVzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG5pbnRlcmZhY2UgQnVmZmVyZWRPcCB7XG4gIHR5cGU6ICdyZWFkJyB8ICd3cml0ZSc7XG4gIGtleTogc3RyaW5nO1xuICByYXdWYWx1ZTogdW5rbm93bjtcbiAgb3BlcmF0aW9uPzogJ3NldCcgfCAndXBkYXRlJyB8ICdkZWxldGUnO1xuICBzdGVwTnVtYmVyOiBudW1iZXI7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlck9wdGlvbnMge1xuICBpbmNsdWRlU3RlcE51bWJlcnM/OiBib29sZWFuO1xuICBpbmNsdWRlVmFsdWVzPzogYm9vbGVhbjtcbiAgbWF4VmFsdWVMZW5ndGg/OiBudW1iZXI7XG4gIC8qKiBDdXN0b20gdmFsdWUgZm9ybWF0dGVyLiBDYWxsZWQgYXQgcmVuZGVyIHRpbWUgKGZsdXNoT3BzKSwgbm90IGNhcHR1cmUgdGltZS5cbiAgICogIFJlY2VpdmVzIHRoZSByYXcgdmFsdWUgYW5kIG1heFZhbHVlTGVuZ3RoLiBEZWZhdWx0cyB0byBzdW1tYXJpemVWYWx1ZSgpLiAqL1xuICBmb3JtYXRWYWx1ZT86ICh2YWx1ZTogdW5rbm93biwgbWF4TGVuOiBudW1iZXIpID0+IHN0cmluZztcbiAgLyoqIFBsdWdnYWJsZSByZW5kZXJlciBmb3IgY3VzdG9taXppbmcgbmFycmF0aXZlIG91dHB1dC4gVW5pbXBsZW1lbnRlZCBtZXRob2RzXG4gICAqICBmYWxsIGJhY2sgdG8gdGhlIGRlZmF1bHQgRW5nbGlzaCByZW5kZXJlci4gU2VlIE5hcnJhdGl2ZVJlbmRlcmVyIGRvY3MuICovXG4gIHJlbmRlcmVyPzogTmFycmF0aXZlUmVuZGVyZXI7XG59XG5cbi8vIOKUgOKUgCBSZWNvcmRlciDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuZXhwb3J0IGNsYXNzIENvbWJpbmVkTmFycmF0aXZlUmVjb3JkZXIgaW1wbGVtZW50cyBGbG93UmVjb3JkZXIsIFJlY29yZGVyIHtcbiAgcmVhZG9ubHkgaWQ6IHN0cmluZztcblxuICBwcml2YXRlIGVudHJpZXM6IENvbWJpbmVkTmFycmF0aXZlRW50cnlbXSA9IFtdO1xuICAvKipcbiAgICogUGVuZGluZyBzY29wZSBvcHMga2V5ZWQgYnkgc3RhZ2VOYW1lLiBGbHVzaGVkIGluIG9uU3RhZ2VFeGVjdXRlZC9vbkRlY2lzaW9uLlxuICAgKlxuICAgKiBOYW1lIGNvbGxpc2lvbnMgKHR3byBzdGFnZXMgd2l0aCB0aGUgc2FtZSBuYW1lLCBkaWZmZXJlbnQgSURzKSBhcmUgcHJldmVudGVkIGJ5XG4gICAqIHRoZSBldmVudCBvcmRlcmluZyBjb250cmFjdDogc2NvcGUgZXZlbnRzIChvblJlYWQvb25Xcml0ZSkgZm9yIHN0YWdlIE4gYXJlIGFsd2F5c1xuICAgKiBmbHVzaGVkIGJ5IG9uU3RhZ2VFeGVjdXRlZCBmb3Igc3RhZ2UgTiBiZWZvcmUgc3RhZ2UgTisxJ3Mgc2NvcGUgZXZlbnRzIGJlZ2luLlxuICAgKiBTbyB0aGUga2V5IGlzIGFsd2F5cyB1bmlxdWVseSBib3VuZCB0byB0aGUgY3VycmVudGx5LWV4ZWN1dGluZyBzdGFnZS5cbiAgICovXG4gIHByaXZhdGUgcGVuZGluZ09wcyA9IG5ldyBNYXA8c3RyaW5nLCBCdWZmZXJlZE9wW10+KCk7XG4gIC8qKiBQZXItc3ViZmxvdyBzdGFnZSBjb3VudGVycy4gS2V5ICcnID0gcm9vdCBmbG93LiAqL1xuICBwcml2YXRlIHN0YWdlQ291bnRlcnMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICAvKiogUGVyLXN1YmZsb3cgZmlyc3Qtc3RhZ2UgZmxhZ3MuIEtleSAnJyA9IHJvb3QgZmxvdy4gKi9cbiAgcHJpdmF0ZSBmaXJzdFN0YWdlRmxhZ3MgPSBuZXcgTWFwPHN0cmluZywgYm9vbGVhbj4oKTtcblxuICBwcml2YXRlIGluY2x1ZGVTdGVwTnVtYmVyczogYm9vbGVhbjtcbiAgcHJpdmF0ZSBpbmNsdWRlVmFsdWVzOiBib29sZWFuO1xuICBwcml2YXRlIG1heFZhbHVlTGVuZ3RoOiBudW1iZXI7XG4gIHByaXZhdGUgZm9ybWF0VmFsdWU6ICh2YWx1ZTogdW5rbm93biwgbWF4TGVuOiBudW1iZXIpID0+IHN0cmluZztcbiAgcHJpdmF0ZSByZW5kZXJlcj86IE5hcnJhdGl2ZVJlbmRlcmVyO1xuXG4gIGNvbnN0cnVjdG9yKG9wdGlvbnM/OiBDb21iaW5lZE5hcnJhdGl2ZVJlY29yZGVyT3B0aW9ucyAmIHsgaWQ/OiBzdHJpbmcgfSkge1xuICAgIHRoaXMuaWQgPSBvcHRpb25zPy5pZCA/PyAnY29tYmluZWQtbmFycmF0aXZlJztcbiAgICB0aGlzLmluY2x1ZGVTdGVwTnVtYmVycyA9IG9wdGlvbnM/LmluY2x1ZGVTdGVwTnVtYmVycyA/PyB0cnVlO1xuICAgIHRoaXMuaW5jbHVkZVZhbHVlcyA9IG9wdGlvbnM/LmluY2x1ZGVWYWx1ZXMgPz8gdHJ1ZTtcbiAgICB0aGlzLm1heFZhbHVlTGVuZ3RoID0gb3B0aW9ucz8ubWF4VmFsdWVMZW5ndGggPz8gODA7XG4gICAgdGhpcy5mb3JtYXRWYWx1ZSA9IG9wdGlvbnM/LmZvcm1hdFZhbHVlID8/IHN1bW1hcml6ZVZhbHVlO1xuICAgIHRoaXMucmVuZGVyZXIgPSBvcHRpb25zPy5yZW5kZXJlcjtcbiAgfVxuXG4gIC8vIOKUgOKUgCBTY29wZSBjaGFubmVsIChmaXJlcyBmaXJzdCwgZHVyaW5nIHN0YWdlIGV4ZWN1dGlvbikg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgb25SZWFkKGV2ZW50OiBSZWFkRXZlbnQpOiB2b2lkIHtcbiAgICBpZiAoIWV2ZW50LmtleSkgcmV0dXJuO1xuICAgIHRoaXMuYnVmZmVyT3AoZXZlbnQuc3RhZ2VOYW1lLCB7XG4gICAgICB0eXBlOiAncmVhZCcsXG4gICAgICBrZXk6IGV2ZW50LmtleSxcbiAgICAgIHJhd1ZhbHVlOiBldmVudC52YWx1ZSxcbiAgICB9KTtcbiAgfVxuXG4gIG9uV3JpdGUoZXZlbnQ6IFdyaXRlRXZlbnQpOiB2b2lkIHtcbiAgICB0aGlzLmJ1ZmZlck9wKGV2ZW50LnN0YWdlTmFtZSwge1xuICAgICAgdHlwZTogJ3dyaXRlJyxcbiAgICAgIGtleTogZXZlbnQua2V5LFxuICAgICAgcmF3VmFsdWU6IGV2ZW50LnZhbHVlLFxuICAgICAgb3BlcmF0aW9uOiBldmVudC5vcGVyYXRpb24sXG4gICAgfSk7XG4gIH1cblxuICAvLyDilIDilIAgRmxvdyBjaGFubmVsIChmaXJlcyBhZnRlciBzdGFnZSBleGVjdXRpb24pIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIG9uU3RhZ2VFeGVjdXRlZChldmVudDogRmxvd1N0YWdlRXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBzdGFnZUlkID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3RhZ2VJZDtcbiAgICBjb25zdCBzZktleSA9IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCA/PyAnJztcbiAgICBjb25zdCBzdGFnZU51bSA9IHRoaXMuaW5jcmVtZW50U3RhZ2VDb3VudGVyKHNmS2V5KTtcbiAgICBjb25zdCBpc0ZpcnN0ID0gdGhpcy5jb25zdW1lRmlyc3RTdGFnZUZsYWcoc2ZLZXkpO1xuXG4gICAgY29uc3QgY3R4OiBTdGFnZVJlbmRlckNvbnRleHQgPSB7XG4gICAgICBzdGFnZU5hbWU6IGV2ZW50LnN0YWdlTmFtZSxcbiAgICAgIHN0YWdlTnVtYmVyOiBzdGFnZU51bSxcbiAgICAgIGlzRmlyc3QsXG4gICAgICBkZXNjcmlwdGlvbjogZXZlbnQuZGVzY3JpcHRpb24sXG4gICAgfTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyU3RhZ2U/LihjdHgpID8/IHRoaXMuZGVmYXVsdFJlbmRlclN0YWdlKGN0eCk7XG5cbiAgICBjb25zdCBzZklkID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkO1xuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICB0ZXh0LFxuICAgICAgZGVwdGg6IDAsXG4gICAgICBzdGFnZU5hbWU6IGV2ZW50LnN0YWdlTmFtZSxcbiAgICAgIHN0YWdlSWQsXG4gICAgICBzdWJmbG93SWQ6IHNmSWQsXG4gICAgfSk7XG4gICAgdGhpcy5mbHVzaE9wcyhldmVudC5zdGFnZU5hbWUsIHNmSWQsIHN0YWdlSWQpO1xuICB9XG5cbiAgb25EZWNpc2lvbihldmVudDogRmxvd0RlY2lzaW9uRXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBkZWNpZGVyU3RhZ2VJZEVhcmx5ID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3RhZ2VJZDtcblxuICAgIC8vIEVtaXQgdGhlIGRlY2lkZXIgc3RhZ2UgZW50cnkgKGRlY2lkZXJzIGRvbid0IGZpcmUgb25TdGFnZUV4ZWN1dGVkKVxuICAgIGNvbnN0IHNmS2V5ID0gZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkID8/ICcnO1xuICAgIGNvbnN0IHN0YWdlTnVtID0gdGhpcy5pbmNyZW1lbnRTdGFnZUNvdW50ZXIoc2ZLZXkpO1xuICAgIGNvbnN0IGlzRmlyc3QgPSB0aGlzLmNvbnN1bWVGaXJzdFN0YWdlRmxhZyhzZktleSk7XG5cbiAgICBjb25zdCBzdGFnZUN0eDogU3RhZ2VSZW5kZXJDb250ZXh0ID0ge1xuICAgICAgc3RhZ2VOYW1lOiBldmVudC5kZWNpZGVyLFxuICAgICAgc3RhZ2VOdW1iZXI6IHN0YWdlTnVtLFxuICAgICAgaXNGaXJzdCxcbiAgICAgIGRlc2NyaXB0aW9uOiBldmVudC5kZXNjcmlwdGlvbixcbiAgICB9O1xuICAgIGNvbnN0IHN0YWdlVGV4dCA9IHRoaXMucmVuZGVyZXI/LnJlbmRlclN0YWdlPy4oc3RhZ2VDdHgpID8/IHRoaXMuZGVmYXVsdFJlbmRlclN0YWdlKHN0YWdlQ3R4KTtcblxuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdzdGFnZScsXG4gICAgICB0ZXh0OiBzdGFnZVRleHQsXG4gICAgICBkZXB0aDogMCxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuZGVjaWRlcixcbiAgICAgIHN0YWdlSWQ6IGRlY2lkZXJTdGFnZUlkRWFybHksXG4gICAgICBzdWJmbG93SWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCxcbiAgICB9KTtcbiAgICB0aGlzLmZsdXNoT3BzKGV2ZW50LmRlY2lkZXIsIGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCwgZGVjaWRlclN0YWdlSWRFYXJseSk7XG5cbiAgICAvLyBFbWl0IHRoZSBjb25kaXRpb24gZW50cnkgYXMgYSBuZXN0ZWQgc3ViLWl0ZW0gKGRlcHRoIDEpIG9mIHRoZSBzdGFnZSBhYm92ZS5cbiAgICAvLyBEZWNpc2lvbiBvdXRjb21lIGlzIGEgZGV0YWlsIG9mIHRoZSBkZWNpZGVyIHN0YWdlLCBub3QgYSBzZXBhcmF0ZSB0b3AtbGV2ZWwgZW50cnkuXG4gICAgY29uc3QgZGVjaXNpb25DdHg6IERlY2lzaW9uUmVuZGVyQ29udGV4dCA9IHtcbiAgICAgIGRlY2lkZXI6IGV2ZW50LmRlY2lkZXIsXG4gICAgICBjaG9zZW46IGV2ZW50LmNob3NlbixcbiAgICAgIGRlc2NyaXB0aW9uOiBldmVudC5kZXNjcmlwdGlvbixcbiAgICAgIHJhdGlvbmFsZTogZXZlbnQucmF0aW9uYWxlLFxuICAgICAgZXZpZGVuY2U6IGV2ZW50LmV2aWRlbmNlLFxuICAgIH07XG4gICAgY29uc3QgY29uZGl0aW9uVGV4dCA9IHRoaXMucmVuZGVyZXI/LnJlbmRlckRlY2lzaW9uPy4oZGVjaXNpb25DdHgpID8/IHRoaXMuZGVmYXVsdFJlbmRlckRlY2lzaW9uKGRlY2lzaW9uQ3R4KTtcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAnY29uZGl0aW9uJyxcbiAgICAgIHRleHQ6IGNvbmRpdGlvblRleHQsXG4gICAgICBkZXB0aDogMSxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuZGVjaWRlcixcbiAgICAgIHN0YWdlSWQ6IGRlY2lkZXJTdGFnZUlkRWFybHksXG4gICAgICBzdWJmbG93SWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCxcbiAgICB9KTtcbiAgfVxuXG4gIG9uTmV4dCgpOiB2b2lkIHtcbiAgICAvLyBOby1vcC4gb25TdGFnZUV4ZWN1dGVkIGFscmVhZHkgaGFzIHRoZSBkZXNjcmlwdGlvbiBmb3IgdGhlIG5leHQgc3RhZ2UuXG4gICAgLy8gRm9yIGRlY2lkZXJzIChubyBvblN0YWdlRXhlY3V0ZWQpLCBvbkRlY2lzaW9uIGhhbmRsZXMgdGhlIGFubm91bmNlbWVudC5cbiAgfVxuXG4gIG9uRm9yayhldmVudDogRmxvd0ZvcmtFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IGN0eDogRm9ya1JlbmRlckNvbnRleHQgPSB7IGNoaWxkcmVuOiBldmVudC5jaGlsZHJlbiB9O1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcmVyPy5yZW5kZXJGb3JrPy4oY3R4KSA/PyB0aGlzLmRlZmF1bHRSZW5kZXJGb3JrKGN0eCk7XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ2ZvcmsnLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3RhZ2VJZCxcbiAgICAgIHN1YmZsb3dJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICB9XG5cbiAgb25TZWxlY3RlZChldmVudDogRmxvd1NlbGVjdGVkRXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBjdHg6IFNlbGVjdGVkUmVuZGVyQ29udGV4dCA9IHtcbiAgICAgIHNlbGVjdGVkOiBldmVudC5zZWxlY3RlZCxcbiAgICAgIHRvdGFsOiBldmVudC50b3RhbCxcbiAgICAgIGV2aWRlbmNlOiBldmVudC5ldmlkZW5jZSxcbiAgICB9O1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcmVyPy5yZW5kZXJTZWxlY3RlZD8uKGN0eCkgPz8gdGhpcy5kZWZhdWx0UmVuZGVyU2VsZWN0ZWQoY3R4KTtcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAnc2VsZWN0b3InLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3RhZ2VJZCxcbiAgICAgIHN1YmZsb3dJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICB9XG5cbiAgb25TdWJmbG93RW50cnkoZXZlbnQ6IEZsb3dTdWJmbG93RXZlbnQpOiB2b2lkIHtcbiAgICAvLyBSZXNldCBzdGFnZSBjb3VudGVyIGZvciB0aGlzIHN1YmZsb3cgc28gc3RhZ2VzIHN0YXJ0IGF0IFwiU3RhZ2UgMVwiIG9uIHJlLWVudHJ5XG4gICAgY29uc3Qgc2ZLZXkgPSBldmVudC5zdWJmbG93SWQgPz8gJyc7XG4gICAgdGhpcy5zdGFnZUNvdW50ZXJzLmRlbGV0ZShzZktleSk7XG4gICAgdGhpcy5maXJzdFN0YWdlRmxhZ3MuZGVsZXRlKHNmS2V5KTtcblxuICAgIGNvbnN0IGN0eDogU3ViZmxvd1JlbmRlckNvbnRleHQgPSB7XG4gICAgICBuYW1lOiBldmVudC5uYW1lLFxuICAgICAgZGlyZWN0aW9uOiAnZW50cnknLFxuICAgICAgZGVzY3JpcHRpb246IGV2ZW50LmRlc2NyaXB0aW9uLFxuICAgIH07XG4gICAgY29uc3QgdGV4dCA9IHRoaXMucmVuZGVyZXI/LnJlbmRlclN1YmZsb3c/LihjdHgpID8/IHRoaXMuZGVmYXVsdFJlbmRlclN1YmZsb3coY3R4KTtcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAnc3ViZmxvdycsXG4gICAgICB0ZXh0LFxuICAgICAgZGVwdGg6IDAsXG4gICAgICBzdGFnZU5hbWU6IGV2ZW50Lm5hbWUsXG4gICAgICBzdGFnZUlkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkLFxuICAgICAgc3ViZmxvd0lkOiBldmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdWJmbG93SWQsXG4gICAgfSk7XG4gIH1cblxuICBvblN1YmZsb3dFeGl0KGV2ZW50OiBGbG93U3ViZmxvd0V2ZW50KTogdm9pZCB7XG4gICAgY29uc3QgY3R4OiBTdWJmbG93UmVuZGVyQ29udGV4dCA9IHtcbiAgICAgIG5hbWU6IGV2ZW50Lm5hbWUsXG4gICAgICBkaXJlY3Rpb246ICdleGl0JyxcbiAgICB9O1xuICAgIGNvbnN0IHRleHQgPSB0aGlzLnJlbmRlcmVyPy5yZW5kZXJTdWJmbG93Py4oY3R4KSA/PyB0aGlzLmRlZmF1bHRSZW5kZXJTdWJmbG93KGN0eCk7XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ3N1YmZsb3cnLFxuICAgICAgdGV4dCxcbiAgICAgIGRlcHRoOiAwLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5uYW1lLFxuICAgICAgc3RhZ2VJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3RhZ2VJZCxcbiAgICAgIHN1YmZsb3dJZDogZXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICB9XG5cbiAgb25Mb29wKGV2ZW50OiBGbG93TG9vcEV2ZW50KTogdm9pZCB7XG4gICAgY29uc3QgY3R4OiBMb29wUmVuZGVyQ29udGV4dCA9IHtcbiAgICAgIHRhcmdldDogZXZlbnQudGFyZ2V0LFxuICAgICAgaXRlcmF0aW9uOiBldmVudC5pdGVyYXRpb24sXG4gICAgICBkZXNjcmlwdGlvbjogZXZlbnQuZGVzY3JpcHRpb24sXG4gICAgfTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyTG9vcD8uKGN0eCkgPz8gdGhpcy5kZWZhdWx0UmVuZGVyTG9vcChjdHgpO1xuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdsb29wJyxcbiAgICAgIHRleHQsXG4gICAgICBkZXB0aDogMCxcbiAgICAgIHN0YWdlSWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN0YWdlSWQsXG4gICAgICBzdWJmbG93SWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCxcbiAgICB9KTtcbiAgfVxuXG4gIG9uQnJlYWsoZXZlbnQ6IEZsb3dCcmVha0V2ZW50KTogdm9pZCB7XG4gICAgY29uc3QgY3R4OiBCcmVha1JlbmRlckNvbnRleHQgPSB7IHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lIH07XG4gICAgY29uc3QgdGV4dCA9IHRoaXMucmVuZGVyZXI/LnJlbmRlckJyZWFrPy4oY3R4KSA/PyB0aGlzLmRlZmF1bHRSZW5kZXJCcmVhayhjdHgpO1xuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdicmVhaycsXG4gICAgICB0ZXh0LFxuICAgICAgZGVwdGg6IDAsXG4gICAgICBzdGFnZU5hbWU6IGV2ZW50LnN0YWdlTmFtZSxcbiAgICAgIHN0YWdlSWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN0YWdlSWQsXG4gICAgICBzdWJmbG93SWQ6IGV2ZW50LnRyYXZlcnNhbENvbnRleHQ/LnN1YmZsb3dJZCxcbiAgICB9KTtcbiAgfVxuXG4gIG9uUGF1c2UoZXZlbnQ6IEZsb3dQYXVzZUV2ZW50IHwgeyBzdGFnZU5hbWU/OiBzdHJpbmc7IHN0YWdlSWQ/OiBzdHJpbmcgfSk6IHZvaWQge1xuICAgIC8vIE9ubHkgaGFuZGxlIEZsb3dQYXVzZUV2ZW50IChmcm9tIEZsb3dSZWNvcmRlciBjaGFubmVsKTsgaWdub3JlIHNjb3BlIFBhdXNlRXZlbnQuXG4gICAgLy8gRmxvd1BhdXNlRXZlbnQgaGFzICdzdWJmbG93UGF0aCcsIHNjb3BlIFBhdXNlRXZlbnQgaGFzICdwaXBlbGluZUlkJy5cbiAgICBpZiAoT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKGV2ZW50LCAncGlwZWxpbmVJZCcpKSByZXR1cm47XG4gICAgY29uc3QgZmxvd0V2ZW50ID0gZXZlbnQgYXMgRmxvd1BhdXNlRXZlbnQ7XG4gICAgaWYgKCFmbG93RXZlbnQuc3RhZ2VOYW1lIHx8ICFmbG93RXZlbnQuc3RhZ2VJZCkgcmV0dXJuO1xuICAgIGNvbnN0IHRleHQgPSBgRXhlY3V0aW9uIHBhdXNlZCBhdCAke2Zsb3dFdmVudC5zdGFnZU5hbWV9LmA7XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ3BhdXNlJyxcbiAgICAgIHRleHQsXG4gICAgICBkZXB0aDogMCxcbiAgICAgIHN0YWdlTmFtZTogZmxvd0V2ZW50LnN0YWdlTmFtZSxcbiAgICAgIHN0YWdlSWQ6IGZsb3dFdmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkID8/IGZsb3dFdmVudC5zdGFnZUlkLFxuICAgICAgc3ViZmxvd0lkOiBmbG93RXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICB9XG5cbiAgb25SZXN1bWUoZXZlbnQ6IEZsb3dSZXN1bWVFdmVudCB8IHsgc3RhZ2VOYW1lPzogc3RyaW5nOyBzdGFnZUlkPzogc3RyaW5nIH0pOiB2b2lkIHtcbiAgICAvLyBPbmx5IGhhbmRsZSBGbG93UmVzdW1lRXZlbnQgKGZyb20gRmxvd1JlY29yZGVyIGNoYW5uZWwpOyBpZ25vcmUgc2NvcGUgUmVzdW1lRXZlbnQuXG4gICAgaWYgKE9iamVjdC5wcm90b3R5cGUuaGFzT3duUHJvcGVydHkuY2FsbChldmVudCwgJ3BpcGVsaW5lSWQnKSkgcmV0dXJuO1xuICAgIGNvbnN0IGZsb3dFdmVudCA9IGV2ZW50IGFzIEZsb3dSZXN1bWVFdmVudDtcbiAgICBpZiAoIWZsb3dFdmVudC5zdGFnZU5hbWUgfHwgIWZsb3dFdmVudC5zdGFnZUlkKSByZXR1cm47XG4gICAgY29uc3Qgc3VmZml4ID0gZmxvd0V2ZW50Lmhhc0lucHV0ID8gJyB3aXRoIGlucHV0LicgOiAnLic7XG4gICAgY29uc3QgdGV4dCA9IGBFeGVjdXRpb24gcmVzdW1lZCBhdCAke2Zsb3dFdmVudC5zdGFnZU5hbWV9JHtzdWZmaXh9YDtcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAncmVzdW1lJyxcbiAgICAgIHRleHQsXG4gICAgICBkZXB0aDogMCxcbiAgICAgIHN0YWdlTmFtZTogZmxvd0V2ZW50LnN0YWdlTmFtZSxcbiAgICAgIHN0YWdlSWQ6IGZsb3dFdmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkID8/IGZsb3dFdmVudC5zdGFnZUlkLFxuICAgICAgc3ViZmxvd0lkOiBmbG93RXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIEhhbmRsZXMgZXJyb3JzIGZyb20gYm90aCBjaGFubmVsczpcbiAgICogLSBGbG93UmVjb3JkZXIub25FcnJvciAoRmxvd0Vycm9yRXZlbnQgd2l0aCBtZXNzYWdlICsgc3RydWN0dXJlZEVycm9yKVxuICAgKiAtIFJlY29yZGVyLm9uRXJyb3IgKEVycm9yRXZlbnQgZnJvbSBzY29wZSBzeXN0ZW0g4oCUIGlnbm9yZWQgZm9yIG5hcnJhdGl2ZSlcbiAgICovXG4gIG9uRXJyb3IoZXZlbnQ6IEZsb3dFcnJvckV2ZW50IHwgeyBzdGFnZU5hbWU/OiBzdHJpbmc7IG1lc3NhZ2U/OiBzdHJpbmcgfSk6IHZvaWQge1xuICAgIC8vIE9ubHkgaGFuZGxlIGZsb3cgZXJyb3JzICh3aGljaCBoYXZlIGBtZXNzYWdlYCBhbmQgYHN0cnVjdHVyZWRFcnJvcmApXG4gICAgaWYgKHR5cGVvZiAoZXZlbnQgYXMgRmxvd0Vycm9yRXZlbnQpLm1lc3NhZ2UgIT09ICdzdHJpbmcnKSByZXR1cm47XG4gICAgY29uc3QgZmxvd0V2ZW50ID0gZXZlbnQgYXMgRmxvd0Vycm9yRXZlbnQ7XG5cbiAgICBsZXQgdmFsaWRhdGlvbklzc3Vlczogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIGlmIChmbG93RXZlbnQuc3RydWN0dXJlZEVycm9yPy5pc3N1ZXM/Lmxlbmd0aCkge1xuICAgICAgdmFsaWRhdGlvbklzc3VlcyA9IGZsb3dFdmVudC5zdHJ1Y3R1cmVkRXJyb3IuaXNzdWVzXG4gICAgICAgIC5tYXAoKGlzc3VlKSA9PiB7XG4gICAgICAgICAgY29uc3QgcGF0aCA9IGlzc3VlLnBhdGgubGVuZ3RoID4gMCA/IGlzc3VlLnBhdGguam9pbignLicpIDogJyhyb290KSc7XG4gICAgICAgICAgcmV0dXJuIGAke3BhdGh9OiAke2lzc3VlLm1lc3NhZ2V9YDtcbiAgICAgICAgfSlcbiAgICAgICAgLmpvaW4oJzsgJyk7XG4gICAgfVxuXG4gICAgY29uc3QgY3R4OiBFcnJvclJlbmRlckNvbnRleHQgPSB7XG4gICAgICBzdGFnZU5hbWU6IGZsb3dFdmVudC5zdGFnZU5hbWUsXG4gICAgICBtZXNzYWdlOiBmbG93RXZlbnQubWVzc2FnZSxcbiAgICAgIHZhbGlkYXRpb25Jc3N1ZXMsXG4gICAgfTtcbiAgICBjb25zdCB0ZXh0ID0gdGhpcy5yZW5kZXJlcj8ucmVuZGVyRXJyb3I/LihjdHgpID8/IHRoaXMuZGVmYXVsdFJlbmRlckVycm9yKGN0eCk7XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ2Vycm9yJyxcbiAgICAgIHRleHQsXG4gICAgICBkZXB0aDogMCxcbiAgICAgIHN0YWdlTmFtZTogZmxvd0V2ZW50LnN0YWdlTmFtZSxcbiAgICAgIHN0YWdlSWQ6IGZsb3dFdmVudC50cmF2ZXJzYWxDb250ZXh0Py5zdGFnZUlkLFxuICAgICAgc3ViZmxvd0lkOiBmbG93RXZlbnQudHJhdmVyc2FsQ29udGV4dD8uc3ViZmxvd0lkLFxuICAgIH0pO1xuICB9XG5cbiAgLy8g4pSA4pSAIE91dHB1dCDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKiogUmV0dXJucyBzdHJ1Y3R1cmVkIGVudHJpZXMgZm9yIHByb2dyYW1tYXRpYyBjb25zdW1wdGlvbi4gKi9cbiAgZ2V0RW50cmllcygpOiBDb21iaW5lZE5hcnJhdGl2ZUVudHJ5W10ge1xuICAgIHJldHVybiBbLi4udGhpcy5lbnRyaWVzXTtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIGZvcm1hdHRlZCBuYXJyYXRpdmUgbGluZXMgKHNhbWUgb3V0cHV0IGFzIENvbWJpbmVkTmFycmF0aXZlQnVpbGRlci5idWlsZCkuICovXG4gIGdldE5hcnJhdGl2ZShpbmRlbnQgPSAnICAnKTogc3RyaW5nW10ge1xuICAgIHJldHVybiB0aGlzLmVudHJpZXMubWFwKChlbnRyeSkgPT4gYCR7aW5kZW50LnJlcGVhdChlbnRyeS5kZXB0aCl9JHtlbnRyeS50ZXh0fWApO1xuICB9XG5cbiAgLyoqXG4gICAqIFJldHVybnMgZW50cmllcyBncm91cGVkIGJ5IHN1YmZsb3dJZCBmb3Igc3RydWN0dXJlZCBhY2Nlc3MuXG4gICAqIFJvb3QtbGV2ZWwgZW50cmllcyBoYXZlIHN1YmZsb3dJZCA9IHVuZGVmaW5lZC5cbiAgICovXG4gIGdldEVudHJpZXNCeVN1YmZsb3coKTogUmVjb3JkPHN0cmluZywgQ29tYmluZWROYXJyYXRpdmVFbnRyeVtdPiB7XG4gICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCBDb21iaW5lZE5hcnJhdGl2ZUVudHJ5W10+ID0geyAnJzogW10gfTtcbiAgICBmb3IgKGNvbnN0IGVudHJ5IG9mIHRoaXMuZW50cmllcykge1xuICAgICAgY29uc3Qga2V5ID0gZW50cnkuc3ViZmxvd0lkID8/ICcnO1xuICAgICAgaWYgKCFyZXN1bHRba2V5XSkgcmVzdWx0W2tleV0gPSBbXTtcbiAgICAgIHJlc3VsdFtrZXldLnB1c2goZW50cnkpO1xuICAgIH1cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLyoqIENsZWFycyBhbGwgc3RhdGUuIENhbGxlZCBhdXRvbWF0aWNhbGx5IGJlZm9yZSBlYWNoIHJ1bi4gKi9cbiAgY2xlYXIoKTogdm9pZCB7XG4gICAgdGhpcy5lbnRyaWVzID0gW107XG4gICAgdGhpcy5wZW5kaW5nT3BzLmNsZWFyKCk7XG4gICAgdGhpcy5zdGFnZUNvdW50ZXJzLmNsZWFyKCk7XG4gICAgdGhpcy5maXJzdFN0YWdlRmxhZ3MuY2xlYXIoKTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBQcml2YXRlIGhlbHBlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqIEluY3JlbWVudCBhbmQgcmV0dXJuIHRoZSBzdGFnZSBjb3VudGVyIGZvciBhIGdpdmVuIHN1YmZsb3cgKCcnID0gcm9vdCkuICovXG4gIHByaXZhdGUgaW5jcmVtZW50U3RhZ2VDb3VudGVyKHN1YmZsb3dLZXk6IHN0cmluZyk6IG51bWJlciB7XG4gICAgY29uc3QgY3VycmVudCA9IHRoaXMuc3RhZ2VDb3VudGVycy5nZXQoc3ViZmxvd0tleSkgPz8gMDtcbiAgICBjb25zdCBuZXh0ID0gY3VycmVudCArIDE7XG4gICAgdGhpcy5zdGFnZUNvdW50ZXJzLnNldChzdWJmbG93S2V5LCBuZXh0KTtcbiAgICByZXR1cm4gbmV4dDtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIHRydWUgaWYgdGhpcyBpcyB0aGUgZmlyc3Qgc3RhZ2UgZm9yIHRoZSBnaXZlbiBzdWJmbG93LCBjb25zdW1pbmcgdGhlIGZsYWcuICovXG4gIHByaXZhdGUgY29uc3VtZUZpcnN0U3RhZ2VGbGFnKHN1YmZsb3dLZXk6IHN0cmluZyk6IGJvb2xlYW4ge1xuICAgIGlmICghdGhpcy5maXJzdFN0YWdlRmxhZ3MuaGFzKHN1YmZsb3dLZXkpKSB7XG4gICAgICB0aGlzLmZpcnN0U3RhZ2VGbGFncy5zZXQoc3ViZmxvd0tleSwgZmFsc2UpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIHByaXZhdGUgYnVmZmVyT3Aoc3RhZ2VOYW1lOiBzdHJpbmcsIG9wOiBPbWl0PEJ1ZmZlcmVkT3AsICdzdGVwTnVtYmVyJz4pOiB2b2lkIHtcbiAgICBsZXQgb3BzID0gdGhpcy5wZW5kaW5nT3BzLmdldChzdGFnZU5hbWUpO1xuICAgIGlmICghb3BzKSB7XG4gICAgICBvcHMgPSBbXTtcbiAgICAgIHRoaXMucGVuZGluZ09wcy5zZXQoc3RhZ2VOYW1lLCBvcHMpO1xuICAgIH1cbiAgICBvcHMucHVzaCh7IC4uLm9wLCBzdGVwTnVtYmVyOiBvcHMubGVuZ3RoICsgMSB9KTtcbiAgfVxuXG4gIHByaXZhdGUgZmx1c2hPcHMoc3RhZ2VOYW1lOiBzdHJpbmcsIHN1YmZsb3dJZD86IHN0cmluZywgc3RhZ2VJZD86IHN0cmluZyk6IHZvaWQge1xuICAgIGNvbnN0IG9wcyA9IHRoaXMucGVuZGluZ09wcy5nZXQoc3RhZ2VOYW1lKTtcbiAgICBpZiAoIW9wcyB8fCBvcHMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgICBmb3IgKGNvbnN0IG9wIG9mIG9wcykge1xuICAgICAgY29uc3QgdmFsdWVTdW1tYXJ5ID0gdGhpcy5mb3JtYXRWYWx1ZShvcC5yYXdWYWx1ZSwgdGhpcy5tYXhWYWx1ZUxlbmd0aCk7XG4gICAgICBjb25zdCBvcEN0eDogT3BSZW5kZXJDb250ZXh0ID0ge1xuICAgICAgICB0eXBlOiBvcC50eXBlLFxuICAgICAgICBrZXk6IG9wLmtleSxcbiAgICAgICAgcmF3VmFsdWU6IG9wLnJhd1ZhbHVlLFxuICAgICAgICB2YWx1ZVN1bW1hcnksXG4gICAgICAgIG9wZXJhdGlvbjogb3Aub3BlcmF0aW9uLFxuICAgICAgICBzdGVwTnVtYmVyOiBvcC5zdGVwTnVtYmVyLFxuICAgICAgfTtcblxuICAgICAgY29uc3QgdGV4dCA9IHRoaXMucmVuZGVyZXI/LnJlbmRlck9wID8gdGhpcy5yZW5kZXJlci5yZW5kZXJPcChvcEN0eCkgOiB0aGlzLmRlZmF1bHRSZW5kZXJPcChvcEN0eCk7XG5cbiAgICAgIGlmICh0ZXh0ID09IG51bGwpIGNvbnRpbnVlOyAvLyByZW5kZXJlciBleGNsdWRlZCB0aGlzIG9wIChudWxsIG9yIHVuZGVmaW5lZClcblxuICAgICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgICB0eXBlOiAnc3RlcCcsXG4gICAgICAgIHRleHQsXG4gICAgICAgIGRlcHRoOiAxLFxuICAgICAgICBzdGFnZU5hbWUsXG4gICAgICAgIHN0YWdlSWQsXG4gICAgICAgIHN0ZXBOdW1iZXI6IG9wLnN0ZXBOdW1iZXIsXG4gICAgICAgIHN1YmZsb3dJZCxcbiAgICAgICAga2V5OiBvcC5rZXksXG4gICAgICAgIHJhd1ZhbHVlOiBvcC5yYXdWYWx1ZSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIHRoaXMucGVuZGluZ09wcy5kZWxldGUoc3RhZ2VOYW1lKTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBEZWZhdWx0IHJlbmRlcmVycyAodXNlZCB3aGVuIG5vIGN1c3RvbSByZW5kZXJlciBpcyBwcm92aWRlZCkg4pSA4pSA4pSA4pSAXG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyU3RhZ2UoY3R4OiBTdGFnZVJlbmRlckNvbnRleHQpOiBzdHJpbmcge1xuICAgIGNvbnN0IGlubmVyID0gY3R4LmlzRmlyc3RcbiAgICAgID8gY3R4LmRlc2NyaXB0aW9uXG4gICAgICAgID8gYFRoZSBwcm9jZXNzIGJlZ2FuOiAke2N0eC5kZXNjcmlwdGlvbn0uYFxuICAgICAgICA6IGBUaGUgcHJvY2VzcyBiZWdhbiB3aXRoICR7Y3R4LnN0YWdlTmFtZX0uYFxuICAgICAgOiBjdHguZGVzY3JpcHRpb25cbiAgICAgID8gYE5leHQgc3RlcDogJHtjdHguZGVzY3JpcHRpb259LmBcbiAgICAgIDogYE5leHQsIGl0IG1vdmVkIG9uIHRvICR7Y3R4LnN0YWdlTmFtZX0uYDtcbiAgICByZXR1cm4gYFN0YWdlICR7Y3R4LnN0YWdlTnVtYmVyfTogJHtpbm5lcn1gO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyT3AoY3R4OiBPcFJlbmRlckNvbnRleHQpOiBzdHJpbmcge1xuICAgIGNvbnN0IHN0ZXBQcmVmaXggPSB0aGlzLmluY2x1ZGVTdGVwTnVtYmVycyA/IGBTdGVwICR7Y3R4LnN0ZXBOdW1iZXJ9OiBgIDogJyc7XG4gICAgaWYgKGN0eC50eXBlID09PSAncmVhZCcpIHtcbiAgICAgIHJldHVybiB0aGlzLmluY2x1ZGVWYWx1ZXMgJiYgY3R4LnZhbHVlU3VtbWFyeVxuICAgICAgICA/IGAke3N0ZXBQcmVmaXh9UmVhZCAke2N0eC5rZXl9ID0gJHtjdHgudmFsdWVTdW1tYXJ5fWBcbiAgICAgICAgOiBgJHtzdGVwUHJlZml4fVJlYWQgJHtjdHgua2V5fWA7XG4gICAgfVxuICAgIGlmIChjdHgub3BlcmF0aW9uID09PSAnZGVsZXRlJykge1xuICAgICAgcmV0dXJuIGAke3N0ZXBQcmVmaXh9RGVsZXRlICR7Y3R4LmtleX1gO1xuICAgIH1cbiAgICBpZiAoY3R4Lm9wZXJhdGlvbiA9PT0gJ3VwZGF0ZScpIHtcbiAgICAgIHJldHVybiB0aGlzLmluY2x1ZGVWYWx1ZXNcbiAgICAgICAgPyBgJHtzdGVwUHJlZml4fVVwZGF0ZSAke2N0eC5rZXl9ID0gJHtjdHgudmFsdWVTdW1tYXJ5fWBcbiAgICAgICAgOiBgJHtzdGVwUHJlZml4fVVwZGF0ZSAke2N0eC5rZXl9YDtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuaW5jbHVkZVZhbHVlcyA/IGAke3N0ZXBQcmVmaXh9V3JpdGUgJHtjdHgua2V5fSA9ICR7Y3R4LnZhbHVlU3VtbWFyeX1gIDogYCR7c3RlcFByZWZpeH1Xcml0ZSAke2N0eC5rZXl9YDtcbiAgfVxuXG4gIHByaXZhdGUgZGVmYXVsdFJlbmRlckRlY2lzaW9uKGN0eDogRGVjaXNpb25SZW5kZXJDb250ZXh0KTogc3RyaW5nIHtcbiAgICBjb25zdCBicmFuY2hOYW1lID0gY3R4LmNob3NlbjtcbiAgICBsZXQgY29uZGl0aW9uVGV4dDogc3RyaW5nO1xuICAgIGlmIChjdHguZXZpZGVuY2UpIHtcbiAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tZXhwbGljaXQtYW55XG4gICAgICBjb25zdCBldmlkZW5jZSA9IGN0eC5ldmlkZW5jZSBhcyBhbnk7XG4gICAgICBjb25zdCBtYXRjaGVkUnVsZSA9IGV2aWRlbmNlLnJ1bGVzPy5maW5kKChyOiBhbnkpID0+IHIubWF0Y2hlZCk7XG4gICAgICBpZiAobWF0Y2hlZFJ1bGUpIHtcbiAgICAgICAgY29uc3QgbGFiZWwgPSBtYXRjaGVkUnVsZS5sYWJlbCA/IGAgXCIke21hdGNoZWRSdWxlLmxhYmVsfVwiYCA6ICcnO1xuICAgICAgICBpZiAobWF0Y2hlZFJ1bGUudHlwZSA9PT0gJ2ZpbHRlcicpIHtcbiAgICAgICAgICBjb25zdCBwYXJ0cyA9IG1hdGNoZWRSdWxlLmNvbmRpdGlvbnMubWFwKFxuICAgICAgICAgICAgKGM6IGFueSkgPT5cbiAgICAgICAgICAgICAgYCR7Yy5rZXl9ICR7Yy5hY3R1YWxTdW1tYXJ5fSAke2Mub3B9ICR7SlNPTi5zdHJpbmdpZnkoYy50aHJlc2hvbGQpfSAke2MucmVzdWx0ID8gJ1xcdTI3MTMnIDogJ1xcdTI3MTcnfWAsXG4gICAgICAgICAgKTtcbiAgICAgICAgICBjb25kaXRpb25UZXh0ID0gYEl0IGV2YWx1YXRlZCBSdWxlICR7bWF0Y2hlZFJ1bGUucnVsZUluZGV4fSR7bGFiZWx9OiAke3BhcnRzLmpvaW4oXG4gICAgICAgICAgICAnLCAnLFxuICAgICAgICAgICl9LCBhbmQgY2hvc2UgJHticmFuY2hOYW1lfS5gO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvbnN0IHBhcnRzID0gbWF0Y2hlZFJ1bGUuaW5wdXRzLm1hcCgoaTogYW55KSA9PiBgJHtpLmtleX09JHtpLnZhbHVlU3VtbWFyeX1gKTtcbiAgICAgICAgICBjb25kaXRpb25UZXh0ID0gYEl0IGV4YW1pbmVkJHtsYWJlbH06ICR7cGFydHMuam9pbignLCAnKX0sIGFuZCBjaG9zZSAke2JyYW5jaE5hbWV9LmA7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IGVycm9yZWRDb3VudCA9IGV2aWRlbmNlLnJ1bGVzPy5maWx0ZXIoKHI6IGFueSkgPT4gci5tYXRjaEVycm9yICE9PSB1bmRlZmluZWQpLmxlbmd0aCA/PyAwO1xuICAgICAgICBjb25zdCBlcnJvck5vdGUgPSBlcnJvcmVkQ291bnQgPiAwID8gYCAoJHtlcnJvcmVkQ291bnR9IHJ1bGUke2Vycm9yZWRDb3VudCA+IDEgPyAncycgOiAnJ30gdGhyZXcgZXJyb3JzKWAgOiAnJztcbiAgICAgICAgY29uZGl0aW9uVGV4dCA9IGBObyBydWxlcyBtYXRjaGVkJHtlcnJvck5vdGV9LCBmZWxsIGJhY2sgdG8gZGVmYXVsdDogJHticmFuY2hOYW1lfS5gO1xuICAgICAgfVxuICAgIH0gZWxzZSBpZiAoY3R4LmRlc2NyaXB0aW9uICYmIGN0eC5yYXRpb25hbGUpIHtcbiAgICAgIGNvbmRpdGlvblRleHQgPSBgSXQgJHtjdHguZGVzY3JpcHRpb259OiAke2N0eC5yYXRpb25hbGV9LCBzbyBpdCBjaG9zZSAke2JyYW5jaE5hbWV9LmA7XG4gICAgfSBlbHNlIGlmIChjdHguZGVzY3JpcHRpb24pIHtcbiAgICAgIGNvbmRpdGlvblRleHQgPSBgSXQgJHtjdHguZGVzY3JpcHRpb259IGFuZCBjaG9zZSAke2JyYW5jaE5hbWV9LmA7XG4gICAgfSBlbHNlIGlmIChjdHgucmF0aW9uYWxlKSB7XG4gICAgICBjb25kaXRpb25UZXh0ID0gYEEgZGVjaXNpb24gd2FzIG1hZGU6ICR7Y3R4LnJhdGlvbmFsZX0sIHNvIHRoZSBwYXRoIHRha2VuIHdhcyAke2JyYW5jaE5hbWV9LmA7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbmRpdGlvblRleHQgPSBgQSBkZWNpc2lvbiB3YXMgbWFkZSwgYW5kIHRoZSBwYXRoIHRha2VuIHdhcyAke2JyYW5jaE5hbWV9LmA7XG4gICAgfVxuICAgIHJldHVybiBgW0NvbmRpdGlvbl06ICR7Y29uZGl0aW9uVGV4dH1gO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyRm9yayhjdHg6IEZvcmtSZW5kZXJDb250ZXh0KTogc3RyaW5nIHtcbiAgICBjb25zdCBuYW1lcyA9IGN0eC5jaGlsZHJlbi5qb2luKCcsICcpO1xuICAgIHJldHVybiBgW1BhcmFsbGVsXTogRm9ya2luZyBpbnRvICR7Y3R4LmNoaWxkcmVuLmxlbmd0aH0gcGFyYWxsZWwgcGF0aHM6ICR7bmFtZXN9LmA7XG4gIH1cblxuICBwcml2YXRlIGRlZmF1bHRSZW5kZXJTZWxlY3RlZChjdHg6IFNlbGVjdGVkUmVuZGVyQ29udGV4dCk6IHN0cmluZyB7XG4gICAgaWYgKGN0eC5ldmlkZW5jZSkge1xuICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnlcbiAgICAgIGNvbnN0IGV2aWRlbmNlID0gY3R4LmV2aWRlbmNlIGFzIGFueTtcbiAgICAgIGNvbnN0IG1hdGNoZWQgPSBldmlkZW5jZS5ydWxlcz8uZmlsdGVyKChyOiBhbnkpID0+IHIubWF0Y2hlZCkgPz8gW107XG4gICAgICBjb25zdCBwYXJ0cyA9IG1hdGNoZWQubWFwKChyOiBhbnkpID0+IHtcbiAgICAgICAgY29uc3QgbGFiZWwgPSByLmxhYmVsID8gYCBcIiR7ci5sYWJlbH1cImAgOiAnJztcbiAgICAgICAgaWYgKHIudHlwZSA9PT0gJ2ZpbHRlcicpIHtcbiAgICAgICAgICBjb25zdCBjb25kcyA9IHIuY29uZGl0aW9uc1xuICAgICAgICAgICAgLm1hcChcbiAgICAgICAgICAgICAgKGM6IGFueSkgPT5cbiAgICAgICAgICAgICAgICBgJHtjLmtleX0gJHtjLmFjdHVhbFN1bW1hcnl9ICR7Yy5vcH0gJHtKU09OLnN0cmluZ2lmeShjLnRocmVzaG9sZCl9ICR7Yy5yZXN1bHQgPyAnXFx1MjcxMycgOiAnXFx1MjcxNyd9YCxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIC5qb2luKCcsICcpO1xuICAgICAgICAgIHJldHVybiBgJHtyLmJyYW5jaH0ke2xhYmVsfSAoJHtjb25kc30pYDtcbiAgICAgICAgfVxuICAgICAgICBjb25zdCBpbnB1dHMgPSByLmlucHV0cy5tYXAoKGk6IGFueSkgPT4gYCR7aS5rZXl9PSR7aS52YWx1ZVN1bW1hcnl9YCkuam9pbignLCAnKTtcbiAgICAgICAgcmV0dXJuIGAke3IuYnJhbmNofSR7bGFiZWx9ICgke2lucHV0c30pYDtcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuIGBbU2VsZWN0ZWRdOiAke2N0eC5zZWxlY3RlZC5sZW5ndGh9IG9mICR7Y3R4LnRvdGFsfSBwYXRocyBzZWxlY3RlZDogJHtwYXJ0cy5qb2luKCc7ICcpfS5gO1xuICAgIH1cbiAgICBjb25zdCBuYW1lcyA9IGN0eC5zZWxlY3RlZC5qb2luKCcsICcpO1xuICAgIHJldHVybiBgW1NlbGVjdGVkXTogJHtjdHguc2VsZWN0ZWQubGVuZ3RofSBvZiAke2N0eC50b3RhbH0gcGF0aHMgc2VsZWN0ZWQgZm9yIGV4ZWN1dGlvbjogJHtuYW1lc30uYDtcbiAgfVxuXG4gIHByaXZhdGUgZGVmYXVsdFJlbmRlclN1YmZsb3coY3R4OiBTdWJmbG93UmVuZGVyQ29udGV4dCk6IHN0cmluZyB7XG4gICAgaWYgKGN0eC5kaXJlY3Rpb24gPT09ICdleGl0Jykge1xuICAgICAgcmV0dXJuIGBFeGl0aW5nIHRoZSAke2N0eC5uYW1lfSBzdWJmbG93LmA7XG4gICAgfVxuICAgIHJldHVybiBjdHguZGVzY3JpcHRpb25cbiAgICAgID8gYEVudGVyaW5nIHRoZSAke2N0eC5uYW1lfSBzdWJmbG93OiAke2N0eC5kZXNjcmlwdGlvbn0uYFxuICAgICAgOiBgRW50ZXJpbmcgdGhlICR7Y3R4Lm5hbWV9IHN1YmZsb3cuYDtcbiAgfVxuXG4gIHByaXZhdGUgZGVmYXVsdFJlbmRlckxvb3AoY3R4OiBMb29wUmVuZGVyQ29udGV4dCk6IHN0cmluZyB7XG4gICAgcmV0dXJuIGN0eC5kZXNjcmlwdGlvblxuICAgICAgPyBgT24gcGFzcyAke2N0eC5pdGVyYXRpb259OiAke2N0eC5kZXNjcmlwdGlvbn0gYWdhaW4uYFxuICAgICAgOiBgT24gcGFzcyAke2N0eC5pdGVyYXRpb259IHRocm91Z2ggJHtjdHgudGFyZ2V0fS5gO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyQnJlYWsoY3R4OiBCcmVha1JlbmRlckNvbnRleHQpOiBzdHJpbmcge1xuICAgIHJldHVybiBgRXhlY3V0aW9uIHN0b3BwZWQgYXQgJHtjdHguc3RhZ2VOYW1lfS5gO1xuICB9XG5cbiAgcHJpdmF0ZSBkZWZhdWx0UmVuZGVyRXJyb3IoY3R4OiBFcnJvclJlbmRlckNvbnRleHQpOiBzdHJpbmcge1xuICAgIGxldCB0ZXh0ID0gYEFuIGVycm9yIG9jY3VycmVkIGF0ICR7Y3R4LnN0YWdlTmFtZX06ICR7Y3R4Lm1lc3NhZ2V9LmA7XG4gICAgaWYgKGN0eC52YWxpZGF0aW9uSXNzdWVzKSB7XG4gICAgICB0ZXh0ICs9IGAgVmFsaWRhdGlvbiBpc3N1ZXM6ICR7Y3R4LnZhbGlkYXRpb25Jc3N1ZXN9LmA7XG4gICAgfVxuICAgIHJldHVybiBgW0Vycm9yXTogJHt0ZXh0fWA7XG4gIH1cbn1cbiJdfQ==