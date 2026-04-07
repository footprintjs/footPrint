"use strict";
/**
 * decide/decide -- Core decide() and select() helper functions.
 *
 * decide() evaluates rules in order (first-match) and returns a DecisionResult.
 * select() evaluates ALL rules and returns a SelectionResult with all matches.
 *
 * Each rule's `when` can be:
 * - A function: (s) => s.creditScore > 700  (auto-captures reads via temp recorder)
 * - A filter:   { creditScore: { gt: 700 } } (captures reads + operators + thresholds)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.select = exports.decide = void 0;
const detectCircular_js_1 = require("../scope/detectCircular.js");
const evaluator_js_1 = require("./evaluator.js");
const evidence_js_1 = require("./evidence.js");
const types_js_1 = require("./types.js");
// -- Scope accessor helpers --------------------------------------------------
function getAttachFn(scope) {
    const s = scope;
    if (typeof s.$attachRecorder === 'function')
        return s.$attachRecorder.bind(s);
    if (typeof s.attachRecorder === 'function')
        return s.attachRecorder.bind(s);
    return undefined;
}
function getDetachFn(scope) {
    const s = scope;
    if (typeof s.$detachRecorder === 'function')
        return s.$detachRecorder.bind(s);
    if (typeof s.detachRecorder === 'function')
        return s.detachRecorder.bind(s);
    return undefined;
}
function getValueFn(scope) {
    const s = scope;
    // Check $getValue first: on TypedScope, accessing .getValue triggers a spurious
    // onRead for key "getValue" via the Proxy get trap. $getValue routes through
    // SCOPE_METHOD_NAMES and avoids the state-read path.
    if (typeof s.$getValue === 'function')
        return s.$getValue.bind(s);
    if (typeof s.getValue === 'function')
        return s.getValue.bind(s);
    return () => undefined;
}
function getRedactedFn(scope) {
    const s = scope;
    // Try $toRaw() first (TypedScope), then direct
    const raw = typeof s.$toRaw === 'function' ? s.$toRaw() : s;
    const r = raw;
    if (typeof r.getRedactedKeys === 'function') {
        const keys = r.getRedactedKeys();
        return (key) => keys.has(key);
    }
    return () => false;
}
// -- evaluate a single rule --------------------------------------------------
function evaluateRule(scope, rule, index, attachFn, detachFn, valueFn, redactedFn) {
    var _a;
    if (typeof rule.when === 'function') {
        // FUNCTION PATH: temp recorder captures reads (lazy — skip if no recorder support)
        const hasRecorderSupport = Boolean(attachFn);
        const collector = hasRecorderSupport ? new evidence_js_1.EvidenceCollector() : undefined;
        if (collector && attachFn)
            attachFn(collector);
        let matched;
        let matchError;
        try {
            matched = rule.when(scope);
        }
        catch (e) {
            matched = false;
            // Capture the error for debugging — surface it in evidence instead of swallowing silently
            matchError = e instanceof Error ? e.message : String(e);
            if ((0, detectCircular_js_1.isDevMode)()) {
                const label = rule.label ? ` ('${rule.label}')` : '';
                // eslint-disable-next-line no-console
                console.warn(`[footprint] decide() rule ${index}${label} threw during evaluation: ${matchError}`);
            }
        }
        finally {
            if (collector && detachFn)
                detachFn(collector.id);
        }
        const evidence = {
            type: 'function',
            ruleIndex: index,
            branch: rule.then,
            matched,
            label: rule.label,
            // Partial reads: if rule threw after some getValue() calls, collector holds reads up to the throw point
            inputs: (_a = collector === null || collector === void 0 ? void 0 : collector.getInputs()) !== null && _a !== void 0 ? _a : [],
            ...(matchError !== undefined && { matchError }),
        };
        return evidence;
    }
    else {
        // FILTER PATH: reads values directly via callbacks (no recorder); exceptions treated as non-match
        const resolvedValueFn = valueFn !== null && valueFn !== void 0 ? valueFn : (() => undefined);
        const resolvedRedactedFn = redactedFn !== null && redactedFn !== void 0 ? redactedFn : (() => false);
        let filterMatched = false;
        let filterConditions = [];
        let matchError;
        try {
            const result = (0, evaluator_js_1.evaluateFilter)(resolvedValueFn, resolvedRedactedFn, rule.when);
            filterMatched = result.matched;
            filterConditions = result.conditions;
        }
        catch (e) {
            filterMatched = false;
            filterConditions = [];
            // Capture the error for debugging — surface it in evidence instead of swallowing silently
            matchError = e instanceof Error ? e.message : String(e);
            if ((0, detectCircular_js_1.isDevMode)()) {
                const label = rule.label ? ` ('${rule.label}')` : '';
                // eslint-disable-next-line no-console
                console.warn(`[footprint] decide() filter rule ${index}${label} threw during evaluation: ${matchError}`);
            }
        }
        const evidence = {
            type: 'filter',
            ruleIndex: index,
            branch: rule.then,
            matched: filterMatched,
            label: rule.label,
            conditions: filterConditions,
            ...(matchError !== undefined && { matchError }),
        };
        return evidence;
    }
}
// -- decide() ----------------------------------------------------------------
/**
 * Evaluates rules in order (first-match). Returns a branded DecisionResult.
 *
 * @param scope - TypedScope or ScopeFacade
 * @param rules - Array of DecideRule (function or filter when clauses)
 * @param defaultBranch - Branch ID if no rule matches
 *
 * **Error behavior:** If a `when` function throws during evaluation, the rule is
 * treated as non-matching (`matched: false`) and the error message is captured in
 * `matchError` on that rule's `RuleEvidence` entry. Execution continues with
 * subsequent rules; errors do not propagate to the caller.
 */
