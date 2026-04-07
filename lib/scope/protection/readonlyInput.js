"use strict";
/**
 * readonlyInput — Utilities for readonly input enforcement.
 *
 * Provides:
 * - assertNotReadonly(): throws if a key belongs to the readonly input
 * - deepFreeze(): recursively freezes a plain object
 * - createFrozenArgs(): creates a cached, deeply frozen copy of input values
 *
 * Used by both ScopeFacade (class-based scopes) and attachScopeMethods
 * (non-class scopes) to enforce input immutability from a single source.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFrozenArgs = exports.deepFreeze = exports.assertNotReadonly = void 0;
/**
 * Throws if `key` is an own property of `readOnlyValues`.
 * Safe against prototype pollution — uses `hasOwnProperty` on the specific object.
 */
function assertNotReadonly(readOnlyValues, key, operation) {
    if (readOnlyValues &&
        typeof readOnlyValues === 'object' &&
        Object.prototype.hasOwnProperty.call(readOnlyValues, key)) {
        if (operation === 'delete') {
            throw new Error(`Cannot delete readonly input key "${key}" — input values are immutable`);
        }
        throw new Error(`Cannot write to readonly input key "${key}" — use getArgs() to read input values`);
    }
}
exports.assertNotReadonly = assertNotReadonly;
/**
 * Recursively freezes a plain object and all nested objects/arrays.
 * Safe for POJOs — skips non-plain values (Date, RegExp, etc.).
 */
function deepFreeze(obj) {
    if (obj === null || typeof obj !== 'object')
        return obj;
    Object.freeze(obj);
    for (const key of Object.getOwnPropertyNames(obj)) {
        const val = obj[key];
        if (val && typeof val === 'object' && !Object.isFrozen(val)) {
            deepFreeze(val);
        }
    }
    return obj;
}
exports.deepFreeze = deepFreeze;
/**
 * Creates a deeply frozen shallow copy of readonly input values.
 * Returns a cached copy — call once at construction, reuse on every getArgs().
 */
