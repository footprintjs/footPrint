/**
 * CompositeRecorder — fan-out a single recorder attachment to multiple child recorders.
 *
 * Implements both Recorder (scope data ops) and FlowRecorder (control flow events)
 * so it works with both `executor.attachRecorder()` and `executor.attachFlowRecorder()`.
 *
 * The composite has a single ID for idempotent attach/detach. Child recorders
 * keep their own IDs internally but are not individually visible to the executor.
 *
 * Domain libraries (e.g., agentfootprint) use this to bundle multiple recorders
 * into a single preset — the consumer calls one function, gets full observability.
 *
 * @example
 * ```typescript
 * import { CompositeRecorder, MetricRecorder, DebugRecorder } from 'footprintjs';
 *
 * // Bundle metrics + debug into a single recorder
 * const observability = new CompositeRecorder('observability', [
 *   new MetricRecorder({ stageFilter: (name) => name === 'CallLLM' }),
 *   new DebugRecorder({ verbosity: 'minimal' }),
 * ]);
 *
 * executor.attachRecorder(observability);
 *
 * // Access child recorders by type
 * const metrics = observability.get(MetricRecorder);
 * metrics?.getMetrics(); // timing data
 * ```
 *
 * @example
 * ```typescript
 * // Domain library preset (e.g., agentfootprint)
 * export function agentObservability(options?: AgentObservabilityOptions) {
 *   return new CompositeRecorder('agent-observability', [
 *     new MetricRecorder(options?.stageFilter ? { stageFilter: options.stageFilter } : undefined),
 *     new TokenRecorder(),
 *     new ToolUsageRecorder(),
 *   ]);
 * }
 *
 * // Consumer
 * executor.attachRecorder(agentObservability());
 * ```
 */