function decide(scope, rules, defaultBranch) {
    const attachFn = getAttachFn(scope);
    const detachFn = getDetachFn(scope);
    const valueFn = getValueFn(scope);
    const redactedFn = getRedactedFn(scope);
    const evaluatedRules = [];
    for (const [index, rule] of rules.entries()) {
        const ruleEvidence = evaluateRule(scope, rule, index, attachFn, detachFn, valueFn, redactedFn);
        evaluatedRules.push(ruleEvidence);
        if (ruleEvidence.matched) {
            const evidence = {
                rules: evaluatedRules,
                chosen: rule.then,
                default: defaultBranch,
            };
            return { branch: rule.then, [types_js_1.DECISION_RESULT]: true, evidence };
        }
    }
    // Default: no rule matched
    const evidence = {
        rules: evaluatedRules,
        chosen: defaultBranch,
        default: defaultBranch,
    };
    return { branch: defaultBranch, [types_js_1.DECISION_RESULT]: true, evidence };
}
exports.decide = decide;
// -- select() ----------------------------------------------------------------
/**
 * Evaluates ALL rules (not first-match). Returns a branded SelectionResult.
 *
 * @param scope - TypedScope or ScopeFacade
 * @param rules - Array of DecideRule (function or filter when clauses)
 *
 * **Error behavior:** If a `when` function throws during evaluation, the rule is
 * treated as non-matching (`matched: false`) and the error message is captured in
 * `matchError` on that rule's `RuleEvidence` entry. Evaluation continues with
 * remaining rules; errors do not propagate to the caller.
 */
