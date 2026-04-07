"use strict";
/**
 * Guards — Heuristic functions for detecting input types
 *
 * Used by the registry to determine whether an input is a class constructor,
 * factory function, or ScopeFacade subclass.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSubclassOfScopeFacade = exports.looksLikeFactory = exports.looksLikeClassCtor = void 0;
const ScopeFacade_js_1 = require("../ScopeFacade.js");
/** Heuristic: class constructor vs. plain function */
function looksLikeClassCtor(fn) {
    if (typeof fn !== 'function')
        return false;
    try {
        const src = Function.prototype.toString.call(fn);
        if (/^\s*class\s/.test(src))
            return true;
    }
    catch (_a) {
        /* ignore */
    }
    const proto = fn.prototype;
    if (!proto || proto.constructor !== fn)
        return false;
    const ownNames = Object.getOwnPropertyNames(proto);
    return ownNames.length > 1;
}
exports.looksLikeClassCtor = looksLikeClassCtor;
/** Heuristic: factory function (a function that is NOT a class ctor) */
function looksLikeFactory(fn) {
    return typeof fn === 'function' && !looksLikeClassCtor(fn);
}
exports.looksLikeFactory = looksLikeFactory;
/** True iff `ctor` is a class that extends ScopeFacade (checks prototype chain) */
function isSubclassOfScopeFacade(ctor) {
    if (!looksLikeClassCtor(ctor))
        return false;
    const baseProto = ScopeFacade_js_1.ScopeFacade.prototype;
    let p = ctor.prototype;
    while (p) {
        if (p === baseProto)
            return true;
        p = Object.getPrototypeOf(p);
    }
    return false;
}
exports.isSubclassOfScopeFacade = isSubclassOfScopeFacade;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ3VhcmRzLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9zY29wZS9wcm92aWRlcnMvZ3VhcmRzLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7R0FLRzs7O0FBRUgsc0RBQWdEO0FBSWhELHNEQUFzRDtBQUN0RCxTQUFnQixrQkFBa0IsQ0FBQyxFQUFXO0lBQzVDLElBQUksT0FBTyxFQUFFLEtBQUssVUFBVTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBRTNDLElBQUksQ0FBQztRQUNILE1BQU0sR0FBRyxHQUFHLFFBQVEsQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQztRQUNqRCxJQUFJLGFBQWEsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDO1lBQUUsT0FBTyxJQUFJLENBQUM7SUFDM0MsQ0FBQztJQUFDLFdBQU0sQ0FBQztRQUNQLFlBQVk7SUFDZCxDQUFDO0lBRUQsTUFBTSxLQUFLLEdBQUksRUFBVSxDQUFDLFNBQVMsQ0FBQztJQUNwQyxJQUFJLENBQUMsS0FBSyxJQUFJLEtBQUssQ0FBQyxXQUFXLEtBQUssRUFBRTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBRXJELE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxtQkFBbUIsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUNuRCxPQUFPLFFBQVEsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO0FBQzdCLENBQUM7QUFmRCxnREFlQztBQUVELHdFQUF3RTtBQUN4RSxTQUFnQixnQkFBZ0IsQ0FBQyxFQUFXO0lBQzFDLE9BQU8sT0FBTyxFQUFFLEtBQUssVUFBVSxJQUFJLENBQUMsa0JBQWtCLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDN0QsQ0FBQztBQUZELDRDQUVDO0FBRUQsbUZBQW1GO0FBQ25GLFNBQWdCLHVCQUF1QixDQUFDLElBQWE7SUFDbkQsSUFBSSxDQUFDLGtCQUFrQixDQUFDLElBQUksQ0FBQztRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQzVDLE1BQU0sU0FBUyxHQUFHLDRCQUFXLENBQUMsU0FBUyxDQUFDO0lBQ3hDLElBQUksQ0FBQyxHQUFTLElBQVksQ0FBQyxTQUFTLENBQUM7SUFDckMsT0FBTyxDQUFDLEVBQUUsQ0FBQztRQUNULElBQUksQ0FBQyxLQUFLLFNBQVM7WUFBRSxPQUFPLElBQUksQ0FBQztRQUNqQyxDQUFDLEdBQUcsTUFBTSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMvQixDQUFDO0lBQ0QsT0FBTyxLQUFLLENBQUM7QUFDZixDQUFDO0FBVEQsMERBU0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEd1YXJkcyDigJQgSGV1cmlzdGljIGZ1bmN0aW9ucyBmb3IgZGV0ZWN0aW5nIGlucHV0IHR5cGVzXG4gKlxuICogVXNlZCBieSB0aGUgcmVnaXN0cnkgdG8gZGV0ZXJtaW5lIHdoZXRoZXIgYW4gaW5wdXQgaXMgYSBjbGFzcyBjb25zdHJ1Y3RvcixcbiAqIGZhY3RvcnkgZnVuY3Rpb24sIG9yIFNjb3BlRmFjYWRlIHN1YmNsYXNzLlxuICovXG5cbmltcG9ydCB7IFNjb3BlRmFjYWRlIH0gZnJvbSAnLi4vU2NvcGVGYWNhZGUuanMnO1xuXG50eXBlIENhbGxhYmxlRnVuY3Rpb24gPSAoLi4uYXJnczogdW5rbm93bltdKSA9PiB1bmtub3duO1xuXG4vKiogSGV1cmlzdGljOiBjbGFzcyBjb25zdHJ1Y3RvciB2cy4gcGxhaW4gZnVuY3Rpb24gKi9cbmV4cG9ydCBmdW5jdGlvbiBsb29rc0xpa2VDbGFzc0N0b3IoZm46IHVua25vd24pOiBmbiBpcyBDYWxsYWJsZUZ1bmN0aW9uIHtcbiAgaWYgKHR5cGVvZiBmbiAhPT0gJ2Z1bmN0aW9uJykgcmV0dXJuIGZhbHNlO1xuXG4gIHRyeSB7XG4gICAgY29uc3Qgc3JjID0gRnVuY3Rpb24ucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoZm4pO1xuICAgIGlmICgvXlxccypjbGFzc1xccy8udGVzdChzcmMpKSByZXR1cm4gdHJ1ZTtcbiAgfSBjYXRjaCB7XG4gICAgLyogaWdub3JlICovXG4gIH1cblxuICBjb25zdCBwcm90byA9IChmbiBhcyBhbnkpLnByb3RvdHlwZTtcbiAgaWYgKCFwcm90byB8fCBwcm90by5jb25zdHJ1Y3RvciAhPT0gZm4pIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBvd25OYW1lcyA9IE9iamVjdC5nZXRPd25Qcm9wZXJ0eU5hbWVzKHByb3RvKTtcbiAgcmV0dXJuIG93bk5hbWVzLmxlbmd0aCA+IDE7XG59XG5cbi8qKiBIZXVyaXN0aWM6IGZhY3RvcnkgZnVuY3Rpb24gKGEgZnVuY3Rpb24gdGhhdCBpcyBOT1QgYSBjbGFzcyBjdG9yKSAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxvb2tzTGlrZUZhY3RvcnkoZm46IHVua25vd24pOiBmbiBpcyBDYWxsYWJsZUZ1bmN0aW9uIHtcbiAgcmV0dXJuIHR5cGVvZiBmbiA9PT0gJ2Z1bmN0aW9uJyAmJiAhbG9va3NMaWtlQ2xhc3NDdG9yKGZuKTtcbn1cblxuLyoqIFRydWUgaWZmIGBjdG9yYCBpcyBhIGNsYXNzIHRoYXQgZXh0ZW5kcyBTY29wZUZhY2FkZSAoY2hlY2tzIHByb3RvdHlwZSBjaGFpbikgKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1N1YmNsYXNzT2ZTY29wZUZhY2FkZShjdG9yOiB1bmtub3duKTogYm9vbGVhbiB7XG4gIGlmICghbG9va3NMaWtlQ2xhc3NDdG9yKGN0b3IpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGJhc2VQcm90byA9IFNjb3BlRmFjYWRlLnByb3RvdHlwZTtcbiAgbGV0IHA6IGFueSA9IChjdG9yIGFzIGFueSkucHJvdG90eXBlO1xuICB3aGlsZSAocCkge1xuICAgIGlmIChwID09PSBiYXNlUHJvdG8pIHJldHVybiB0cnVlO1xuICAgIHAgPSBPYmplY3QuZ2V0UHJvdG90eXBlT2YocCk7XG4gIH1cbiAgcmV0dXJuIGZhbHNlO1xufVxuIl19