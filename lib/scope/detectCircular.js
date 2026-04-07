"use strict";
/**
 * detectCircular — Dev-mode circular reference detection for scope values.
 *
 * Checks if a value contains circular references using a WeakSet traversal.
 * O(n) where n = total nested objects. Uses WeakSet so no memory leak.
 *
 * Gated by the caller — only called in dev mode to avoid production overhead.
 * Same approach as Immer (detect and warn at runtime).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDevMode = exports.disableDevMode = exports.enableDevMode = exports.hasCircularReference = void 0;
/**
 * Returns true if the value contains circular references.
 * Only checks plain objects and arrays — class instances, Date, Map, etc. are skipped.
 */
function hasCircularReference(value, ancestors = new WeakSet()) {
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
exports.hasCircularReference = hasCircularReference;
/** Dev-mode flag — set to true to enable circular reference warnings in setValue(). */
let devModeEnabled = false;
/** Enable dev-mode circular reference detection. Call once at app startup. */
function enableDevMode() {
    devModeEnabled = true;
}
exports.enableDevMode = enableDevMode;
/** Disable dev-mode detection (default). */
function disableDevMode() {
    devModeEnabled = false;
}
exports.disableDevMode = disableDevMode;
/** Returns whether dev-mode detection is enabled. */
function isDevMode() {
    return devModeEnabled;
}
exports.isDevMode = isDevMode;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGV0ZWN0Q2lyY3VsYXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL3Njb3BlL2RldGVjdENpcmN1bGFyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7R0FRRzs7O0FBRUg7OztHQUdHO0FBQ0gsU0FBZ0Isb0JBQW9CLENBQUMsS0FBYyxFQUFFLFlBQTZCLElBQUksT0FBTyxFQUFFO0lBQzdGLElBQUksS0FBSyxLQUFLLElBQUksSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFFOUQscUZBQXFGO0lBQ3JGLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3pCLElBQUksU0FBUyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUM7WUFBRSxPQUFPLElBQUksQ0FBQztRQUN0QyxTQUFTLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3JCLEtBQUssTUFBTSxJQUFJLElBQUksS0FBSyxFQUFFLENBQUM7WUFDekIsSUFBSSxvQkFBb0IsQ0FBQyxJQUFJLEVBQUUsU0FBUyxDQUFDO2dCQUFFLE9BQU8sSUFBSSxDQUFDO1FBQ3pELENBQUM7UUFDRCxTQUFTLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsdUNBQXVDO1FBQ2hFLE9BQU8sS0FBSyxDQUFDO0lBQ2YsQ0FBQztJQUVELE1BQU0sSUFBSSxHQUFJLEtBQWlDLENBQUMsV0FBVyxDQUFDO0lBQzVELElBQUksSUFBSSxLQUFLLFNBQVMsSUFBSSxJQUFJLEtBQUssTUFBTTtRQUFFLE9BQU8sS0FBSyxDQUFDLENBQUMsd0JBQXdCO0lBRWpGLElBQUksU0FBUyxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUM7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN0QyxTQUFTLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBRXJCLEtBQUssTUFBTSxDQUFDLElBQUksTUFBTSxDQUFDLE1BQU0sQ0FBQyxLQUFnQyxDQUFDLEVBQUUsQ0FBQztRQUNoRSxJQUFJLG9CQUFvQixDQUFDLENBQUMsRUFBRSxTQUFTLENBQUM7WUFBRSxPQUFPLElBQUksQ0FBQztJQUN0RCxDQUFDO0lBQ0QsU0FBUyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLHVDQUF1QztJQUNoRSxPQUFPLEtBQUssQ0FBQztBQUNmLENBQUM7QUF6QkQsb0RBeUJDO0FBRUQsdUZBQXVGO0FBQ3ZGLElBQUksY0FBYyxHQUFHLEtBQUssQ0FBQztBQUUzQiw4RUFBOEU7QUFDOUUsU0FBZ0IsYUFBYTtJQUMzQixjQUFjLEdBQUcsSUFBSSxDQUFDO0FBQ3hCLENBQUM7QUFGRCxzQ0FFQztBQUVELDRDQUE0QztBQUM1QyxTQUFnQixjQUFjO0lBQzVCLGNBQWMsR0FBRyxLQUFLLENBQUM7QUFDekIsQ0FBQztBQUZELHdDQUVDO0FBRUQscURBQXFEO0FBQ3JELFNBQWdCLFNBQVM7SUFDdkIsT0FBTyxjQUFjLENBQUM7QUFDeEIsQ0FBQztBQUZELDhCQUVDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBkZXRlY3RDaXJjdWxhciDigJQgRGV2LW1vZGUgY2lyY3VsYXIgcmVmZXJlbmNlIGRldGVjdGlvbiBmb3Igc2NvcGUgdmFsdWVzLlxuICpcbiAqIENoZWNrcyBpZiBhIHZhbHVlIGNvbnRhaW5zIGNpcmN1bGFyIHJlZmVyZW5jZXMgdXNpbmcgYSBXZWFrU2V0IHRyYXZlcnNhbC5cbiAqIE8obikgd2hlcmUgbiA9IHRvdGFsIG5lc3RlZCBvYmplY3RzLiBVc2VzIFdlYWtTZXQgc28gbm8gbWVtb3J5IGxlYWsuXG4gKlxuICogR2F0ZWQgYnkgdGhlIGNhbGxlciDigJQgb25seSBjYWxsZWQgaW4gZGV2IG1vZGUgdG8gYXZvaWQgcHJvZHVjdGlvbiBvdmVyaGVhZC5cbiAqIFNhbWUgYXBwcm9hY2ggYXMgSW1tZXIgKGRldGVjdCBhbmQgd2FybiBhdCBydW50aW1lKS5cbiAqL1xuXG4vKipcbiAqIFJldHVybnMgdHJ1ZSBpZiB0aGUgdmFsdWUgY29udGFpbnMgY2lyY3VsYXIgcmVmZXJlbmNlcy5cbiAqIE9ubHkgY2hlY2tzIHBsYWluIG9iamVjdHMgYW5kIGFycmF5cyDigJQgY2xhc3MgaW5zdGFuY2VzLCBEYXRlLCBNYXAsIGV0Yy4gYXJlIHNraXBwZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNDaXJjdWxhclJlZmVyZW5jZSh2YWx1ZTogdW5rbm93biwgYW5jZXN0b3JzOiBXZWFrU2V0PG9iamVjdD4gPSBuZXcgV2Vha1NldCgpKTogYm9vbGVhbiB7XG4gIGlmICh2YWx1ZSA9PT0gbnVsbCB8fCB0eXBlb2YgdmFsdWUgIT09ICdvYmplY3QnKSByZXR1cm4gZmFsc2U7XG5cbiAgLy8gU2tpcCBub24tcGxhaW4gb2JqZWN0cyAoRGF0ZSwgTWFwLCBTZXQsIGNsYXNzIGluc3RhbmNlcykg4oCUIHNhbWUgYXMgYWxsb3dsaXN0IGxvZ2ljXG4gIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgIGlmIChhbmNlc3RvcnMuaGFzKHZhbHVlKSkgcmV0dXJuIHRydWU7XG4gICAgYW5jZXN0b3JzLmFkZCh2YWx1ZSk7XG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHZhbHVlKSB7XG4gICAgICBpZiAoaGFzQ2lyY3VsYXJSZWZlcmVuY2UoaXRlbSwgYW5jZXN0b3JzKSkgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIGFuY2VzdG9ycy5kZWxldGUodmFsdWUpOyAvLyBiYWNrdHJhY2sg4oCUIGFsbG93IGRpYW1vbmQgcmVmZXJlbmNlc1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGNvbnN0IGN0b3IgPSAodmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLmNvbnN0cnVjdG9yO1xuICBpZiAoY3RvciAhPT0gdW5kZWZpbmVkICYmIGN0b3IgIT09IE9iamVjdCkgcmV0dXJuIGZhbHNlOyAvLyBjbGFzcyBpbnN0YW5jZSDigJQgc2tpcFxuXG4gIGlmIChhbmNlc3RvcnMuaGFzKHZhbHVlKSkgcmV0dXJuIHRydWU7XG4gIGFuY2VzdG9ycy5hZGQodmFsdWUpO1xuXG4gIGZvciAoY29uc3QgdiBvZiBPYmplY3QudmFsdWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgIGlmIChoYXNDaXJjdWxhclJlZmVyZW5jZSh2LCBhbmNlc3RvcnMpKSByZXR1cm4gdHJ1ZTtcbiAgfVxuICBhbmNlc3RvcnMuZGVsZXRlKHZhbHVlKTsgLy8gYmFja3RyYWNrIOKAlCBhbGxvdyBkaWFtb25kIHJlZmVyZW5jZXNcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vKiogRGV2LW1vZGUgZmxhZyDigJQgc2V0IHRvIHRydWUgdG8gZW5hYmxlIGNpcmN1bGFyIHJlZmVyZW5jZSB3YXJuaW5ncyBpbiBzZXRWYWx1ZSgpLiAqL1xubGV0IGRldk1vZGVFbmFibGVkID0gZmFsc2U7XG5cbi8qKiBFbmFibGUgZGV2LW1vZGUgY2lyY3VsYXIgcmVmZXJlbmNlIGRldGVjdGlvbi4gQ2FsbCBvbmNlIGF0IGFwcCBzdGFydHVwLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVuYWJsZURldk1vZGUoKTogdm9pZCB7XG4gIGRldk1vZGVFbmFibGVkID0gdHJ1ZTtcbn1cblxuLyoqIERpc2FibGUgZGV2LW1vZGUgZGV0ZWN0aW9uIChkZWZhdWx0KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkaXNhYmxlRGV2TW9kZSgpOiB2b2lkIHtcbiAgZGV2TW9kZUVuYWJsZWQgPSBmYWxzZTtcbn1cblxuLyoqIFJldHVybnMgd2hldGhlciBkZXYtbW9kZSBkZXRlY3Rpb24gaXMgZW5hYmxlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0Rldk1vZGUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBkZXZNb2RlRW5hYmxlZDtcbn1cbiJdfQ==