export class CompositeRecorder {
    constructor(id, children) {
        this.id = id;
        this.children = [...children];
    }
    // ── Child access ──────────────────────────────────────────────────────
    /**
     * Get a child recorder by class type.
     *
     * @example
     * ```typescript
     * const metrics = composite.get(MetricRecorder);
     * ```
     */
    get(type) {
        return this.children.find((c) => c instanceof type);
    }
    /** Get all child recorders. */
    getChildren() {
        return this.children;
    }
    // ── Scope Recorder hooks (fan-out to children that implement Recorder) ─
    onRead(event) {
        for (const c of this.children)
            if (c.onRead)
                c.onRead(event);
    }
    onWrite(event) {
        for (const c of this.children)
            if (c.onWrite)
                c.onWrite(event);
    }
    onCommit(event) {
        for (const c of this.children)
            if (c.onCommit)
                c.onCommit(event);
    }
    onError(event) {
        for (const c of this.children)
            if (c.onError)
                c.onError(event);
    }
    onStageStart(event) {
        for (const c of this.children)
            if (c.onStageStart)
                c.onStageStart(event);
    }
    onStageEnd(event) {
        for (const c of this.children)
            if (c.onStageEnd)
                c.onStageEnd(event);
    }
    // ── FlowRecorder hooks (fan-out to children that implement FlowRecorder) ─
    onStageExecuted(event) {
        for (const c of this.children)
            if (c.onStageExecuted)
                c.onStageExecuted(event);
    }
    onNext(event) {
        for (const c of this.children)
            if (c.onNext)
                c.onNext(event);
    }
    onDecision(event) {
        for (const c of this.children)
            if (c.onDecision)
                c.onDecision(event);
    }
    onFork(event) {
        for (const c of this.children)
            if (c.onFork)
                c.onFork(event);
    }
    onSelected(event) {
        for (const c of this.children)
            if (c.onSelected)
                c.onSelected(event);
    }
    onSubflowEntry(event) {
        for (const c of this.children)
            if (c.onSubflowEntry)
                c.onSubflowEntry(event);
    }
    onSubflowExit(event) {
        for (const c of this.children)
            if (c.onSubflowExit)
                c.onSubflowExit(event);
    }
    onSubflowRegistered(event) {
        for (const c of this.children)
            if (c.onSubflowRegistered)
                c.onSubflowRegistered(event);
    }
    onLoop(event) {
        for (const c of this.children)
            if (c.onLoop)
                c.onLoop(event);
    }
    onBreak(event) {
        for (const c of this.children)
            if (c.onBreak)
                c.onBreak(event);
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────
    clear() {
        for (const c of this.children)
            if (c.clear)
                c.clear();
    }
    /**
     * Snapshot merges all child snapshots into a single composite entry.
     * Each child's snapshot is preserved with its own id/name/data.
     */
    toSnapshot() {
        const childSnapshots = [];
        for (const c of this.children) {
            if (c.toSnapshot) {
                const { name, data } = c.toSnapshot();
                childSnapshots.push({ id: c.id, name, data });
            }
        }
        return {
            name: 'Composite',
            data: { children: childSnapshots },
        };
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ29tcG9zaXRlUmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3JlY29yZGVyL0NvbXBvc2l0ZVJlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBMkNHO0FBeUJILE1BQU0sT0FBTyxpQkFBaUI7SUFJNUIsWUFBWSxFQUFVLEVBQUUsUUFBd0M7UUFDOUQsSUFBSSxDQUFDLEVBQUUsR0FBRyxFQUFFLENBQUM7UUFDYixJQUFJLENBQUMsUUFBUSxHQUFHLENBQUMsR0FBRyxRQUFRLENBQUMsQ0FBQztJQUNoQyxDQUFDO0lBRUQseUVBQXlFO0lBRXpFOzs7Ozs7O09BT0c7SUFDSCxHQUFHLENBQUksSUFBK0I7UUFDcEMsT0FBTyxJQUFJLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxFQUFFLENBQUMsQ0FBQyxZQUFZLElBQUksQ0FBa0IsQ0FBQztJQUN2RSxDQUFDO0lBRUQsK0JBQStCO0lBQy9CLFdBQVc7UUFDVCxPQUFPLElBQUksQ0FBQyxRQUFRLENBQUM7SUFDdkIsQ0FBQztJQUVELDBFQUEwRTtJQUUxRSxNQUFNLENBQUMsS0FBZ0I7UUFDckIsS0FBSyxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsUUFBUTtZQUFFLElBQUssQ0FBYyxDQUFDLE1BQU07Z0JBQUcsQ0FBYyxDQUFDLE1BQU8sQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM1RixDQUFDO0lBRUQsT0FBTyxDQUFDLEtBQWlCO1FBQ3ZCLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVE7WUFBRSxJQUFLLENBQWMsQ0FBQyxPQUFPO2dCQUFHLENBQWMsQ0FBQyxPQUFRLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDOUYsQ0FBQztJQUVELFFBQVEsQ0FBQyxLQUFrQjtRQUN6QixLQUFLLE1BQU0sQ0FBQyxJQUFJ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SUFFRCxPQUFPLENBQUMsS0FBcUI7UUFDM0IsS0FBSyxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsUUFBUTtZQUFFLElBQUssQ0FBa0IsQ0FBQyxPQUFPO2dCQUFHLENBQWtCLENBQUMsT0FBUSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3RHLENBQUM7SUFFRCx5RUFBeUU7SUFFekUsS0FBSztRQUNILEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVE7WUFBRSxJQUFJLENBQUMsQ0FBQyxLQUFLO2dCQUFFLENBQUMsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUN4RCxDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsVUFBVTtRQUNSLE1BQU0sY0FBYyxHQUF1RCxFQUFFLENBQUM7UUFDOUUsS0FBSyxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsUUFBUSxFQUFFLENBQUM7WUFDOUIsSUFBSSxDQUFDLENBQUMsVUFBVSxFQUFFLENBQUM7Z0JBQ2pCLE1BQU0sRUFBRSxJQUFJLEVBQUUsSUFBSSxFQUFFLEdBQUcsQ0FBQyxDQUFDLFVBQVUsRUFBRSxDQUFDO2dCQUN0QyxjQUFjLENBQUMsSUFBSSxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxDQUFDLENBQUM7WUFDaEQsQ0FBQztRQUNILENBQUM7UUFDRCxPQUFPO1lBQ0wsSUFBSSxFQUFFLFdBQVc7WUFDakIsSUFBSSxFQUFFLEVBQUUsUUFBUSxFQUFFLGNBQWMsRUFBRTtTQUNuQyxDQUFDO0lBQ0osQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDb21wb3NpdGVSZWNvcmRlciDigJQgZmFuLW91dCBhIHNpbmdsZSByZWNvcmRlciBhdHRhY2htZW50IHRvIG11bHRpcGxlIGNoaWxkIHJlY29yZGVycy5cbiAqXG4gKiBJbXBsZW1lbnRzIGJvdGggUmVjb3JkZXIgKHNjb3BlIGRhdGEgb3BzKSBhbmQgRmxvd1JlY29yZGVyIChjb250cm9sIGZsb3cgZXZlbnRzKVxuICogc28gaXQgd29ya3Mgd2l0aCBib3RoIGBleGVjdXRvci5hdHRhY2hSZWNvcmRlcigpYCBhbmQgYGV4ZWN1dG9yLmF0dGFjaEZsb3dSZWNvcmRlcigpYC5cbiAqXG4gKiBUaGUgY29tcG9zaXRlIGhhcyBhIHNpbmdsZSBJRCBmb3IgaWRlbXBvdGVudCBhdHRhY2gvZGV0YWNoLiBDaGlsZCByZWNvcmRlcnNcbiAqIGtlZXAgdGhlaXIgb3duIElEcyBpbnRlcm5hbGx5IGJ1dCBhcmUgbm90IGluZGl2aWR1YWxseSB2aXNpYmxlIHRvIHRoZSBleGVjdXRvci5cbiAqXG4gKiBEb21haW4gbGlicmFyaWVzIChlLmcuLCBhZ2VudGZvb3RwcmludCkgdXNlIHRoaXMgdG8gYnVuZGxlIG11bHRpcGxlIHJlY29yZGVyc1xuICogaW50byBhIHNpbmdsZSBwcmVzZXQg4oCUIHRoZSBjb25zdW1lciBjYWxscyBvbmUgZnVuY3Rpb24sIGdldHMgZnVsbCBvYnNlcnZhYmlsaXR5LlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBpbXBvcnQgeyBDb21wb3NpdGVSZWNvcmRlciwgTWV0cmljUmVjb3JkZXIsIERlYnVnUmVjb3JkZXIgfSBmcm9tICdmb290cHJpbnRqcyc7XG4gKlxuICogLy8gQnVuZGxlIG1ldHJpY3MgKyBkZWJ1ZyBpbnRvIGEgc2luZ2xlIHJlY29yZGVyXG4gKiBjb25zdCBvYnNlcnZhYmlsaXR5ID0gbmV3IENvbXBvc2l0ZVJlY29yZGVyKCdvYnNlcnZhYmlsaXR5JywgW1xuICogICBuZXcgTWV0cmljUmVjb3JkZXIoeyBzdGFnZUZpbHRlcjogKG5hbWUpID0+IG5hbWUgPT09ICdDYWxsTExNJyB9KSxcbiAqICAgbmV3IERlYnVnUmVjb3JkZXIoeyB2ZXJib3NpdHk6ICdtaW5pbWFsJyB9KSxcbiAqIF0pO1xuICpcbiAqIGV4ZWN1dG9yLmF0dGFjaFJlY29yZGVyKG9ic2VydmFiaWxpdHkpO1xuICpcbiAqIC8vIEFjY2VzcyBjaGlsZCByZWNvcmRlcnMgYnkgdHlwZVxuICogY29uc3QgbWV0cmljcyA9IG9ic2VydmFiaWxpdHkuZ2V0KE1ldHJpY1JlY29yZGVyKTtcbiAqIG1ldHJpY3M/LmdldE1ldHJpY3MoKTsgLy8gdGltaW5nIGRhdGFcbiAqIGBgYFxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiAvLyBEb21haW4gbGlicmFyeSBwcmVzZXQgKGUuZy4sIGFnZW50Zm9vdHByaW50KVxuICogZXhwb3J0IGZ1bmN0aW9uIGFnZW50T2JzZXJ2YWJpbGl0eShvcHRpb25zPzogQWdlbnRPYnNlcnZhYmlsaXR5T3B0aW9ucykge1xuICogICByZXR1cm4gbmV3IENvbXBvc2l0ZVJlY29yZGVyKCdhZ2VudC1vYnNlcnZhYmlsaXR5JywgW1xuICogICAgIG5ldyBNZXRyaWNSZWNvcmRlcihvcHRpb25zPy5zdGFnZUZpbHRlciA/IHsgc3RhZ2VGaWx0ZXI6IG9wdGlvbnMuc3RhZ2VGaWx0ZXIgfSA6IHVuZGVmaW5lZCksXG4gKiAgICAgbmV3IFRva2VuUmVjb3JkZXIoKSxcbiAqICAgICBuZXcgVG9vbFVzYWdlUmVjb3JkZXIoKSxcbiAqICAgXSk7XG4gKiB9XG4gKlxuICogLy8gQ29uc3VtZXJcbiAqIGV4ZWN1dG9yLmF0dGFjaFJlY29yZGVyKGFnZW50T2JzZXJ2YWJpbGl0eSgpKTtcbiAqIGBgYFxuICovXG5cbmltcG9ydCB0eXBlIHtcbiAgRmxvd0JyZWFrRXZlbnQsXG4gIEZsb3dEZWNpc2lvbkV2ZW50LFxuICBGbG93RXJyb3JFdmVudCxcbiAgRmxvd0ZvcmtFdmVudCxcbiAgRmxvd0xvb3BFdmVudCxcbiAgRmxvd05leHRFdmVudCxcbiAgRmxvd1JlY29yZGVyLFxuICBGbG93U2VsZWN0ZWRFdmVudCxcbiAgRmxvd1N0YWdlRXZlbnQsXG4gIEZsb3dTdWJmbG93RXZlbnQsXG4gIEZsb3dTdWJmbG93UmVnaXN0ZXJlZEV2ZW50LFxufSBmcm9tICcuLi9lbmdpbmUvbmFycmF0aXZlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgQ29tbWl0RXZlbnQsIEVycm9yRXZlbnQsIFJlYWRFdmVudCwgUmVjb3JkZXIsIFN0YWdlRXZlbnQsIFdyaXRlRXZlbnQgfSBmcm9tICcuLi9zY29wZS90eXBlcy5qcyc7XG5cbi8qKiBTbmFwc2hvdCBmb3JtYXQgZm9yIGNvbXBvc2l0ZSByZWNvcmRlcnMg4oCUIHdyYXBzIGNoaWxkIHNuYXBzaG90cy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ29tcG9zaXRlU25hcHNob3Qge1xuICBuYW1lOiBzdHJpbmc7XG4gIGRhdGE6IHtcbiAgICBjaGlsZHJlbjogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IGRhdGE6IHVua25vd24gfT47XG4gIH07XG59XG5cbmV4cG9ydCBjbGFzcyBDb21wb3NpdGVSZWNvcmRlciBpbXBsZW1lbnRzIFJlY29yZGVyLCBGbG93UmVjb3JkZXIge1xuICByZWFkb25seSBpZDogc3RyaW5nO1xuICBwcml2YXRlIHJlYWRvbmx5IGNoaWxkcmVuOiBBcnJheTxSZWNvcmRlciB8IEZsb3dSZWNvcmRlcj47XG5cbiAgY29uc3RydWN0b3IoaWQ6IHN0cmluZywgY2hpbGRyZW46IEFycmF5PFJlY29yZGVyIHwgRmxvd1JlY29yZGVyPikge1xuICAgIHRoaXMuaWQgPSBpZDtcbiAgICB0aGlzLmNoaWxkcmVuID0gWy4uLmNoaWxkcmVuXTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBDaGlsZCBhY2Nlc3Mg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgLyoqXG4gICAqIEdldCBhIGNoaWxkIHJlY29yZGVyIGJ5IGNsYXNzIHR5cGUuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHR5cGVzY3JpcHRcbiAgICogY29uc3QgbWV0cmljcyA9IGNvbXBvc2l0ZS5nZXQoTWV0cmljUmVjb3JkZXIpO1xuICAgKiBgYGBcbiAgICovXG4gIGdldDxUPih0eXBlOiBuZXcgKC4uLmFyZ3M6IGFueVtdKSA9PiBUKTogVCB8IHVuZGVmaW5lZCB7XG4gICAgcmV0dXJuIHRoaXMuY2hpbGRyZW4uZmluZCgoYykgPT4gYyBpbnN0YW5jZW9mIHR5cGUpIGFzIFQgfCB1bmRlZmluZWQ7XG4gIH1cblxuICAvKiogR2V0IGFsbCBjaGlsZCByZWNvcmRlcnMuICovXG4gIGdldENoaWxkcmVuKCk6IFJlYWRvbmx5QXJyYXk8UmVjb3JkZXIgfCBGbG93UmVjb3JkZXI+IHtcbiAgICByZXR1cm4gdGhpcy5jaGlsZHJlbjtcbiAgfVxuXG4gIC8vIOKUgOKUgCBTY29wZSBSZWNvcmRlciBob29rcyAoZmFuLW91dCB0byBjaGlsZHJlbiB0aGF0IGltcGxlbWVudCBSZWNvcmRlcikg4pSAXG5cbiAgb25SZWFkKGV2ZW50OiBSZWFkRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIFJlY29yZGVyKS5vblJlYWQpIChjIGFzIFJlY29yZGVyKS5vblJlYWQhKGV2ZW50KTtcbiAgfVxuXG4gIG9uV3JpdGUoZXZlbnQ6IFdyaXRlRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIFJlY29yZGVyKS5vbldyaXRlKSAoYyBhcyBSZWNvcmRlcikub25Xcml0ZSEoZXZlbnQpO1xuICB9XG5cbiAgb25Db21taXQoZXZlbnQ6IENvbW1pdEV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBSZWNvcmRlcikub25Db21taXQpIChjIGFzIFJlY29yZGVyKS5vbkNvbW1pdCEoZXZlbnQpO1xuICB9XG5cbiAgb25FcnJvcihldmVudDogRXJyb3JFdmVudCB8IEZsb3dFcnJvckV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBSZWNvcmRlcikub25FcnJvcikgKGMgYXMgUmVjb3JkZXIpLm9uRXJyb3IhKGV2ZW50IGFzIGFueSk7XG4gIH1cblxuICBvblN0YWdlU3RhcnQoZXZlbnQ6IFN0YWdlRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIFJlY29yZGVyKS5vblN0YWdlU3RhcnQpIChjIGFzIFJlY29yZGVyKS5vblN0YWdlU3RhcnQhKGV2ZW50KTtcbiAgfVxuXG4gIG9uU3RhZ2VFbmQoZXZlbnQ6IFN0YWdlRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIFJlY29yZGVyKS5vblN0YWdlRW5kKSAoYyBhcyBSZWNvcmRlcikub25TdGFnZUVuZCEoZXZlbnQpO1xuICB9XG5cbiAgLy8g4pSA4pSAIEZsb3dSZWNvcmRlciBob29rcyAoZmFuLW91dCB0byBjaGlsZHJlbiB0aGF0IGltcGxlbWVudCBGbG93UmVjb3JkZXIpIOKUgFxuXG4gIG9uU3RhZ2VFeGVjdXRlZChldmVudDogRmxvd1N0YWdlRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25TdGFnZUV4ZWN1dGVkKSAoYyBhcyBGbG93UmVjb3JkZXIpLm9uU3RhZ2VFeGVjdXRlZCEoZXZlbnQpO1xuICB9XG5cbiAgb25OZXh0KGV2ZW50OiBGbG93TmV4dEV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBGbG93UmVjb3JkZXIpLm9uTmV4dCkgKGMgYXMgRmxvd1JlY29yZGVyKS5vbk5leHQhKGV2ZW50KTtcbiAgfVxuXG4gIG9uRGVjaXNpb24oZXZlbnQ6IEZsb3dEZWNpc2lvbkV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBGbG93UmVjb3JkZXIpLm9uRGVjaXNpb24pIChjIGFzIEZsb3dSZWNvcmRlcikub25EZWNpc2lvbiEoZXZlbnQpO1xuICB9XG5cbiAgb25Gb3JrKGV2ZW50OiBGbG93Rm9ya0V2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBGbG93UmVjb3JkZXIpLm9uRm9yaykgKGMgYXMgRmxvd1JlY29yZGVyKS5vbkZvcmshKGV2ZW50KTtcbiAgfVxuXG4gIG9uU2VsZWN0ZWQoZXZlbnQ6IEZsb3dTZWxlY3RlZEV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmICgoYyBhcyBGbG93UmVjb3JkZXIpLm9uU2VsZWN0ZWQpIChjIGFzIEZsb3dSZWNvcmRlcikub25TZWxlY3RlZCEoZXZlbnQpO1xuICB9XG5cbiAgb25TdWJmbG93RW50cnkoZXZlbnQ6IEZsb3dTdWJmbG93RXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25TdWJmbG93RW50cnkpIChjIGFzIEZsb3dSZWNvcmRlcikub25TdWJmbG93RW50cnkhKGV2ZW50KTtcbiAgfVxuXG4gIG9uU3ViZmxvd0V4aXQoZXZlbnQ6IEZsb3dTdWJmbG93RXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25TdWJmbG93RXhpdCkgKGMgYXMgRmxvd1JlY29yZGVyKS5vblN1YmZsb3dFeGl0IShldmVudCk7XG4gIH1cblxuICBvblN1YmZsb3dSZWdpc3RlcmVkKGV2ZW50OiBGbG93U3ViZmxvd1JlZ2lzdGVyZWRFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKVxuICAgICAgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25TdWJmbG93UmVnaXN0ZXJlZCkgKGMgYXMgRmxvd1JlY29yZGVyKS5vblN1YmZsb3dSZWdpc3RlcmVkIShldmVudCk7XG4gIH1cblxuICBvbkxvb3AoZXZlbnQ6IEZsb3dMb29wRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25Mb29wKSAoYyBhcyBGbG93UmVjb3JkZXIpLm9uTG9vcCEoZXZlbnQpO1xuICB9XG5cbiAgb25CcmVhayhldmVudDogRmxvd0JyZWFrRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25CcmVhaykgKGMgYXMgRmxvd1JlY29yZGVyKS5vbkJyZWFrIShldmVudCk7XG4gIH1cblxuICAvLyDilIDilIAgTGlmZWN5Y2xlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4gIGNsZWFyKCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoYy5jbGVhcikgYy5jbGVhcigpO1xuICB9XG5cbiAgLyoqXG4gICAqIFNuYXBzaG90IG1lcmdlcyBhbGwgY2hpbGQgc25hcHNob3RzIGludG8gYSBzaW5nbGUgY29tcG9zaXRlIGVudHJ5LlxuICAgKiBFYWNoIGNoaWxkJ3Mgc25hcHNob3QgaXMgcHJlc2VydmVkIHdpdGggaXRzIG93biBpZC9uYW1lL2RhdGEuXG4gICAqL1xuICB0b1NuYXBzaG90KCk6IENvbXBvc2l0ZVNuYXBzaG90IHtcbiAgICBjb25zdCBjaGlsZFNuYXBzaG90czogQXJyYXk8eyBpZDogc3RyaW5nOyBuYW1lOiBzdHJpbmc7IGRhdGE6IHVua25vd24gfT4gPSBbXTtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikge1xuICAgICAgaWYgKGMudG9TbmFwc2hvdCkge1xuICAgICAgICBjb25zdCB7IG5hbWUsIGRhdGEgfSA9IGMudG9TbmFwc2hvdCgpO1xuICAgICAgICBjaGlsZFNuYXBzaG90cy5wdXNoKHsgaWQ6IGMuaWQsIG5hbWUsIGRhdGEgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiAnQ29tcG9zaXRlJyxcbiAgICAgIGRhdGE6IHsgY2hpbGRyZW46IGNoaWxkU25hcHNob3RzIH0sXG4gICAgfTtcbiAgfVxufVxuIl19