function createFrozenArgs(readOnlyValues) {
    if (!readOnlyValues || typeof readOnlyValues !== 'object') {
        return Object.freeze({});
    }
    return deepFreeze({ ...readOnlyValues });
}
exports.createFrozenArgs = createFrozenArgs;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVhZG9ubHlJbnB1dC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvc2NvcGUvcHJvdGVjdGlvbi9yZWFkb25seUlucHV0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7OztHQVVHOzs7QUFFSDs7O0dBR0c7QUFDSCxTQUFnQixpQkFBaUIsQ0FBQyxjQUF1QixFQUFFLEdBQVcsRUFBRSxTQUE2QjtJQUNuRyxJQUNFLGNBQWM7UUFDZCxPQUFPLGNBQWMsS0FBSyxRQUFRO1FBQ2xDLE1BQU0sQ0FBQyxTQUFTLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxjQUFjLEVBQUUsR0FBRyxDQUFDLEVBQ3pELENBQUM7UUFDRCxJQUFJLFNBQVMsS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUMzQixNQUFNLElBQUksS0FBSyxDQUFDLHFDQUFxQyxHQUFHLGdDQUFnQyxDQUFDLENBQUM7UUFDNUYsQ0FBQztRQUNELE1BQU0sSUFBSSxLQUFLLENBQUMsdUNBQXVDLEdBQUcsd0NBQXdDLENBQUMsQ0FBQztJQUN0RyxDQUFDO0FBQ0gsQ0FBQztBQVhELDhDQVdDO0FBRUQ7OztHQUdHO0FBQ0gsU0FBZ0IsVUFBVSxDQUFJLEdBQU07SUFDbEMsSUFBSSxHQUFHLEtBQUssSUFBSSxJQUFJLE9BQU8sR0FBRyxLQUFLLFFBQVE7UUFBRSxPQUFPLEdBQUcsQ0FBQztJQUV4RCxNQUFNLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0lBRW5CLEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLG1CQUFtQixDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDbEQsTUFBTSxHQUFHLEdBQUksR0FBK0IsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNsRCxJQUFJLEdBQUcsSUFBSSxPQUFPLEdBQUcsS0FBSyxRQUFRLElBQUksQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDNUQsVUFBVSxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQ2xCLENBQUM7SUFDSCxDQUFDO0lBRUQsT0FBTyxHQUFHLENBQUM7QUFDYixDQUFDO0FBYkQsZ0NBYUM7QUFFRDs7O0dBR0c7QUFDSCxTQUFnQixnQkFBZ0IsQ0FBQyxjQUF1QjtJQUN0RCxJQUFJLENBQUMsY0FBYyxJQUFJLE9BQU8sY0FBYyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzFELE9BQU8sTUFBTSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQztJQUMzQixDQUFDO0lBQ0QsT0FBTyxVQUFVLENBQUMsRUFBRSxHQUFJLGNBQTBDLEVBQUUsQ0FBQyxDQUFDO0FBQ3hFLENBQUM7QUFMRCw0Q0FLQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogcmVhZG9ubHlJbnB1dCDigJQgVXRpbGl0aWVzIGZvciByZWFkb25seSBpbnB1dCBlbmZvcmNlbWVudC5cbiAqXG4gKiBQcm92aWRlczpcbiAqIC0gYXNzZXJ0Tm90UmVhZG9ubHkoKTogdGhyb3dzIGlmIGEga2V5IGJlbG9uZ3MgdG8gdGhlIHJlYWRvbmx5IGlucHV0XG4gKiAtIGRlZXBGcmVlemUoKTogcmVjdXJzaXZlbHkgZnJlZXplcyBhIHBsYWluIG9iamVjdFxuICogLSBjcmVhdGVGcm96ZW5BcmdzKCk6IGNyZWF0ZXMgYSBjYWNoZWQsIGRlZXBseSBmcm96ZW4gY29weSBvZiBpbnB1dCB2YWx1ZXNcbiAqXG4gKiBVc2VkIGJ5IGJvdGggU2NvcGVGYWNhZGUgKGNsYXNzLWJhc2VkIHNjb3BlcykgYW5kIGF0dGFjaFNjb3BlTWV0aG9kc1xuICogKG5vbi1jbGFzcyBzY29wZXMpIHRvIGVuZm9yY2UgaW5wdXQgaW1tdXRhYmlsaXR5IGZyb20gYSBzaW5nbGUgc291cmNlLlxuICovXG5cbi8qKlxuICogVGhyb3dzIGlmIGBrZXlgIGlzIGFuIG93biBwcm9wZXJ0eSBvZiBgcmVhZE9ubHlWYWx1ZXNgLlxuICogU2FmZSBhZ2FpbnN0IHByb3RvdHlwZSBwb2xsdXRpb24g4oCUIHVzZXMgYGhhc093blByb3BlcnR5YCBvbiB0aGUgc3BlY2lmaWMgb2JqZWN0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0Tm90UmVhZG9ubHkocmVhZE9ubHlWYWx1ZXM6IHVua25vd24sIGtleTogc3RyaW5nLCBvcGVyYXRpb246ICd3cml0ZScgfCAnZGVsZXRlJyk6IHZvaWQge1xuICBpZiAoXG4gICAgcmVhZE9ubHlWYWx1ZXMgJiZcbiAgICB0eXBlb2YgcmVhZE9ubHlWYWx1ZXMgPT09ICdvYmplY3QnICYmXG4gICAgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlYWRPbmx5VmFsdWVzLCBrZXkpXG4gICkge1xuICAgIGlmIChvcGVyYXRpb24gPT09ICdkZWxldGUnKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBkZWxldGUgcmVhZG9ubHkgaW5wdXQga2V5IFwiJHtrZXl9XCIg4oCUIGlucHV0IHZhbHVlcyBhcmUgaW1tdXRhYmxlYCk7XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IHdyaXRlIHRvIHJlYWRvbmx5IGlucHV0IGtleSBcIiR7a2V5fVwiIOKAlCB1c2UgZ2V0QXJncygpIHRvIHJlYWQgaW5wdXQgdmFsdWVzYCk7XG4gIH1cbn1cblxuLyoqXG4gKiBSZWN1cnNpdmVseSBmcmVlemVzIGEgcGxhaW4gb2JqZWN0IGFuZCBhbGwgbmVzdGVkIG9iamVjdHMvYXJyYXlzLlxuICogU2FmZSBmb3IgUE9KT3Mg4oCUIHNraXBzIG5vbi1wbGFpbiB2YWx1ZXMgKERhdGUsIFJlZ0V4cCwgZXRjLikuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBkZWVwRnJlZXplPFQ+KG9iajogVCk6IFQge1xuICBpZiAob2JqID09PSBudWxsIHx8IHR5cGVvZiBvYmogIT09ICdvYmplY3QnKSByZXR1cm4gb2JqO1xuXG4gIE9iamVjdC5mcmVlemUob2JqKTtcblxuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3QuZ2V0T3duUHJvcGVydHlOYW1lcyhvYmopKSB7XG4gICAgY29uc3QgdmFsID0gKG9iaiBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPilba2V5XTtcbiAgICBpZiAodmFsICYmIHR5cGVvZiB2YWwgPT09ICdvYmplY3QnICYmICFPYmplY3QuaXNGcm96ZW4odmFsKSkge1xuICAgICAgZGVlcEZyZWV6ZSh2YWwpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBvYmo7XG59XG5cbi8qKlxuICogQ3JlYXRlcyBhIGRlZXBseSBmcm96ZW4gc2hhbGxvdyBjb3B5IG9mIHJlYWRvbmx5IGlucHV0IHZhbHVlcy5cbiAqIFJldHVybnMgYSBjYWNoZWQgY29weSDigJQgY2FsbCBvbmNlIGF0IGNvbnN0cnVjdGlvbiwgcmV1c2Ugb24gZXZlcnkgZ2V0QXJncygpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRnJvemVuQXJncyhyZWFkT25seVZhbHVlczogdW5rbm93bik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgaWYgKCFyZWFkT25seVZhbHVlcyB8fCB0eXBlb2YgcmVhZE9ubHlWYWx1ZXMgIT09ICdvYmplY3QnKSB7XG4gICAgcmV0dXJuIE9iamVjdC5mcmVlemUoe30pO1xuICB9XG4gIHJldHVybiBkZWVwRnJlZXplKHsgLi4uKHJlYWRPbmx5VmFsdWVzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB9KTtcbn1cbiJdfQ==