function select(scope, rules) {
    const attachFn = getAttachFn(scope);
    const detachFn = getDetachFn(scope);
    const valueFn = getValueFn(scope);
    const redactedFn = getRedactedFn(scope);
    const evaluatedRules = [];
    const selectedBranches = [];
    for (const [index, rule] of rules.entries()) {
        const ruleEvidence = evaluateRule(scope, rule, index, attachFn, detachFn, valueFn, redactedFn);
        evaluatedRules.push(ruleEvidence);
        if (ruleEvidence.matched) {
            selectedBranches.push(rule.then);
        }
    }
    const evidence = {
        rules: evaluatedRules,
        selected: selectedBranches,
    };
    return { branches: selectedBranches, [types_js_1.DECISION_RESULT]: true, evidence };
}
exports.select = select;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVjaWRlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vc3JjL2xpYi9kZWNpZGUvZGVjaWRlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7O0dBU0c7OztBQUVILGtFQUF1RDtBQUV2RCxpREFBZ0Q7QUFDaEQsK0NBQWtEO0FBYWxELHlDQUE2QztBQUU3QywrRUFBK0U7QUFFL0UsU0FBUyxXQUFXLENBQUMsS0FBYztJQUNqQyxNQUFNLENBQUMsR0FBRyxLQUFnQyxDQUFDO0lBQzNDLElBQUksT0FBTyxDQUFDLENBQUMsZUFBZSxLQUFLLFVBQVU7UUFBRSxPQUFPLENBQUMsQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzlFLElBQUksT0FBTyxDQUFDLENBQUMsY0FBYyxLQUFLLFVBQVU7UUFBRSxPQUFPLENBQUMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzVFLE9BQU8sU0FBUyxDQUFDO0FBQ25CLENBQUM7QUFFRCxTQUFTLFdBQVcsQ0FBQyxLQUFjO0lBQ2pDLE1BQU0sQ0FBQyxHQUFHLEtBQWdDLENBQUM7SUFDM0MsSUFBSSxPQUFPLENBQUMsQ0FBQyxlQUFlLEtBQUssVUFBVTtRQUFFLE9BQU8sQ0FBQyxDQUFDLGVBQWUsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDOUUsSUFBSSxPQUFPLENBQUMsQ0FBQyxjQUFjLEtBQUssVUFBVTtRQUFFLE9BQU8sQ0FBQyxDQUFDLGNBQWMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDNUUsT0FBTyxTQUFTLENBQUM7QUFDbkIsQ0FBQztBQUVELFNBQVMsVUFBVSxDQUFDLEtBQWM7SUFDaEMsTUFBTSxDQUFDLEdBQUcsS0FBZ0MsQ0FBQztJQUMzQyxnRkFBZ0Y7SUFDaEYsNkVBQTZFO0lBQzdFLHFEQUFxRDtJQUNyRCxJQUFJLE9BQU8sQ0FBQyxDQUFDLFNBQVMsS0FBSyxV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TyxFQUFFLEVBQUUsQ0FBQztRQUM1QyxNQUFNLFlBQVksR0FBRyxZQUFZLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFDL0YsY0FBYyxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUVsQyxJQUFJLFlBQVksQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUN6QixnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ25DLENBQUM7SUFDSCxDQUFDO0lBRUQsTUFBTSxRQUFRLEdBQXNCO1FBQ2xDLEtBQUssRUFBRSxjQUFjO1FBQ3JCLFFBQVEsRUFBRSxnQkFBZ0I7S0FDM0IsQ0FBQztJQUNGLE9BQU8sRUFBRSxRQUFRLEVBQUUsZ0JBQWdCLEVBQUUsQ0FBQywwQkFBZSxDQUFDLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxDQUFDO0FBQzNFLENBQUM7QUF2QkQsd0JBdUJDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBkZWNpZGUvZGVjaWRlIC0tIENvcmUgZGVjaWRlKCkgYW5kIHNlbGVjdCgpIGhlbHBlciBmdW5jdGlvbnMuXG4gKlxuICogZGVjaWRlKCkgZXZhbHVhdGVzIHJ1bGVzIGluIG9yZGVyIChmaXJzdC1tYXRjaCkgYW5kIHJldHVybnMgYSBEZWNpc2lvblJlc3VsdC5cbiAqIHNlbGVjdCgpIGV2YWx1YXRlcyBBTEwgcnVsZXMgYW5kIHJldHVybnMgYSBTZWxlY3Rpb25SZXN1bHQgd2l0aCBhbGwgbWF0Y2hlcy5cbiAqXG4gKiBFYWNoIHJ1bGUncyBgd2hlbmAgY2FuIGJlOlxuICogLSBBIGZ1bmN0aW9uOiAocykgPT4gcy5jcmVkaXRTY29yZSA+IDcwMCAgKGF1dG8tY2FwdHVyZXMgcmVhZHMgdmlhIHRlbXAgcmVjb3JkZXIpXG4gKiAtIEEgZmlsdGVyOiAgIHsgY3JlZGl0U2NvcmU6IHsgZ3Q6IDcwMCB9IH0gKGNhcHR1cmVzIHJlYWRzICsgb3BlcmF0b3JzICsgdGhyZXNob2xkcylcbiAqL1xuXG5pbXBvcnQgeyBpc0Rldk1vZGUgfSBmcm9tICcuLi9zY29wZS9kZXRlY3RDaXJjdWxhci5qcyc7XG5pbXBvcnQgdHlwZSB7IFJlY29yZGVyIH0gZnJvbSAnLi4vc2NvcGUvdHlwZXMuanMnO1xuaW1wb3J0IHsgZXZhbHVhdGVGaWx0ZXIgfSBmcm9tICcuL2V2YWx1YXRvci5qcyc7XG5pbXBvcnQgeyBFdmlkZW5jZUNvbGxlY3RvciB9IGZyb20gJy4vZXZpZGVuY2UuanMnO1xuaW1wb3J0IHR5cGUge1xuICBEZWNpZGVSdWxlLFxuICBEZWNpc2lvbkV2aWRlbmNlLFxuICBEZWNpc2lvblJlc3VsdCxcbiAgRmlsdGVyQ29uZGl0aW9uLFxuICBGaWx0ZXJSdWxlRXZpZGVuY2UsXG4gIEZ1bmN0aW9uUnVsZUV2aWRlbmNlLFxuICBSdWxlRXZpZGVuY2UsXG4gIFNlbGVjdGlvbkV2aWRlbmNlLFxuICBTZWxlY3Rpb25SZXN1bHQsXG4gIFdoZXJlRmlsdGVyLFxufSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB7IERFQ0lTSU9OX1JFU1VMVCB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyAtLSBTY29wZSBhY2Nlc3NvciBoZWxwZXJzIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGdldEF0dGFjaEZuKHNjb3BlOiB1bmtub3duKTogKChyOiBSZWNvcmRlcikgPT4gdm9pZCkgfCB1bmRlZmluZWQge1xuICBjb25zdCBzID0gc2NvcGUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGlmICh0eXBlb2Ygcy4kYXR0YWNoUmVjb3JkZXIgPT09ICdmdW5jdGlvbicpIHJldHVybiBzLiRhdHRhY2hSZWNvcmRlci5iaW5kKHMpO1xuICBpZiAodHlwZW9mIHMuYXR0YWNoUmVjb3JkZXIgPT09ICdmdW5jdGlvbicpIHJldHVybiBzLmF0dGFjaFJlY29yZGVyLmJpbmQocyk7XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGdldERldGFjaEZuKHNjb3BlOiB1bmtub3duKTogKChpZDogc3RyaW5nKSA9PiB2b2lkKSB8IHVuZGVmaW5lZCB7XG4gIGNvbnN0IHMgPSBzY29wZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgaWYgKHR5cGVvZiBzLiRkZXRhY2hSZWNvcmRlciA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIHMuJGRldGFjaFJlY29yZGVyLmJpbmQocyk7XG4gIGlmICh0eXBlb2Ygcy5kZXRhY2hSZWNvcmRlciA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIHMuZGV0YWNoUmVjb3JkZXIuYmluZChzKTtcbiAgcmV0dXJuIHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gZ2V0VmFsdWVGbihzY29wZTogdW5rbm93bik6IChrZXk6IHN0cmluZykgPT4gdW5rbm93biB7XG4gIGNvbnN0IHMgPSBzY29wZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgLy8gQ2hlY2sgJGdldFZhbHVlIGZpcnN0OiBvbiBUeXBlZFNjb3BlLCBhY2Nlc3NpbmcgLmdldFZhbHVlIHRyaWdnZXJzIGEgc3B1cmlvdXNcbiAgLy8gb25SZWFkIGZvciBrZXkgXCJnZXRWYWx1ZVwiIHZpYSB0aGUgUHJveHkgZ2V0IHRyYXAuICRnZXRWYWx1ZSByb3V0ZXMgdGhyb3VnaFxuICAvLyBTQ09QRV9NRVRIT0RfTkFNRVMgYW5kIGF2b2lkcyB0aGUgc3RhdGUtcmVhZCBwYXRoLlxuICBpZiAodHlwZW9mIHMuJGdldFZhbHVlID09PSAnZnVuY3Rpb24nKSByZXR1cm4gcy4kZ2V0VmFsdWUuYmluZChzKTtcbiAgaWYgKHR5cGVvZiBzLmdldFZhbHVlID09PSAnZnVuY3Rpb24nKSByZXR1cm4gcy5nZXRWYWx1ZS5iaW5kKHMpO1xuICByZXR1cm4gKCkgPT4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBnZXRSZWRhY3RlZEZuKHNjb3BlOiB1bmtub3duKTogKGtleTogc3RyaW5nKSA9PiBib29sZWFuIHtcbiAgY29uc3QgcyA9IHNjb3BlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAvLyBUcnkgJHRvUmF3KCkgZmlyc3QgKFR5cGVkU2NvcGUpLCB0aGVuIGRpcmVjdFxuICBjb25zdCByYXcgPSB0eXBlb2Ygcy4kdG9SYXcgPT09ICdmdW5jdGlvbicgPyBzLiR0b1JhdygpIDogcztcbiAgY29uc3QgciA9IHJhdyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgaWYgKHR5cGVvZiByLmdldFJlZGFjdGVkS2V5cyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGNvbnN0IGtleXMgPSByLmdldFJlZGFjdGVkS2V5cygpIGFzIFNldDxzdHJpbmc+O1xuICAgIHJldHVybiAoa2V5OiBzdHJpbmcpID0+IGtleXMuaGFzKGtleSk7XG4gIH1cbiAgcmV0dXJuICgpID0+IGZhbHNlO1xufVxuXG4vLyAtLSBldmFsdWF0ZSBhIHNpbmdsZSBydWxlIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGV2YWx1YXRlUnVsZTxTIGV4dGVuZHMgb2JqZWN0PihcbiAgc2NvcGU6IFMsXG4gIHJ1bGU6IERlY2lkZVJ1bGU8Uz4sXG4gIGluZGV4OiBudW1iZXIsXG4gIGF0dGFjaEZuPzogKHI6IFJlY29yZGVyKSA9PiB2b2lkLFxuICBkZXRhY2hGbj86IChpZDogc3RyaW5nKSA9PiB2b2lkLFxuICB2YWx1ZUZuPzogKGtleTogc3RyaW5nKSA9PiB1bmtub3duLFxuICByZWRhY3RlZEZuPzogKGtleTogc3RyaW5nKSA9PiBib29sZWFuLFxuKTogUnVsZUV2aWRlbmNlIHtcbiAgaWYgKHR5cGVvZiBydWxlLndoZW4gPT09ICdmdW5jdGlvbicpIHtcbiAgICAvLyBGVU5DVElPTiBQQVRIOiB0ZW1wIHJlY29yZGVyIGNhcHR1cmVzIHJlYWRzIChsYXp5IOKAlCBza2lwIGlmIG5vIHJlY29yZGVyIHN1cHBvcnQpXG4gICAgY29uc3QgaGFzUmVjb3JkZXJTdXBwb3J0ID0gQm9vbGVhbihhdHRhY2hGbik7XG4gICAgY29uc3QgY29sbGVjdG9yID0gaGFzUmVjb3JkZXJTdXBwb3J0ID8gbmV3IEV2aWRlbmNlQ29sbGVjdG9yKCkgOiB1bmRlZmluZWQ7XG4gICAgaWYgKGNvbGxlY3RvciAmJiBhdHRhY2hGbikgYXR0YWNoRm4oY29sbGVjdG9yKTtcblxuICAgIGxldCBtYXRjaGVkOiBib29sZWFuO1xuICAgIGxldCBtYXRjaEVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIG1hdGNoZWQgPSBydWxlLndoZW4oc2NvcGUpO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIG1hdGNoZWQgPSBmYWxzZTtcbiAgICAgIC8vIENhcHR1cmUgdGhlIGVycm9yIGZvciBkZWJ1Z2dpbmcg4oCUIHN1cmZhY2UgaXQgaW4gZXZpZGVuY2UgaW5zdGVhZCBvZiBzd2FsbG93aW5nIHNpbGVudGx5XG4gICAgICBtYXRjaEVycm9yID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgICAgaWYgKGlzRGV2TW9kZSgpKSB7XG4gICAgICAgIGNvbnN0IGxhYmVsID0gcnVsZS5sYWJlbCA/IGAgKCcke3J1bGUubGFiZWx9JylgIDogJyc7XG4gICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICAgIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gZGVjaWRlKCkgcnVsZSAke2luZGV4fSR7bGFiZWx9IHRocmV3IGR1cmluZyBldmFsdWF0aW9uOiAke21hdGNoRXJyb3J9YCk7XG4gICAgICB9XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmIChjb2xsZWN0b3IgJiYgZGV0YWNoRm4pIGRldGFjaEZuKGNvbGxlY3Rvci5pZCk7XG4gICAgfVxuXG4gICAgY29uc3QgZXZpZGVuY2U6IEZ1bmN0aW9uUnVsZUV2aWRlbmNlID0ge1xuICAgICAgdHlwZTogJ2Z1bmN0aW9uJyxcbiAgICAgIHJ1bGVJbmRleDogaW5kZXgsXG4gICAgICBicmFuY2g6IHJ1bGUudGhlbixcbiAgICAgIG1hdGNoZWQsXG4gICAgICBsYWJlbDogcnVsZS5sYWJlbCxcbiAgICAgIC8vIFBhcnRpYWwgcmVhZHM6IGlmIHJ1bGUgdGhyZXcgYWZ0ZXIgc29tZSBnZXRWYWx1ZSgpIGNhbGxzLCBjb2xsZWN0b3IgaG9sZHMgcmVhZHMgdXAgdG8gdGhlIHRocm93IHBvaW50XG4gICAgICBpbnB1dHM6IGNvbGxlY3Rvcj8uZ2V0SW5wdXRzKCkgPz8gW10sXG4gICAgICAuLi4obWF0Y2hFcnJvciAhPT0gdW5kZWZpbmVkICYmIHsgbWF0Y2hFcnJvciB9KSxcbiAgICB9O1xuICAgIHJldHVybiBldmlkZW5jZTtcbiAgfSBlbHNlIHtcbiAgICAvLyBGSUxURVIgUEFUSDogcmVhZHMgdmFsdWVzIGRpcmVjdGx5IHZpYSBjYWxsYmFja3MgKG5vIHJlY29yZGVyKTsgZXhjZXB0aW9ucyB0cmVhdGVkIGFzIG5vbi1tYXRjaFxuICAgIGNvbnN0IHJlc29sdmVkVmFsdWVGbiA9IHZhbHVlRm4gPz8gKCgpID0+IHVuZGVmaW5lZCk7XG4gICAgY29uc3QgcmVzb2x2ZWRSZWRhY3RlZEZuID0gcmVkYWN0ZWRGbiA/PyAoKCkgPT4gZmFsc2UpO1xuICAgIGxldCBmaWx0ZXJNYXRjaGVkID0gZmFsc2U7XG4gICAgbGV0IGZpbHRlckNvbmRpdGlvbnM6IEZpbHRlckNvbmRpdGlvbltdID0gW107XG4gICAgbGV0IG1hdGNoRXJyb3I6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gZXZhbHVhdGVGaWx0ZXIocmVzb2x2ZWRWYWx1ZUZuLCByZXNvbHZlZFJlZGFjdGVkRm4sIHJ1bGUud2hlbiBhcyBXaGVyZUZpbHRlcjxTPik7XG4gICAgICBmaWx0ZXJNYXRjaGVkID0gcmVzdWx0Lm1hdGNoZWQ7XG4gICAgICBmaWx0ZXJDb25kaXRpb25zID0gcmVzdWx0LmNvbmRpdGlvbnM7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgZmlsdGVyTWF0Y2hlZCA9IGZhbHNlO1xuICAgICAgZmlsdGVyQ29uZGl0aW9ucyA9IFtdO1xuICAgICAgLy8gQ2FwdHVyZSB0aGUgZXJyb3IgZm9yIGRlYnVnZ2luZyDigJQgc3VyZmFjZSBpdCBpbiBldmlkZW5jZSBpbnN0ZWFkIG9mIHN3YWxsb3dpbmcgc2lsZW50bHlcbiAgICAgIG1hdGNoRXJyb3IgPSBlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSk7XG4gICAgICBpZiAoaXNEZXZNb2RlKCkpIHtcbiAgICAgICAgY29uc3QgbGFiZWwgPSBydWxlLmxhYmVsID8gYCAoJyR7cnVsZS5sYWJlbH0nKWAgOiAnJztcbiAgICAgICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIG5vLWNvbnNvbGVcbiAgICAgICAgY29uc29sZS53YXJuKGBbZm9vdHByaW50XSBkZWNpZGUoKSBmaWx0ZXIgcnVsZSAke2luZGV4fSR7bGFiZWx9IHRocmV3IGR1cmluZyBldmFsdWF0aW9uOiAke21hdGNoRXJyb3J9YCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgZXZpZGVuY2U6IEZpbHRlclJ1bGVFdmlkZW5jZSA9IHtcbiAgICAgIHR5cGU6ICdmaWx0ZXInLFxuICAgICAgcnVsZUluZGV4OiBpbmRleCxcbiAgICAgIGJyYW5jaDogcnVsZS50aGVuLFxuICAgICAgbWF0Y2hlZDogZmlsdGVyTWF0Y2hlZCxcbiAgICAgIGxhYmVsOiBydWxlLmxhYmVsLFxuICAgICAgY29uZGl0aW9uczogZmlsdGVyQ29uZGl0aW9ucyxcbiAgICAgIC4uLihtYXRjaEVycm9yICE9PSB1bmRlZmluZWQgJiYgeyBtYXRjaEVycm9yIH0pLFxuICAgIH07XG4gICAgcmV0dXJuIGV2aWRlbmNlO1xuICB9XG59XG5cbi8vIC0tIGRlY2lkZSgpIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cblxuLyoqXG4gKiBFdmFsdWF0ZXMgcnVsZXMgaW4gb3JkZXIgKGZpcnN0LW1hdGNoKS4gUmV0dXJucyBhIGJyYW5kZWQgRGVjaXNpb25SZXN1bHQuXG4gKlxuICogQHBhcmFtIHNjb3BlIC0gVHlwZWRTY29wZSBvciBTY29wZUZhY2FkZVxuICogQHBhcmFtIHJ1bGVzIC0gQXJyYXkgb2YgRGVjaWRlUnVsZSAoZnVuY3Rpb24gb3IgZmlsdGVyIHdoZW4gY2xhdXNlcylcbiAqIEBwYXJhbSBkZWZhdWx0QnJhbmNoIC0gQnJhbmNoIElEIGlmIG5vIHJ1bGUgbWF0Y2hlc1xuICpcbiAqICoqRXJyb3IgYmVoYXZpb3I6KiogSWYgYSBgd2hlbmAgZnVuY3Rpb24gdGhyb3dzIGR1cmluZyBldmFsdWF0aW9uLCB0aGUgcnVsZSBpc1xuICogdHJlYXRlZCBhcyBub24tbWF0Y2hpbmcgKGBtYXRjaGVkOiBmYWxzZWApIGFuZCB0aGUgZXJyb3IgbWVzc2FnZSBpcyBjYXB0dXJlZCBpblxuICogYG1hdGNoRXJyb3JgIG9uIHRoYXQgcnVsZSdzIGBSdWxlRXZpZGVuY2VgIGVudHJ5LiBFeGVjdXRpb24gY29udGludWVzIHdpdGhcbiAqIHN1YnNlcXVlbnQgcnVsZXM7IGVycm9ycyBkbyBub3QgcHJvcGFnYXRlIHRvIHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWNpZGU8UyBleHRlbmRzIG9iamVjdD4oc2NvcGU6IFMsIHJ1bGVzOiBEZWNpZGVSdWxlPFM+W10sIGRlZmF1bHRCcmFuY2g6IHN0cmluZyk6IERlY2lzaW9uUmVzdWx0IHtcbiAgY29uc3QgYXR0YWNoRm4gPSBnZXRBdHRhY2hGbihzY29wZSk7XG4gIGNvbnN0IGRldGFjaEZuID0gZ2V0RGV0YWNoRm4oc2NvcGUpO1xuICBjb25zdCB2YWx1ZUZuID0gZ2V0VmFsdWVGbihzY29wZSk7XG4gIGNvbnN0IHJlZGFjdGVkRm4gPSBnZXRSZWRhY3RlZEZuKHNjb3BlKTtcblxuICBjb25zdCBldmFsdWF0ZWRSdWxlczogUnVsZUV2aWRlbmNlW10gPSBbXTtcblxuICBmb3IgKGNvbnN0IFtpbmRleCwgcnVsZV0gb2YgcnVsZXMuZW50cmllcygpKSB7XG4gICAgY29uc3QgcnVsZUV2aWRlbmNlID0gZXZhbHVhdGVSdWxlKHNjb3BlLCBydWxlLCBpbmRleCwgYXR0YWNoRm4sIGRldGFjaEZuLCB2YWx1ZUZuLCByZWRhY3RlZEZuKTtcbiAgICBldmFsdWF0ZWRSdWxlcy5wdXNoKHJ1bGVFdmlkZW5jZSk7XG5cbiAgICBpZiAocnVsZUV2aWRlbmNlLm1hdGNoZWQpIHtcbiAgICAgIGNvbnN0IGV2aWRlbmNlOiBEZWNpc2lvbkV2aWRlbmNlID0ge1xuICAgICAgICBydWxlczogZXZhbHVhdGVkUnVsZXMsXG4gICAgICAgIGNob3NlbjogcnVsZS50aGVuLFxuICAgICAgICBkZWZhdWx0OiBkZWZhdWx0QnJhbmNoLFxuICAgICAgfTtcbiAgICAgIHJldHVybiB7IGJyYW5jaDogcnVsZS50aGVuLCBbREVDSVNJT05fUkVTVUxUXTogdHJ1ZSwgZXZpZGVuY2UgfTtcbiAgICB9XG4gIH1cblxuICAvLyBEZWZhdWx0OiBubyBydWxlIG1hdGNoZWRcbiAgY29uc3QgZXZpZGVuY2U6IERlY2lzaW9uRXZpZGVuY2UgPSB7XG4gICAgcnVsZXM6IGV2YWx1YXRlZFJ1bGVzLFxuICAgIGNob3NlbjogZGVmYXVsdEJyYW5jaCxcbiAgICBkZWZhdWx0OiBkZWZhdWx0QnJhbmNoLFxuICB9O1xuICByZXR1cm4geyBicmFuY2g6IGRlZmF1bHRCcmFuY2gsIFtERUNJU0lPTl9SRVNVTFRdOiB0cnVlLCBldmlkZW5jZSB9O1xufVxuXG4vLyAtLSBzZWxlY3QoKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogRXZhbHVhdGVzIEFMTCBydWxlcyAobm90IGZpcnN0LW1hdGNoKS4gUmV0dXJucyBhIGJyYW5kZWQgU2VsZWN0aW9uUmVzdWx0LlxuICpcbiAqIEBwYXJhbSBzY29wZSAtIFR5cGVkU2NvcGUgb3IgU2NvcGVGYWNhZGVcbiAqIEBwYXJhbSBydWxlcyAtIEFycmF5IG9mIERlY2lkZVJ1bGUgKGZ1bmN0aW9uIG9yIGZpbHRlciB3aGVuIGNsYXVzZXMpXG4gKlxuICogKipFcnJvciBiZWhhdmlvcjoqKiBJZiBhIGB3aGVuYCBmdW5jdGlvbiB0aHJvd3MgZHVyaW5nIGV2YWx1YXRpb24sIHRoZSBydWxlIGlzXG4gKiB0cmVhdGVkIGFzIG5vbi1tYXRjaGluZyAoYG1hdGNoZWQ6IGZhbHNlYCkgYW5kIHRoZSBlcnJvciBtZXNzYWdlIGlzIGNhcHR1cmVkIGluXG4gKiBgbWF0Y2hFcnJvcmAgb24gdGhhdCBydWxlJ3MgYFJ1bGVFdmlkZW5jZWAgZW50cnkuIEV2YWx1YXRpb24gY29udGludWVzIHdpdGhcbiAqIHJlbWFpbmluZyBydWxlczsgZXJyb3JzIGRvIG5vdCBwcm9wYWdhdGUgdG8gdGhlIGNhbGxlci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNlbGVjdDxTIGV4dGVuZHMgb2JqZWN0PihzY29wZTogUywgcnVsZXM6IERlY2lkZVJ1bGU8Uz5bXSk6IFNlbGVjdGlvblJlc3VsdCB7XG4gIGNvbnN0IGF0dGFjaEZuID0gZ2V0QXR0YWNoRm4oc2NvcGUpO1xuICBjb25zdCBkZXRhY2hGbiA9IGdldERldGFjaEZuKHNjb3BlKTtcbiAgY29uc3QgdmFsdWVGbiA9IGdldFZhbHVlRm4oc2NvcGUpO1xuICBjb25zdCByZWRhY3RlZEZuID0gZ2V0UmVkYWN0ZWRGbihzY29wZSk7XG5cbiAgY29uc3QgZXZhbHVhdGVkUnVsZXM6IFJ1bGVFdmlkZW5jZVtdID0gW107XG4gIGNvbnN0IHNlbGVjdGVkQnJhbmNoZXM6IHN0cmluZ1tdID0gW107XG5cbiAgZm9yIChjb25zdCBbaW5kZXgsIHJ1bGVdIG9mIHJ1bGVzLmVudHJpZXMoKSkge1xuICAgIGNvbnN0IHJ1bGVFdmlkZW5jZSA9IGV2YWx1YXRlUnVsZShzY29wZSwgcnVsZSwgaW5kZXgsIGF0dGFjaEZuLCBkZXRhY2hGbiwgdmFsdWVGbiwgcmVkYWN0ZWRGbik7XG4gICAgZXZhbHVhdGVkUnVsZXMucHVzaChydWxlRXZpZGVuY2UpO1xuXG4gICAgaWYgKHJ1bGVFdmlkZW5jZS5tYXRjaGVkKSB7XG4gICAgICBzZWxlY3RlZEJyYW5jaGVzLnB1c2gocnVsZS50aGVuKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBldmlkZW5jZTogU2VsZWN0aW9uRXZpZGVuY2UgPSB7XG4gICAgcnVsZXM6IGV2YWx1YXRlZFJ1bGVzLFxuICAgIHNlbGVjdGVkOiBzZWxlY3RlZEJyYW5jaGVzLFxuICB9O1xuICByZXR1cm4geyBicmFuY2hlczogc2VsZWN0ZWRCcmFuY2hlcywgW0RFQ0lTSU9OX1JFU1VMVF06IHRydWUsIGV2aWRlbmNlIH07XG59XG4iXX0=