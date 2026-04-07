/**
 * NullControlFlowNarrativeGenerator — Zero-cost no-op (Null Object pattern).
 *
 * When narrative is disabled, handlers call this unconditionally.
 * All methods are empty bodies — zero allocation, zero string formatting.
 * getSentences() returns a bare [] literal to avoid even a single array allocation.
 */
/* eslint-disable @typescript-eslint/no-empty-function */
export class NullControlFlowNarrativeGenerator {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTnVsbENvbnRyb2xGbG93TmFycmF0aXZlR2VuZXJhdG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvbmFycmF0aXZlL051bGxDb250cm9sRmxvd05hcnJhdGl2ZUdlbmVyYXRvci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7O0dBTUc7QUFJSCx5REFBeUQ7QUFDekQsTUFBTSxPQUFPLGlDQUFpQztJQUM1QyxlQUFlLEtBQVUsQ0FBQztJQUMxQixNQUFNLEtBQVUsQ0FBQztJQUNqQixVQUFVLEtBQVUsQ0FBQztJQUNyQixNQUFNLEtBQVUsQ0FBQztJQUNqQixVQUFVLEtBQVUsQ0FBQztJQUNyQixjQUFjLEtBQVUsQ0FBQztJQUN6QixhQUFhLEtBQVUsQ0FBQztJQUN4QixtQkFBbUIsS0FBVSxDQUFDO0lBQzlCLE1BQU0sS0FBVSxDQUFDO0lBQ2pCLE9BQU8sS0FBVSxDQUFDO0lBQ2xCLE9BQU8sS0FBVSxDQUFDO0lBQ2xCLE9BQU8sS0FBVSxDQUFDO0lBQ2xCLFFBQVEsS0FBVSxDQUFDO0lBQ25CLFlBQVk7UUFDVixPQUFPLEVBQUUsQ0FBQztJQUNaLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTnVsbENvbnRyb2xGbG93TmFycmF0aXZlR2VuZXJhdG9yIOKAlCBaZXJvLWNvc3Qgbm8tb3AgKE51bGwgT2JqZWN0IHBhdHRlcm4pLlxuICpcbiAqIFdoZW4gbmFycmF0aXZlIGlzIGRpc2FibGVkLCBoYW5kbGVycyBjYWxsIHRoaXMgdW5jb25kaXRpb25hbGx5LlxuICogQWxsIG1ldGhvZHMgYXJlIGVtcHR5IGJvZGllcyDigJQgemVybyBhbGxvY2F0aW9uLCB6ZXJvIHN0cmluZyBmb3JtYXR0aW5nLlxuICogZ2V0U2VudGVuY2VzKCkgcmV0dXJucyBhIGJhcmUgW10gbGl0ZXJhbCB0byBhdm9pZCBldmVuIGEgc2luZ2xlIGFycmF5IGFsbG9jYXRpb24uXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBJQ29udHJvbEZsb3dOYXJyYXRpdmUgfSBmcm9tICcuL3R5cGVzLmpzJztcblxuLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLWVtcHR5LWZ1bmN0aW9uICovXG5leHBvcnQgY2xhc3MgTnVsbENvbnRyb2xGbG93TmFycmF0aXZlR2VuZXJhdG9yIGltcGxlbWVudHMgSUNvbnRyb2xGbG93TmFycmF0aXZlIHtcbiAgb25TdGFnZUV4ZWN1dGVkKCk6IHZvaWQge31cbiAgb25OZXh0KCk6IHZvaWQge31cbiAgb25EZWNpc2lvbigpOiB2b2lkIHt9XG4gIG9uRm9yaygpOiB2b2lkIHt9XG4gIG9uU2VsZWN0ZWQoKTogdm9pZCB7fVxuICBvblN1YmZsb3dFbnRyeSgpOiB2b2lkIHt9XG4gIG9uU3ViZmxvd0V4aXQoKTogdm9pZCB7fVxuICBvblN1YmZsb3dSZWdpc3RlcmVkKCk6IHZvaWQge31cbiAgb25Mb29wKCk6IHZvaWQge31cbiAgb25CcmVhaygpOiB2b2lkIHt9XG4gIG9uRXJyb3IoKTogdm9pZCB7fVxuICBvblBhdXNlKCk6IHZvaWQge31cbiAgb25SZXN1bWUoKTogdm9pZCB7fVxuICBnZXRTZW50ZW5jZXMoKTogc3RyaW5nW10ge1xuICAgIHJldHVybiBbXTtcbiAgfVxufVxuIl19