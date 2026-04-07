"use strict";
/**
 * NullControlFlowNarrativeGenerator — Zero-cost no-op (Null Object pattern).
 *
 * When narrative is disabled, handlers call this unconditionally.
 * All methods are empty bodies — zero allocation, zero string formatting.
 * getSentences() returns a bare [] literal to avoid even a single array allocation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NullControlFlowNarrativeGenerator = void 0;
/* eslint-disable @typescript-eslint/no-empty-function */
class NullControlFlowNarrativeGenerator {
    onStageExecuted() { }
    onNext() { }
    onDecision() { }
    onFork() { }
    onSelected() { }
    onSubflowEntry() { }
    onSubflowExit() { }
    onSubflowRegistered() { }
    onLoop() { }
    onBreak() { }
    onError() { }
    onPause() { }
    onResume() { }
    getSentences() {
        return [];
    }
}
exports.NullControlFlowNarrativeGenerator = NullControlFlowNarrativeGenerator;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTnVsbENvbnRyb2xGbG93TmFycmF0aXZlR2VuZXJhdG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvbmFycmF0aXZlL051bGxDb250cm9sRmxvd05hcnJhdGl2ZUdlbmVyYXRvci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7OztHQU1HOzs7QUFJSCx5REFBeUQ7QUFDekQsTUFBYSxpQ0FBaUM7SUFDNUMsZUFBZSxLQUFVLENBQUM7SUFDMUIsTUFBTSxLQUFVLENBQUM7SUFDakIsVUFBVSxLQUFVLENBQUM7SUFDckIsTUFBTSxLQUFVLENBQUM7SUFDakIsVUFBVSxLQUFVLENBQUM7SUFDckIsY0FBYyxLQUFVLENBQUM7SUFDekIsYUFBYSxLQUFVLENBQUM7SUFDeEIsbUJBQW1CLEtBQVUsQ0FBQztJQUM5QixNQUFNLEtBQVUsQ0FBQztJQUNqQixPQUFPLEtBQVUsQ0FBQztJQUNsQixPQUFPLEtBQVUsQ0FBQztJQUNsQixPQUFPLEtBQVUsQ0FBQztJQUNsQixRQUFRLEtBQVUsQ0FBQztJQUNuQixZQUFZO1FBQ1YsT0FBTyxFQUFFLENBQUM7SUFDWixDQUFDO0NBQ0Y7QUFqQkQsOEVBaUJDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBOdWxsQ29udHJvbEZsb3dOYXJyYXRpdmVHZW5lcmF0b3Ig4oCUIFplcm8tY29zdCBuby1vcCAoTnVsbCBPYmplY3QgcGF0dGVybikuXG4gKlxuICogV2hlbiBuYXJyYXRpdmUgaXMgZGlzYWJsZWQsIGhhbmRsZXJzIGNhbGwgdGhpcyB1bmNvbmRpdGlvbmFsbHkuXG4gKiBBbGwgbWV0aG9kcyBhcmUgZW1wdHkgYm9kaWVzIOKAlCB6ZXJvIGFsbG9jYXRpb24sIHplcm8gc3RyaW5nIGZvcm1hdHRpbmcuXG4gKiBnZXRTZW50ZW5jZXMoKSByZXR1cm5zIGEgYmFyZSBbXSBsaXRlcmFsIHRvIGF2b2lkIGV2ZW4gYSBzaW5nbGUgYXJyYXkgYWxsb2NhdGlvbi5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IElDb250cm9sRmxvd05hcnJhdGl2ZSB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vKiBlc2xpbnQtZGlzYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tZW1wdHktZnVuY3Rpb24gKi9cbmV4cG9ydCBjbGFzcyBOdWxsQ29udHJvbEZsb3dOYXJyYXRpdmVHZW5lcmF0b3IgaW1wbGVtZW50cyBJQ29udHJvbEZsb3dOYXJyYXRpdmUge1xuICBvblN0YWdlRXhlY3V0ZWQoKTogdm9pZCB7fVxuICBvbk5leHQoKTogdm9pZCB7fVxuICBvbkRlY2lzaW9uKCk6IHZvaWQge31cbiAgb25Gb3JrKCk6IHZvaWQge31cbiAgb25TZWxlY3RlZCgpOiB2b2lkIHt9XG4gIG9uU3ViZmxvd0VudHJ5KCk6IHZvaWQge31cbiAgb25TdWJmbG93RXhpdCgpOiB2b2lkIHt9XG4gIG9uU3ViZmxvd1JlZ2lzdGVyZWQoKTogdm9pZCB7fVxuICBvbkxvb3AoKTogdm9pZCB7fVxuICBvbkJyZWFrKCk6IHZvaWQge31cbiAgb25FcnJvcigpOiB2b2lkIHt9XG4gIG9uUGF1c2UoKTogdm9pZCB7fVxuICBvblJlc3VtZSgpOiB2b2lkIHt9XG4gIGdldFNlbnRlbmNlcygpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG59XG4iXX0=