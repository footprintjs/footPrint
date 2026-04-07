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
import { isDevMode } from '../scope/detectCircular.js';
import { evaluateFilter } from './evaluator.js';
import { EvidenceCollector } from './evidence.js';
import { DECISION_RESULT } from './types.js';
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
        const collector = hasRecorderSupport ? new EvidenceCollector() : undefined;
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
            if (isDevMode()) {
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
            const result = evaluateFilter(resolvedValueFn, resolvedRedactedFn, rule.when);
            filterMatched = result.matched;
            filterConditions = result.conditions;
        }
        catch (e) {
            filterMatched = false;
            filterConditions = [];
            // Capture the error for debugging — surface it in evidence instead of swallowing silently
            matchError = e instanceof Error ? e.message : String(e);
            if (isDevMode()) {
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
export function decide(scope, rules, defaultBranch) {
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
            return { branch: rule.then, [DECISION_RESULT]: true, evidence };
        }
    }
    // Default: no rule matched
    const evidence = {
        rules: evaluatedRules,
        chosen: defaultBranch,
        default: defaultBranch,
    };
    return { branch: defaultBranch, [DECISION_RESULT]: true, evidence };
}
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
export function select(scope, rules) {
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
    return { branches: selectedBranches, [DECISION_RESULT]: true, evidence };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVjaWRlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9kZWNpZGUvZGVjaWRlLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7R0FTRztBQUVILE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSw0QkFBNEIsQ0FBQztBQUV2RCxPQUFPLEVBQUUsY0FBYyxFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDaEQsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0sZUFBZSxDQUFDO0FBYWxELE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFFN0MsK0VBQStFO0FBRS9FLFNBQVMsV0FBVyxDQUFDLEtBQWM7SUFDakMsTUFBTSxDQUFDLEdBQUcsS0FBZ0MsQ0FBQztJQUMzQyxJQUFJLE9BQU8sQ0FBQyxDQUFDLGVBQWUsS0FBSyxVQUFVO1FBQUUsT0FBTyxDQUFDLENBQUMsZUFBZSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM5RSxJQUFJLE9BQU8sQ0FBQyxDQUFDLGNBQWMsS0FBSyxVQUFVO1FBQUUsT0FBTyxDQUFDLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUM1RSxPQUFPLFNBQVMsQ0FBQztBQUNuQixDQUFDO0FBRUQsU0FBUyxXQUFXLENBQUMsS0FBYztJQUNqQyxNQUFNLENBQUMsR0FBRyxLQUFnQyxDQUFDO0lBQzNDLElBQUksT0FBTyxDQUFDLENBQUMsZUFBZSxLQUFLLFVBQVU7UUFBRSxPQUFPLENBQUMsQ0FBQyxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzlFLElBQUksT0FBTyxDQUFDLENBQUMsY0FBYyxLQUFLLFVBQVU7UUFBRSxPQUFPLENBQUMsQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzVFLE9BQU8sU0FBUyxDQUFDO0FBQ25CLENBQUM7QUFFRCxTQUFTLFVBQVUs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O0lBQzFDLE1BQU0sZ0JBQWdCLEdBQWEsRUFBRSxDQUFDO0lBRXRDLEtBQUssTUFBTSxDQUFDLEtBQUssRUFBRSxJQUFJLENBQUMsSUFBSSxLQUFLLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQztRQUM1QyxNQUFNLFlBQVksR0FBRyxZQUFZLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsUUFBUSxFQUFFLFFBQVEsRUFBRSxPQUFPLEVBQUUsVUFBVSxDQUFDLENBQUM7UUFDL0YsY0FBYyxDQUFDLElBQUksQ0FBQyxZQUFZLENBQUMsQ0FBQztRQUVsQyxJQUFJLFlBQVksQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUN6QixnQkFBZ0IsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQ25DLENBQUM7SUFDSCxDQUFDO0lBRUQsTUFBTSxRQUFRLEdBQXNCO1FBQ2xDLEtBQUssRUFBRSxjQUFjO1FBQ3JCLFFBQVEsRUFBRSxnQkFBZ0I7S0FDM0IsQ0FBQztJQUNGLE9BQU8sRUFBRSxRQUFRLEVBQUUsZ0JBQWdCLEVBQUUsQ0FBQyxlQUFlLENBQUMsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLENBQUM7QUFDM0UsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogZGVjaWRlL2RlY2lkZSAtLSBDb3JlIGRlY2lkZSgpIGFuZCBzZWxlY3QoKSBoZWxwZXIgZnVuY3Rpb25zLlxuICpcbiAqIGRlY2lkZSgpIGV2YWx1YXRlcyBydWxlcyBpbiBvcmRlciAoZmlyc3QtbWF0Y2gpIGFuZCByZXR1cm5zIGEgRGVjaXNpb25SZXN1bHQuXG4gKiBzZWxlY3QoKSBldmFsdWF0ZXMgQUxMIHJ1bGVzIGFuZCByZXR1cm5zIGEgU2VsZWN0aW9uUmVzdWx0IHdpdGggYWxsIG1hdGNoZXMuXG4gKlxuICogRWFjaCBydWxlJ3MgYHdoZW5gIGNhbiBiZTpcbiAqIC0gQSBmdW5jdGlvbjogKHMpID0+IHMuY3JlZGl0U2NvcmUgPiA3MDAgIChhdXRvLWNhcHR1cmVzIHJlYWRzIHZpYSB0ZW1wIHJlY29yZGVyKVxuICogLSBBIGZpbHRlcjogICB7IGNyZWRpdFNjb3JlOiB7IGd0OiA3MDAgfSB9IChjYXB0dXJlcyByZWFkcyArIG9wZXJhdG9ycyArIHRocmVzaG9sZHMpXG4gKi9cblxuaW1wb3J0IHsgaXNEZXZNb2RlIH0gZnJvbSAnLi4vc2NvcGUvZGV0ZWN0Q2lyY3VsYXIuanMnO1xuaW1wb3J0IHR5cGUgeyBSZWNvcmRlciB9IGZyb20gJy4uL3Njb3BlL3R5cGVzLmpzJztcbmltcG9ydCB7IGV2YWx1YXRlRmlsdGVyIH0gZnJvbSAnLi9ldmFsdWF0b3IuanMnO1xuaW1wb3J0IHsgRXZpZGVuY2VDb2xsZWN0b3IgfSBmcm9tICcuL2V2aWRlbmNlLmpzJztcbmltcG9ydCB0eXBlIHtcbiAgRGVjaWRlUnVsZSxcbiAgRGVjaXNpb25FdmlkZW5jZSxcbiAgRGVjaXNpb25SZXN1bHQsXG4gIEZpbHRlckNvbmRpdGlvbixcbiAgRmlsdGVyUnVsZUV2aWRlbmNlLFxuICBGdW5jdGlvblJ1bGVFdmlkZW5jZSxcbiAgUnVsZUV2aWRlbmNlLFxuICBTZWxlY3Rpb25FdmlkZW5jZSxcbiAgU2VsZWN0aW9uUmVzdWx0LFxuICBXaGVyZUZpbHRlcixcbn0gZnJvbSAnLi90eXBlcy5qcyc7XG5pbXBvcnQgeyBERUNJU0lPTl9SRVNVTFQgfSBmcm9tICcuL3R5cGVzLmpzJztcblxuLy8gLS0gU2NvcGUgYWNjZXNzb3IgaGVscGVycyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiBnZXRBdHRhY2hGbihzY29wZTogdW5rbm93bik6ICgocjogUmVjb3JkZXIpID0+IHZvaWQpIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgcyA9IHNjb3BlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBpZiAodHlwZW9mIHMuJGF0dGFjaFJlY29yZGVyID09PSAnZnVuY3Rpb24nKSByZXR1cm4gcy4kYXR0YWNoUmVjb3JkZXIuYmluZChzKTtcbiAgaWYgKHR5cGVvZiBzLmF0dGFjaFJlY29yZGVyID09PSAnZnVuY3Rpb24nKSByZXR1cm4gcy5hdHRhY2hSZWNvcmRlci5iaW5kKHMpO1xuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG5mdW5jdGlvbiBnZXREZXRhY2hGbihzY29wZTogdW5rbm93bik6ICgoaWQ6IHN0cmluZykgPT4gdm9pZCkgfCB1bmRlZmluZWQge1xuICBjb25zdCBzID0gc2NvcGUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGlmICh0eXBlb2Ygcy4kZGV0YWNoUmVjb3JkZXIgPT09ICdmdW5jdGlvbicpIHJldHVybiBzLiRkZXRhY2hSZWNvcmRlci5iaW5kKHMpO1xuICBpZiAodHlwZW9mIHMuZGV0YWNoUmVjb3JkZXIgPT09ICdmdW5jdGlvbicpIHJldHVybiBzLmRldGFjaFJlY29yZGVyLmJpbmQocyk7XG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbmZ1bmN0aW9uIGdldFZhbHVlRm4oc2NvcGU6IHVua25vd24pOiAoa2V5OiBzdHJpbmcpID0+IHVua25vd24ge1xuICBjb25zdCBzID0gc2NvcGUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIC8vIENoZWNrICRnZXRWYWx1ZSBmaXJzdDogb24gVHlwZWRTY29wZSwgYWNjZXNzaW5nIC5nZXRWYWx1ZSB0cmlnZ2VycyBhIHNwdXJpb3VzXG4gIC8vIG9uUmVhZCBmb3Iga2V5IFwiZ2V0VmFsdWVcIiB2aWEgdGhlIFByb3h5IGdldCB0cmFwLiAkZ2V0VmFsdWUgcm91dGVzIHRocm91Z2hcbiAgLy8gU0NPUEVfTUVUSE9EX05BTUVTIGFuZCBhdm9pZHMgdGhlIHN0YXRlLXJlYWQgcGF0aC5cbiAgaWYgKHR5cGVvZiBzLiRnZXRWYWx1ZSA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIHMuJGdldFZhbHVlLmJpbmQocyk7XG4gIGlmICh0eXBlb2Ygcy5nZXRWYWx1ZSA9PT0gJ2Z1bmN0aW9uJykgcmV0dXJuIHMuZ2V0VmFsdWUuYmluZChzKTtcbiAgcmV0dXJuICgpID0+IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gZ2V0UmVkYWN0ZWRGbihzY29wZTogdW5rbm93bik6IChrZXk6IHN0cmluZykgPT4gYm9vbGVhbiB7XG4gIGNvbnN0IHMgPSBzY29wZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgLy8gVHJ5ICR0b1JhdygpIGZpcnN0IChUeXBlZFNjb3BlKSwgdGhlbiBkaXJlY3RcbiAgY29uc3QgcmF3ID0gdHlwZW9mIHMuJHRvUmF3ID09PSAnZnVuY3Rpb24nID8gcy4kdG9SYXcoKSA6IHM7XG4gIGNvbnN0IHIgPSByYXcgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGlmICh0eXBlb2Ygci5nZXRSZWRhY3RlZEtleXMgPT09ICdmdW5jdGlvbicpIHtcbiAgICBjb25zdCBrZXlzID0gci5nZXRSZWRhY3RlZEtleXMoKSBhcyBTZXQ8c3RyaW5nPjtcbiAgICByZXR1cm4gKGtleTogc3RyaW5nKSA9PiBrZXlzLmhhcyhrZXkpO1xuICB9XG4gIHJldHVybiAoKSA9PiBmYWxzZTtcbn1cblxuLy8gLS0gZXZhbHVhdGUgYSBzaW5nbGUgcnVsZSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5mdW5jdGlvbiBldmFsdWF0ZVJ1bGU8UyBleHRlbmRzIG9iamVjdD4oXG4gIHNjb3BlOiBTLFxuICBydWxlOiBEZWNpZGVSdWxlPFM+LFxuICBpbmRleDogbnVtYmVyLFxuICBhdHRhY2hGbj86IChyOiBSZWNvcmRlcikgPT4gdm9pZCxcbiAgZGV0YWNoRm4/OiAoaWQ6IHN0cmluZykgPT4gdm9pZCxcbiAgdmFsdWVGbj86IChrZXk6IHN0cmluZykgPT4gdW5rbm93bixcbiAgcmVkYWN0ZWRGbj86IChrZXk6IHN0cmluZykgPT4gYm9vbGVhbixcbik6IFJ1bGVFdmlkZW5jZSB7XG4gIGlmICh0eXBlb2YgcnVsZS53aGVuID09PSAnZnVuY3Rpb24nKSB7XG4gICAgLy8gRlVOQ1RJT04gUEFUSDogdGVtcCByZWNvcmRlciBjYXB0dXJlcyByZWFkcyAobGF6eSDigJQgc2tpcCBpZiBubyByZWNvcmRlciBzdXBwb3J0KVxuICAgIGNvbnN0IGhhc1JlY29yZGVyU3VwcG9ydCA9IEJvb2xlYW4oYXR0YWNoRm4pO1xuICAgIGNvbnN0IGNvbGxlY3RvciA9IGhhc1JlY29yZGVyU3VwcG9ydCA/IG5ldyBFdmlkZW5jZUNvbGxlY3RvcigpIDogdW5kZWZpbmVkO1xuICAgIGlmIChjb2xsZWN0b3IgJiYgYXR0YWNoRm4pIGF0dGFjaEZuKGNvbGxlY3Rvcik7XG5cbiAgICBsZXQgbWF0Y2hlZDogYm9vbGVhbjtcbiAgICBsZXQgbWF0Y2hFcnJvcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAgIHRyeSB7XG4gICAgICBtYXRjaGVkID0gcnVsZS53aGVuKHNjb3BlKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBtYXRjaGVkID0gZmFsc2U7XG4gICAgICAvLyBDYXB0dXJlIHRoZSBlcnJvciBmb3IgZGVidWdnaW5nIOKAlCBzdXJmYWNlIGl0IGluIGV2aWRlbmNlIGluc3RlYWQgb2Ygc3dhbGxvd2luZyBzaWxlbnRseVxuICAgICAgbWF0Y2hFcnJvciA9IGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKTtcbiAgICAgIGlmIChpc0Rldk1vZGUoKSkge1xuICAgICAgICBjb25zdCBsYWJlbCA9IHJ1bGUubGFiZWwgPyBgICgnJHtydWxlLmxhYmVsfScpYCA6ICcnO1xuICAgICAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgbm8tY29uc29sZVxuICAgICAgICBjb25zb2xlLndhcm4oYFtmb290cHJpbnRdIGRlY2lkZSgpIHJ1bGUgJHtpbmRleH0ke2xhYmVsfSB0aHJldyBkdXJpbmcgZXZhbHVhdGlvbjogJHttYXRjaEVycm9yfWApO1xuICAgICAgfVxuICAgIH0gZmluYWxseSB7XG4gICAgICBpZiAoY29sbGVjdG9yICYmIGRldGFjaEZuKSBkZXRhY2hGbihjb2xsZWN0b3IuaWQpO1xuICAgIH1cblxuICAgIGNvbnN0IGV2aWRlbmNlOiBGdW5jdGlvblJ1bGVFdmlkZW5jZSA9IHtcbiAgICAgIHR5cGU6ICdmdW5jdGlvbicsXG4gICAgICBydWxlSW5kZXg6IGluZGV4LFxuICAgICAgYnJhbmNoOiBydWxlLnRoZW4sXG4gICAgICBtYXRjaGVkLFxuICAgICAgbGFiZWw6IHJ1bGUubGFiZWwsXG4gICAgICAvLyBQYXJ0aWFsIHJlYWRzOiBpZiBydWxlIHRocmV3IGFmdGVyIHNvbWUgZ2V0VmFsdWUoKSBjYWxscywgY29sbGVjdG9yIGhvbGRzIHJlYWRzIHVwIHRvIHRoZSB0aHJvdyBwb2ludFxuICAgICAgaW5wdXRzOiBjb2xsZWN0b3I/LmdldElucHV0cygpID8/IFtdLFxuICAgICAgLi4uKG1hdGNoRXJyb3IgIT09IHVuZGVmaW5lZCAmJiB7IG1hdGNoRXJyb3IgfSksXG4gICAgfTtcbiAgICByZXR1cm4gZXZpZGVuY2U7XG4gIH0gZWxzZSB7XG4gICAgLy8gRklMVEVSIFBBVEg6IHJlYWRzIHZhbHVlcyBkaXJlY3RseSB2aWEgY2FsbGJhY2tzIChubyByZWNvcmRlcik7IGV4Y2VwdGlvbnMgdHJlYXRlZCBhcyBub24tbWF0Y2hcbiAgICBjb25zdCByZXNvbHZlZFZhbHVlRm4gPSB2YWx1ZUZuID8/ICgoKSA9PiB1bmRlZmluZWQpO1xuICAgIGNvbnN0IHJlc29sdmVkUmVkYWN0ZWRGbiA9IHJlZGFjdGVkRm4gPz8gKCgpID0+IGZhbHNlKTtcbiAgICBsZXQgZmlsdGVyTWF0Y2hlZCA9IGZhbHNlO1xuICAgIGxldCBmaWx0ZXJDb25kaXRpb25zOiBGaWx0ZXJDb25kaXRpb25bXSA9IFtdO1xuICAgIGxldCBtYXRjaEVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGV2YWx1YXRlRmlsdGVyKHJlc29sdmVkVmFsdWVGbiwgcmVzb2x2ZWRSZWRhY3RlZEZuLCBydWxlLndoZW4gYXMgV2hlcmVGaWx0ZXI8Uz4pO1xuICAgICAgZmlsdGVyTWF0Y2hlZCA9IHJlc3VsdC5tYXRjaGVkO1xuICAgICAgZmlsdGVyQ29uZGl0aW9ucyA9IHJlc3VsdC5jb25kaXRpb25zO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGZpbHRlck1hdGNoZWQgPSBmYWxzZTtcbiAgICAgIGZpbHRlckNvbmRpdGlvbnMgPSBbXTtcbiAgICAgIC8vIENhcHR1cmUgdGhlIGVycm9yIGZvciBkZWJ1Z2dpbmcg4oCUIHN1cmZhY2UgaXQgaW4gZXZpZGVuY2UgaW5zdGVhZCBvZiBzd2FsbG93aW5nIHNpbGVudGx5XG4gICAgICBtYXRjaEVycm9yID0gZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpO1xuICAgICAgaWYgKGlzRGV2TW9kZSgpKSB7XG4gICAgICAgIGNvbnN0IGxhYmVsID0gcnVsZS5sYWJlbCA/IGAgKCcke3J1bGUubGFiZWx9JylgIDogJyc7XG4gICAgICAgIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBuby1jb25zb2xlXG4gICAgICAgIGNvbnNvbGUud2FybihgW2Zvb3RwcmludF0gZGVjaWRlKCkgZmlsdGVyIHJ1bGUgJHtpbmRleH0ke2xhYmVsfSB0aHJldyBkdXJpbmcgZXZhbHVhdGlvbjogJHttYXRjaEVycm9yfWApO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IGV2aWRlbmNlOiBGaWx0ZXJSdWxlRXZpZGVuY2UgPSB7XG4gICAgICB0eXBlOiAnZmlsdGVyJyxcbiAgICAgIHJ1bGVJbmRleDogaW5kZXgsXG4gICAgICBicmFuY2g6IHJ1bGUudGhlbixcbiAgICAgIG1hdGNoZWQ6IGZpbHRlck1hdGNoZWQsXG4gICAgICBsYWJlbDogcnVsZS5sYWJlbCxcbiAgICAgIGNvbmRpdGlvbnM6IGZpbHRlckNvbmRpdGlvbnMsXG4gICAgICAuLi4obWF0Y2hFcnJvciAhPT0gdW5kZWZpbmVkICYmIHsgbWF0Y2hFcnJvciB9KSxcbiAgICB9O1xuICAgIHJldHVybiBldmlkZW5jZTtcbiAgfVxufVxuXG4vLyAtLSBkZWNpZGUoKSAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKlxuICogRXZhbHVhdGVzIHJ1bGVzIGluIG9yZGVyIChmaXJzdC1tYXRjaCkuIFJldHVybnMgYSBicmFuZGVkIERlY2lzaW9uUmVzdWx0LlxuICpcbiAqIEBwYXJhbSBzY29wZSAtIFR5cGVkU2NvcGUgb3IgU2NvcGVGYWNhZGVcbiAqIEBwYXJhbSBydWxlcyAtIEFycmF5IG9mIERlY2lkZVJ1bGUgKGZ1bmN0aW9uIG9yIGZpbHRlciB3aGVuIGNsYXVzZXMpXG4gKiBAcGFyYW0gZGVmYXVsdEJyYW5jaCAtIEJyYW5jaCBJRCBpZiBubyBydWxlIG1hdGNoZXNcbiAqXG4gKiAqKkVycm9yIGJlaGF2aW9yOioqIElmIGEgYHdoZW5gIGZ1bmN0aW9uIHRocm93cyBkdXJpbmcgZXZhbHVhdGlvbiwgdGhlIHJ1bGUgaXNcbiAqIHRyZWF0ZWQgYXMgbm9uLW1hdGNoaW5nIChgbWF0Y2hlZDogZmFsc2VgKSBhbmQgdGhlIGVycm9yIG1lc3NhZ2UgaXMgY2FwdHVyZWQgaW5cbiAqIGBtYXRjaEVycm9yYCBvbiB0aGF0IHJ1bGUncyBgUnVsZUV2aWRlbmNlYCBlbnRyeS4gRXhlY3V0aW9uIGNvbnRpbnVlcyB3aXRoXG4gKiBzdWJzZXF1ZW50IHJ1bGVzOyBlcnJvcnMgZG8gbm90IHByb3BhZ2F0ZSB0byB0aGUgY2FsbGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZGVjaWRlPFMgZXh0ZW5kcyBvYmplY3Q+KHNjb3BlOiBTLCBydWxlczogRGVjaWRlUnVsZTxTPltdLCBkZWZhdWx0QnJhbmNoOiBzdHJpbmcpOiBEZWNpc2lvblJlc3VsdCB7XG4gIGNvbnN0IGF0dGFjaEZuID0gZ2V0QXR0YWNoRm4oc2NvcGUpO1xuICBjb25zdCBkZXRhY2hGbiA9IGdldERldGFjaEZuKHNjb3BlKTtcbiAgY29uc3QgdmFsdWVGbiA9IGdldFZhbHVlRm4oc2NvcGUpO1xuICBjb25zdCByZWRhY3RlZEZuID0gZ2V0UmVkYWN0ZWRGbihzY29wZSk7XG5cbiAgY29uc3QgZXZhbHVhdGVkUnVsZXM6IFJ1bGVFdmlkZW5jZVtdID0gW107XG5cbiAgZm9yIChjb25zdCBbaW5kZXgsIHJ1bGVdIG9mIHJ1bGVzLmVudHJpZXMoKSkge1xuICAgIGNvbnN0IHJ1bGVFdmlkZW5jZSA9IGV2YWx1YXRlUnVsZShzY29wZSwgcnVsZSwgaW5kZXgsIGF0dGFjaEZuLCBkZXRhY2hGbiwgdmFsdWVGbiwgcmVkYWN0ZWRGbik7XG4gICAgZXZhbHVhdGVkUnVsZXMucHVzaChydWxlRXZpZGVuY2UpO1xuXG4gICAgaWYgKHJ1bGVFdmlkZW5jZS5tYXRjaGVkKSB7XG4gICAgICBjb25zdCBldmlkZW5jZTogRGVjaXNpb25FdmlkZW5jZSA9IHtcbiAgICAgICAgcnVsZXM6IGV2YWx1YXRlZFJ1bGVzLFxuICAgICAgICBjaG9zZW46IHJ1bGUudGhlbixcbiAgICAgICAgZGVmYXVsdDogZGVmYXVsdEJyYW5jaCxcbiAgICAgIH07XG4gICAgICByZXR1cm4geyBicmFuY2g6IHJ1bGUudGhlbiwgW0RFQ0lTSU9OX1JFU1VMVF06IHRydWUsIGV2aWRlbmNlIH07XG4gICAgfVxuICB9XG5cbiAgLy8gRGVmYXVsdDogbm8gcnVsZSBtYXRjaGVkXG4gIGNvbnN0IGV2aWRlbmNlOiBEZWNpc2lvbkV2aWRlbmNlID0ge1xuICAgIHJ1bGVzOiBldmFsdWF0ZWRSdWxlcyxcbiAgICBjaG9zZW46IGRlZmF1bHRCcmFuY2gsXG4gICAgZGVmYXVsdDogZGVmYXVsdEJyYW5jaCxcbiAgfTtcbiAgcmV0dXJuIHsgYnJhbmNoOiBkZWZhdWx0QnJhbmNoLCBbREVDSVNJT05fUkVTVUxUXTogdHJ1ZSwgZXZpZGVuY2UgfTtcbn1cblxuLy8gLS0gc2VsZWN0KCkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKipcbiAqIEV2YWx1YXRlcyBBTEwgcnVsZXMgKG5vdCBmaXJzdC1tYXRjaCkuIFJldHVybnMgYSBicmFuZGVkIFNlbGVjdGlvblJlc3VsdC5cbiAqXG4gKiBAcGFyYW0gc2NvcGUgLSBUeXBlZFNjb3BlIG9yIFNjb3BlRmFjYWRlXG4gKiBAcGFyYW0gcnVsZXMgLSBBcnJheSBvZiBEZWNpZGVSdWxlIChmdW5jdGlvbiBvciBmaWx0ZXIgd2hlbiBjbGF1c2VzKVxuICpcbiAqICoqRXJyb3IgYmVoYXZpb3I6KiogSWYgYSBgd2hlbmAgZnVuY3Rpb24gdGhyb3dzIGR1cmluZyBldmFsdWF0aW9uLCB0aGUgcnVsZSBpc1xuICogdHJlYXRlZCBhcyBub24tbWF0Y2hpbmcgKGBtYXRjaGVkOiBmYWxzZWApIGFuZCB0aGUgZXJyb3IgbWVzc2FnZSBpcyBjYXB0dXJlZCBpblxuICogYG1hdGNoRXJyb3JgIG9uIHRoYXQgcnVsZSdzIGBSdWxlRXZpZGVuY2VgIGVudHJ5LiBFdmFsdWF0aW9uIGNvbnRpbnVlcyB3aXRoXG4gKiByZW1haW5pbmcgcnVsZXM7IGVycm9ycyBkbyBub3QgcHJvcGFnYXRlIHRvIHRoZSBjYWxsZXIuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWxlY3Q8UyBleHRlbmRzIG9iamVjdD4oc2NvcGU6IFMsIHJ1bGVzOiBEZWNpZGVSdWxlPFM+W10pOiBTZWxlY3Rpb25SZXN1bHQge1xuICBjb25zdCBhdHRhY2hGbiA9IGdldEF0dGFjaEZuKHNjb3BlKTtcbiAgY29uc3QgZGV0YWNoRm4gPSBnZXREZXRhY2hGbihzY29wZSk7XG4gIGNvbnN0IHZhbHVlRm4gPSBnZXRWYWx1ZUZuKHNjb3BlKTtcbiAgY29uc3QgcmVkYWN0ZWRGbiA9IGdldFJlZGFjdGVkRm4oc2NvcGUpO1xuXG4gIGNvbnN0IGV2YWx1YXRlZFJ1bGVzOiBSdWxlRXZpZGVuY2VbXSA9IFtdO1xuICBjb25zdCBzZWxlY3RlZEJyYW5jaGVzOiBzdHJpbmdbXSA9IFtdO1xuXG4gIGZvciAoY29uc3QgW2luZGV4LCBydWxlXSBvZiBydWxlcy5lbnRyaWVzKCkpIHtcbiAgICBjb25zdCBydWxlRXZpZGVuY2UgPSBldmFsdWF0ZVJ1bGUoc2NvcGUsIHJ1bGUsIGluZGV4LCBhdHRhY2hGbiwgZGV0YWNoRm4sIHZhbHVlRm4sIHJlZGFjdGVkRm4pO1xuICAgIGV2YWx1YXRlZFJ1bGVzLnB1c2gocnVsZUV2aWRlbmNlKTtcblxuICAgIGlmIChydWxlRXZpZGVuY2UubWF0Y2hlZCkge1xuICAgICAgc2VsZWN0ZWRCcmFuY2hlcy5wdXNoKHJ1bGUudGhlbik7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgZXZpZGVuY2U6IFNlbGVjdGlvbkV2aWRlbmNlID0ge1xuICAgIHJ1bGVzOiBldmFsdWF0ZWRSdWxlcyxcbiAgICBzZWxlY3RlZDogc2VsZWN0ZWRCcmFuY2hlcyxcbiAgfTtcbiAgcmV0dXJuIHsgYnJhbmNoZXM6IHNlbGVjdGVkQnJhbmNoZXMsIFtERUNJU0lPTl9SRVNVTFRdOiB0cnVlLCBldmlkZW5jZSB9O1xufVxuIl19