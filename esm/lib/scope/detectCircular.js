/**
 * detectCircular — Dev-mode circular reference detection for scope values.
 *
 * Checks if a value contains circular references using a WeakSet traversal.
 * O(n) where n = total nested objects. Uses WeakSet so no memory leak.
 *
 * Gated by the caller — only called in dev mode to avoid production overhead.
 * Same approach as Immer (detect and warn at runtime).
 */
/**
 * Returns true if the value contains circular references.
 * Only checks plain objects and arrays — class instances, Date, Map, etc. are skipped.
 */
export function hasCircularReference(value, ancestors = new WeakSet()) {
    if (value === null || typeof value !== 'object')
        return false;
    // Skip non-plain objects (Date, Map, Set, class instances) — same as allowlist logic
    if (Array.isArray(value)) {
        if (ancestors.has(value))
            return true;
        ancestors.add(value);
        for (const item of value) {
            if (hasCircularReference(item, ancestors))
                return true;
        }
        ancestors.delete(value); // backtrack — allow diamond references
        return false;
    }
    const ctor = value.constructor;
    if (ctor !== undefined && ctor !== Object)
        return false; // class instance — skip
    if (ancestors.has(value))
        return true;
    ancestors.add(value);
    for (const v of Object.values(value)) {
        if (hasCircularReference(v, ancestors))
            return true;
    }
    ancestors.delete(value); // backtrack — allow diamond references
    return false;
}
/** Dev-mode flag — set to true to enable circular reference warnings in setValue(). */
let devModeEnabled = false;
/** Enable dev-mode circular reference detection. Call once at app startup. */
export function enableDevMode() {
    devModeEnabled = true;
}
/** Disable dev-mode detection (default). */
export function disableDevMode() {
    devModeEnabled = false;
}
/** Returns whether dev-mode detection is enabled. */
export function isDevMode() {
    return devModeEnabled;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGV0ZWN0Q2lyY3VsYXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL2RldGVjdENpcmN1bGFyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7OztHQVFHO0FBRUg7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLG9CQUFvQixDQUFDLEtBQWMsRUFBRSxZQUE2QixJQUFJLE9BQU8sRUFBRTtJQUM3RixJQUFJLEtBQUssS0FBSyxJQUFJLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBRTlELHFGQUFxRjtJQUNyRixJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUN6QixJQUFJLFNBQVMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFDdEMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNyQixLQUFLLE1BQU0sSUFBSSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ3pCLElBQUksb0JBQW9CLENBQUMsSUFBSSxFQUFFLFNBQVMsQ0FBQztnQkFBRSxPQUFPLElBQUksQ0FBQztRQUN6RCxDQUFDO1FBQ0QsU0FBUyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLHVDQUF1QztRQUNoRSxPQUFPLEtBQUssQ0FBQztJQUNmLENBQUM7SUFFRCxNQUFNLElBQUksR0FBSSxLQUFpQyxDQUFDLFdBQVcsQ0FBQztJQUM1RCxJQUFJLElBQUksS0FBSyxTQUFTLElBQUksSUFBSSxLQUFLLE1BQU07UUFBRSxPQUFPLEtBQUssQ0FBQyxDQUFDLHdCQUF3QjtJQUVqRixJQUFJLFNBQVMsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDdEMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUVyQixLQUFLLE1BQU0sQ0FBQyxJQUFJLE1BQU0sQ0FBQyxNQUFNLENBQUMsS0FBZ0MsQ0FBQyxFQUFFLENBQUM7UUFDaEUsSUFBSSxvQkFBb0IsQ0FBQyxDQUFDLEVBQUUsU0FBUyxDQUFDO1lBQUUsT0FBTyxJQUFJLENBQUM7SUFDdEQsQ0FBQztJQUNELFNBQVMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyx1Q0FBdUM7SUFDaEUsT0FBTyxLQUFLLENBQUM7QUFDZixDQUFDO0FBRUQsdUZBQXVGO0FBQ3ZGLElBQUksY0FBYyxHQUFHLEtBQUssQ0FBQztBQUUzQiw4RUFBOEU7QUFDOUUsTUFBTSxVQUFVLGFBQWE7SUFDM0IsY0FBYyxHQUFHLElBQUksQ0FBQztBQUN4QixDQUFDO0FBRUQsNENBQTRDO0FBQzVDLE1BQU0sVUFBVSxjQUFjO0lBQzVCLGNBQWMsR0FBRyxLQUFLLENBQUM7QUFDekIsQ0FBQztBQUVELHFEQUFxRDtBQUNyRCxNQUFNLFVBQVUsU0FBUztJQUN2QixPQUFPLGNBQWMsQ0FBQztBQUN4QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBkZXRlY3RDaXJjdWxhciDigJQgRGV2LW1vZGUgY2lyY3VsYXIgcmVmZXJlbmNlIGRldGVjdGlvbiBmb3Igc2NvcGUgdmFsdWVzLlxuICpcbiAqIENoZWNrcyBpZiBhIHZhbHVlIGNvbnRhaW5zIGNpcmN1bGFyIHJlZmVyZW5jZXMgdXNpbmcgYSBXZWFrU2V0IHRyYXZlcnNhbC5cbiAqIE8obikgd2hlcmUgbiA9IHRvdGFsIG5lc3RlZCBvYmplY3RzLiBVc2VzIFdlYWtTZXQgc28gbm8gbWVtb3J5IGxlYWsuXG4gKlxuICogR2F0ZWQgYnkgdGhlIGNhbGxlciDigJQgb25seSBjYWxsZWQgaW4gZGV2IG1vZGUgdG8gYXZvaWQgcHJvZHVjdGlvbiBvdmVyaGVhZC5cbiAqIFNhbWUgYXBwcm9hY2ggYXMgSW1tZXIgKGRldGVjdCBhbmQgd2FybiBhdCBydW50aW1lKS5cbiAqL1xuXG4vKipcbiAqIFJldHVybnMgdHJ1ZSBpZiB0aGUgdmFsdWUgY29udGFpbnMgY2lyY3VsYXIgcmVmZXJlbmNlcy5cbiAqIE9ubHkgY2hlY2tzIHBsYWluIG9iamVjdHMgYW5kIGFycmF5cyDigJQgY2xhc3MgaW5zdGFuY2VzLCBEYXRlLCBNYXAsIGV0Yy4gYXJlIHNraXBwZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNDaXJjdWxhclJlZmVyZW5jZSh2YWx1ZTogdW5rbm93biwgYW5jZXN0b3JzOiBXZWFrU2V0PG9iamVjdD4gPSBuZXcgV2Vha1NldCgpKTogYm9vbGVhbiB7XG4gIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gU2tpcCBub24tcGxhaW4gb2JqZWN0cyAoRGF0ZSwgTWFwLCBTZXQsIGNsYXNzIGluc3RhbmNlcykg4oCUIHNhbWUgYXMgYWxsb3dsaXN0IGxvZ2ljXG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgIGlmIChhbmNlc3RvcnMuaGFzKHZhbHVlKSkgcmV0dXJuIHRydWU7XG4gICAgYW5jZXN0b3JzLmFkZCh2YWx1ZSk7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHZhbHVlKSB7XG4gICAgICBpZiAoaGFzQ2lyY3VsYXJSZWZlcmVuY2UoaXRlbSwgYW5jZXN0b3JzKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGFuY2VzdG9ycy5kZWxldGUodmFsdWUpOyAvLyBiYWNrdHJhY2sg4oCUIGFsbG93IGRpYW1vbmQgcmVmZXJlbmNlc1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGNvbnN0IGN0b3IgPSAodmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLmNvbnN0cnVjdG9yO1xuICBpZiAoY3RvciAhPT0gdW5kZWZpbmVkICYmIGN0b3IgIT09IE9iamVjdCkgcmV0dXJuIGZhbHNlOyAvLyBjbGFzcyBpbnN0YW5jZSDigJQgc2tpcFxuXG4gIGlmIChhbmNlc3RvcnMuaGFzKHZhbHVlKSkgcmV0dXJuIHRydWU7XG4gIGFuY2VzdG9ycy5hZGQodmFsdWUpO1xuXG4gIGZvciAoY29uc3QgdiBvZiBPYmplY3QudmFsdWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgIGlmIChoYXNDaXJjdWxhclJlZmVyZW5jZSh2LCBhbmNlc3RvcnMpKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICBhbmNlc3RvcnMuZGVsZXRlKHZhbHVlKTsgLy8gYmFja3RyYWNrIOKAlCBhbGxvdyBkaWFtb25kIHJlZmVyZW5jZXNcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKiogRGV2LW1vZGUgZmxhZyDigJQgc2V0IHRvIHRydWUgdG8gZW5hYmxlIGNpcmN1bGFyIHJlZmVyZW5jZSB3YXJuaW5ncyBpbiBzZXRWYWx1ZSgpLiAqL1xubGV0IGRldk1vZGVFbmFibGVkID0gZmFsc2U7XG5cbi8qKiBFbmFibGUgZGV2LW1vZGUgY2lyY3VsYXIgcmVmZXJlbmNlIGRldGVjdGlvbi4gQ2FsbCBvbmNlIGF0IGFwcCBzdGFydHVwLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuYWJsZURldk1vZGUoKTogdm9pZCB7XG4gIGRldk1vZGVFbmFibGVkID0gdHJ1ZTtcbn1cblxuLyoqIERpc2FibGUgZGV2LW1vZGUgZGV0ZWN0aW9uIChkZWZhdWx0KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaXNhYmxlRGV2TW9kZSgpOiB2b2lkIHtcbiAgZGV2TW9kZUVuYWJsZWQgPSBmYWxzZTtcbn1cblxuLyoqIFJldHVybnMgd2hldGhlciBkZXYtbW9kZSBkZXRlY3Rpb24gaXMgZW5hYmxlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0Rldk1vZGUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBkZXZNb2RlRW5hYmxlZDtcbn1cbiJdfQ==