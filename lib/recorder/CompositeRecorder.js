"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CompositeRecorder = void 0;
class CompositeRecorder {
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
exports.CompositeRecorder = CompositeRecorder;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQ29tcG9zaXRlUmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL3JlY29yZGVyL0NvbXBvc2l0ZVJlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQTJDRzs7O0FBeUJILE1BQWEsaUJBQWlCO0lBSTVCLFlBQVksRUFBVSxFQUFFLFFBQXdDO1FBQzlELElBQUksQ0FBQyxFQUFFLEdBQUcsRUFBRSxDQUFDO1FBQ2IsSUFBSSxDQUFDLFFBQVEsR0FBRyxDQUFDLEdBQUcsUUFBUSxDQUFDLENBQUM7SUFDaEMsQ0FBQztJQUVELHlFQUF5RTtJQUV6RTs7Ozs7OztPQU9HO0lBQ0gsR0FBRyxDQUFJLElBQStCO1FBQ3BDLE9BQU8sSUFBSSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEVBQUUsRUFBRSxDQUFDLENBQUMsWUFBWSxJQUFJLENBQWtCLENBQUM7SUFDdkUsQ0FBQztJQUVELCtCQUErQjtJQUMvQixXQUFXO1FBQ1QsT0FBTyxJQUFJLENBQUMsUUFBUSxDQUFDO0lBQ3ZCLENBQUM7SUFFRCwwRUFBMEU7SUFFMUUsTUFBTSxDQUFDLEtBQWdCO1FBQ3JCLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVE7WUFBRSxJQUFLLENBQWMsQ0FBQyxNQUFNO2dCQUFHLENBQWMsQ0FBQyxNQUFPLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDNUYsQ0FBQztJQUVELE9BQU8sQ0FBQyxLQUFpQjtRQUN2QixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsSUFBSyxDQUFjLENBQUMsT0FBTztnQkFBRyxDQUFjLENBQUMsT0FBUSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQzlGLENBQUM7SUFFRCxRQUFRLENBQUMsS0FBa0I7UUFDekIsS0FBSyxNQUFNLENBQUMsSUFBSSxJQUFJ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T0FBTyxDQUFDLEtBQXFCO1FBQzNCLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVE7WUFBRSxJQUFLLENBQWtCLENBQUMsT0FBTztnQkFBRyxDQUFrQixDQUFDLE9BQVEsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN0RyxDQUFDO0lBRUQseUVBQXlFO0lBRXpFLEtBQUs7UUFDSCxLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxRQUFRO1lBQUUsSUFBSSxDQUFDLENBQUMsS0FBSztnQkFBRSxDQUFDLENBQUMsS0FBSyxFQUFFLENBQUM7SUFDeEQsQ0FBQztJQUVEOzs7T0FHRztJQUNILFVBQVU7UUFDUixNQUFNLGNBQWMsR0FBdUQsRUFBRSxDQUFDO1FBQzlFLEtBQUssTUFBTSxDQUFDLElBQUksSUFBSSxDQUFDLFFBQVEsRUFBRSxDQUFDO1lBQzlCLElBQUksQ0FBQyxDQUFDLFVBQVUsRUFBRSxDQUFDO2dCQUNqQixNQUFNLEVBQUUsSUFBSSxFQUFFLElBQUksRUFBRSxHQUFHLENBQUMsQ0FBQyxVQUFVLEVBQUUsQ0FBQztnQkFDdEMsY0FBYyxDQUFDLElBQUksQ0FBQyxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxFQUFFLElBQUksRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDO1lBQ2hELENBQUM7UUFDSCxDQUFDO1FBQ0QsT0FBTztZQUNMLElBQUksRUFBRSxXQUFXO1lBQ2pCLElBQUksRUFBRSxFQUFFLFFBQVEsRUFBRSxjQUFjLEVBQUU7U0FDbkMsQ0FBQztJQUNKLENBQUM7Q0FDRjtBQXhIRCw4Q0F3SEMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIENvbXBvc2l0ZVJlY29yZGVyIOKAlCBmYW4tb3V0IGEgc2luZ2xlIHJlY29yZGVyIGF0dGFjaG1lbnQgdG8gbXVsdGlwbGUgY2hpbGQgcmVjb3JkZXJzLlxuICpcbiAqIEltcGxlbWVudHMgYm90aCBSZWNvcmRlciAoc2NvcGUgZGF0YSBvcHMpIGFuZCBGbG93UmVjb3JkZXIgKGNvbnRyb2wgZmxvdyBldmVudHMpXG4gKiBzbyBpdCB3b3JrcyB3aXRoIGJvdGggYGV4ZWN1dG9yLmF0dGFjaFJlY29yZGVyKClgIGFuZCBgZXhlY3V0b3IuYXR0YWNoRmxvd1JlY29yZGVyKClgLlxuICpcbiAqIFRoZSBjb21wb3NpdGUgaGFzIGEgc2luZ2xlIElEIGZvciBpZGVtcG90ZW50IGF0dGFjaC9kZXRhY2guIENoaWxkIHJlY29yZGVyc1xuICoga2VlcCB0aGVpciBvd24gSURzIGludGVybmFsbHkgYnV0IGFyZSBub3QgaW5kaXZpZHVhbGx5IHZpc2libGUgdG8gdGhlIGV4ZWN1dG9yLlxuICpcbiAqIERvbWFpbiBsaWJyYXJpZXMgKGUuZy4sIGFnZW50Zm9vdHByaW50KSB1c2UgdGhpcyB0byBidW5kbGUgbXVsdGlwbGUgcmVjb3JkZXJzXG4gKiBpbnRvIGEgc2luZ2xlIHByZXNldCDigJQgdGhlIGNvbnN1bWVyIGNhbGxzIG9uZSBmdW5jdGlvbiwgZ2V0cyBmdWxsIG9ic2VydmFiaWxpdHkuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGltcG9ydCB7IENvbXBvc2l0ZVJlY29yZGVyLCBNZXRyaWNSZWNvcmRlciwgRGVidWdSZWNvcmRlciB9IGZyb20gJ2Zvb3RwcmludGpzJztcbiAqXG4gKiAvLyBCdW5kbGUgbWV0cmljcyArIGRlYnVnIGludG8gYSBzaW5nbGUgcmVjb3JkZXJcbiAqIGNvbnN0IG9ic2VydmFiaWxpdHkgPSBuZXcgQ29tcG9zaXRlUmVjb3JkZXIoJ29ic2VydmFiaWxpdHknLCBbXG4gKiAgIG5ldyBNZXRyaWNSZWNvcmRlcih7IHN0YWdlRmlsdGVyOiAobmFtZSkgPT4gbmFtZSA9PT0gJ0NhbGxMTE0nIH0pLFxuICogICBuZXcgRGVidWdSZWNvcmRlcih7IHZlcmJvc2l0eTogJ21pbmltYWwnIH0pLFxuICogXSk7XG4gKlxuICogZXhlY3V0b3IuYXR0YWNoUmVjb3JkZXIob2JzZXJ2YWJpbGl0eSk7XG4gKlxuICogLy8gQWNjZXNzIGNoaWxkIHJlY29yZGVycyBieSB0eXBlXG4gKiBjb25zdCBtZXRyaWNzID0gb2JzZXJ2YWJpbGl0eS5nZXQoTWV0cmljUmVjb3JkZXIpO1xuICogbWV0cmljcz8uZ2V0TWV0cmljcygpOyAvLyB0aW1pbmcgZGF0YVxuICogYGBgXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIC8vIERvbWFpbiBsaWJyYXJ5IHByZXNldCAoZS5nLiwgYWdlbnRmb290cHJpbnQpXG4gKiBleHBvcnQgZnVuY3Rpb24gYWdlbnRPYnNlcnZhYmlsaXR5KG9wdGlvbnM/OiBBZ2VudE9ic2VydmFiaWxpdHlPcHRpb25zKSB7XG4gKiAgIHJldHVybiBuZXcgQ29tcG9zaXRlUmVjb3JkZXIoJ2FnZW50LW9ic2VydmFiaWxpdHknLCBbXG4gKiAgICAgbmV3IE1ldHJpY1JlY29yZGVyKG9wdGlvbnM/LnN0YWdlRmlsdGVyID8geyBzdGFnZUZpbHRlcjogb3B0aW9ucy5zdGFnZUZpbHRlciB9IDogdW5kZWZpbmVkKSxcbiAqICAgICBuZXcgVG9rZW5SZWNvcmRlcigpLFxuICogICAgIG5ldyBUb29sVXNhZ2VSZWNvcmRlcigpLFxuICogICBdKTtcbiAqIH1cbiAqXG4gKiAvLyBDb25zdW1lclxuICogZXhlY3V0b3IuYXR0YWNoUmVjb3JkZXIoYWdlbnRPYnNlcnZhYmlsaXR5KCkpO1xuICogYGBgXG4gKi9cblxuaW1wb3J0IHR5cGUge1xuICBGbG93QnJlYWtFdmVudCxcbiAgRmxvd0RlY2lzaW9uRXZlbnQsXG4gIEZsb3dFcnJvckV2ZW50LFxuICBGbG93Rm9ya0V2ZW50LFxuICBGbG93TG9vcEV2ZW50LFxuICBGbG93TmV4dEV2ZW50LFxuICBGbG93UmVjb3JkZXIsXG4gIEZsb3dTZWxlY3RlZEV2ZW50LFxuICBGbG93U3RhZ2VFdmVudCxcbiAgRmxvd1N1YmZsb3dFdmVudCxcbiAgRmxvd1N1YmZsb3dSZWdpc3RlcmVkRXZlbnQsXG59IGZyb20gJy4uL2VuZ2luZS9uYXJyYXRpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBDb21taXRFdmVudCwgRXJyb3JFdmVudCwgUmVhZEV2ZW50LCBSZWNvcmRlciwgU3RhZ2VFdmVudCwgV3JpdGVFdmVudCB9IGZyb20gJy4uL3Njb3BlL3R5cGVzLmpzJztcblxuLyoqIFNuYXBzaG90IGZvcm1hdCBmb3IgY29tcG9zaXRlIHJlY29yZGVycyDigJQgd3JhcHMgY2hpbGQgc25hcHNob3RzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb21wb3NpdGVTbmFwc2hvdCB7XG4gIG5hbWU6IHN0cmluZztcbiAgZGF0YToge1xuICAgIGNoaWxkcmVuOiBBcnJheTx7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgZGF0YTogdW5rbm93biB9PjtcbiAgfTtcbn1cblxuZXhwb3J0IGNsYXNzIENvbXBvc2l0ZVJlY29yZGVyIGltcGxlbWVudHMgUmVjb3JkZXIsIEZsb3dSZWNvcmRlciB7XG4gIHJlYWRvbmx5IGlkOiBzdHJpbmc7XG4gIHByaXZhdGUgcmVhZG9ubHkgY2hpbGRyZW46IEFycmF5PFJlY29yZGVyIHwgRmxvd1JlY29yZGVyPjtcblxuICBjb25zdHJ1Y3RvcihpZDogc3RyaW5nLCBjaGlsZHJlbjogQXJyYXk8UmVjb3JkZXIgfCBGbG93UmVjb3JkZXI+KSB7XG4gICAgdGhpcy5pZCA9IGlkO1xuICAgIHRoaXMuY2hpbGRyZW4gPSBbLi4uY2hpbGRyZW5dO1xuICB9XG5cbiAgLy8g4pSA4pSAIENoaWxkIGFjY2VzcyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcblxuICAvKipcbiAgICogR2V0IGEgY2hpbGQgcmVjb3JkZXIgYnkgY2xhc3MgdHlwZS5cbiAgICpcbiAgICogQGV4YW1wbGVcbiAgICogYGBgdHlwZXNjcmlwdFxuICAgKiBjb25zdCBtZXRyaWNzID0gY29tcG9zaXRlLmdldChNZXRyaWNSZWNvcmRlcik7XG4gICAqIGBgYFxuICAgKi9cbiAgZ2V0PFQ+KHR5cGU6IG5ldyAoLi4uYXJnczogYW55W10pID0+IFQpOiBUIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5jaGlsZHJlbi5maW5kKChjKSA9PiBjIGluc3RhbmNlb2YgdHlwZSkgYXMgVCB8IHVuZGVmaW5lZDtcbiAgfVxuXG4gIC8qKiBHZXQgYWxsIGNoaWxkIHJlY29yZGVycy4gKi9cbiAgZ2V0Q2hpbGRyZW4oKTogUmVhZG9ubHlBcnJheTxSZWNvcmRlciB8IEZsb3dSZWNvcmRlcj4ge1xuICAgIHJldHVybiB0aGlzLmNoaWxkcmVuO1xuICB9XG5cbiAgLy8g4pSA4pSAIFNjb3BlIFJlY29yZGVyIGhvb2tzIChmYW4tb3V0IHRvIGNoaWxkcmVuIHRoYXQgaW1wbGVtZW50IFJlY29yZGVyKSDilIBcblxuICBvblJlYWQoZXZlbnQ6IFJlYWRFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoKGMgYXMgUmVjb3JkZXIpLm9uUmVhZCkgKGMgYXMgUmVjb3JkZXIpLm9uUmVhZCEoZXZlbnQpO1xuICB9XG5cbiAgb25Xcml0ZShldmVudDogV3JpdGVFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoKGMgYXMgUmVjb3JkZXIpLm9uV3JpdGUpIChjIGFzIFJlY29yZGVyKS5vbldyaXRlIShldmVudCk7XG4gIH1cblxuICBvbkNvbW1pdChldmVudDogQ29tbWl0RXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIFJlY29yZGVyKS5vbkNvbW1pdCkgKGMgYXMgUmVjb3JkZXIpLm9uQ29tbWl0IShldmVudCk7XG4gIH1cblxuICBvbkVycm9yKGV2ZW50OiBFcnJvckV2ZW50IHwgRmxvd0Vycm9yRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIFJlY29yZGVyKS5vbkVycm9yKSAoYyBhcyBSZWNvcmRlcikub25FcnJvciEoZXZlbnQgYXMgYW55KTtcbiAgfVxuXG4gIG9uU3RhZ2VTdGFydChldmVudDogU3RhZ2VFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoKGMgYXMgUmVjb3JkZXIpLm9uU3RhZ2VTdGFydCkgKGMgYXMgUmVjb3JkZXIpLm9uU3RhZ2VTdGFydCEoZXZlbnQpO1xuICB9XG5cbiAgb25TdGFnZUVuZChldmVudDogU3RhZ2VFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoKGMgYXMgUmVjb3JkZXIpLm9uU3RhZ2VFbmQpIChjIGFzIFJlY29yZGVyKS5vblN0YWdlRW5kIShldmVudCk7XG4gIH1cblxuICAvLyDilIDilIAgRmxvd1JlY29yZGVyIGhvb2tzIChmYW4tb3V0IHRvIGNoaWxkcmVuIHRoYXQgaW1wbGVtZW50IEZsb3dSZWNvcmRlcikg4pSAXG5cbiAgb25TdGFnZUV4ZWN1dGVkKGV2ZW50OiBGbG93U3RhZ2VFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoKGMgYXMgRmxvd1JlY29yZGVyKS5vblN0YWdlRXhlY3V0ZWQpIChjIGFzIEZsb3dSZWNvcmRlcikub25TdGFnZUV4ZWN1dGVkIShldmVudCk7XG4gIH1cblxuICBvbk5leHQoZXZlbnQ6IEZsb3dOZXh0RXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25OZXh0KSAoYyBhcyBGbG93UmVjb3JkZXIpLm9uTmV4dCEoZXZlbnQpO1xuICB9XG5cbiAgb25EZWNpc2lvbihldmVudDogRmxvd0RlY2lzaW9uRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25EZWNpc2lvbikgKGMgYXMgRmxvd1JlY29yZGVyKS5vbkRlY2lzaW9uIShldmVudCk7XG4gIH1cblxuICBvbkZvcmsoZXZlbnQ6IEZsb3dGb3JrRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25Gb3JrKSAoYyBhcyBGbG93UmVjb3JkZXIpLm9uRm9yayEoZXZlbnQpO1xuICB9XG5cbiAgb25TZWxlY3RlZChldmVudDogRmxvd1NlbGVjdGVkRXZlbnQpOiB2b2lkIHtcbiAgICBmb3IgKGNvbnN0IGMgb2YgdGhpcy5jaGlsZHJlbikgaWYgKChjIGFzIEZsb3dSZWNvcmRlcikub25TZWxlY3RlZCkgKGMgYXMgRmxvd1JlY29yZGVyKS5vblNlbGVjdGVkIShldmVudCk7XG4gIH1cblxuICBvblN1YmZsb3dFbnRyeShldmVudDogRmxvd1N1YmZsb3dFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoKGMgYXMgRmxvd1JlY29yZGVyKS5vblN1YmZsb3dFbnRyeSkgKGMgYXMgRmxvd1JlY29yZGVyKS5vblN1YmZsb3dFbnRyeSEoZXZlbnQpO1xuICB9XG5cbiAgb25TdWJmbG93RXhpdChldmVudDogRmxvd1N1YmZsb3dFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoKGMgYXMgRmxvd1JlY29yZGVyKS5vblN1YmZsb3dFeGl0KSAoYyBhcyBGbG93UmVjb3JkZXIpLm9uU3ViZmxvd0V4aXQhKGV2ZW50KTtcbiAgfVxuXG4gIG9uU3ViZmxvd1JlZ2lzdGVyZWQoZXZlbnQ6IEZsb3dTdWJmbG93UmVnaXN0ZXJlZEV2ZW50KTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pXG4gICAgICBpZiAoKGMgYXMgRmxvd1JlY29yZGVyKS5vblN1YmZsb3dSZWdpc3RlcmVkKSAoYyBhcyBGbG93UmVjb3JkZXIpLm9uU3ViZmxvd1JlZ2lzdGVyZWQhKGV2ZW50KTtcbiAgfVxuXG4gIG9uTG9vcChldmVudDogRmxvd0xvb3BFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoKGMgYXMgRmxvd1JlY29yZGVyKS5vbkxvb3ApIChjIGFzIEZsb3dSZWNvcmRlcikub25Mb29wIShldmVudCk7XG4gIH1cblxuICBvbkJyZWFrKGV2ZW50OiBGbG93QnJlYWtFdmVudCk6IHZvaWQge1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSBpZiAoKGMgYXMgRmxvd1JlY29yZGVyKS5vbkJyZWFrKSAoYyBhcyBGbG93UmVjb3JkZXIpLm9uQnJlYWshKGV2ZW50KTtcbiAgfVxuXG4gIC8vIOKUgOKUgCBMaWZlY3ljbGUg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbiAgY2xlYXIoKTogdm9pZCB7XG4gICAgZm9yIChjb25zdCBjIG9mIHRoaXMuY2hpbGRyZW4pIGlmIChjLmNsZWFyKSBjLmNsZWFyKCk7XG4gIH1cblxuICAvKipcbiAgICogU25hcHNob3QgbWVyZ2VzIGFsbCBjaGlsZCBzbmFwc2hvdHMgaW50byBhIHNpbmdsZSBjb21wb3NpdGUgZW50cnkuXG4gICAqIEVhY2ggY2hpbGQncyBzbmFwc2hvdCBpcyBwcmVzZXJ2ZWQgd2l0aCBpdHMgb3duIGlkL25hbWUvZGF0YS5cbiAgICovXG4gIHRvU25hcHNob3QoKTogQ29tcG9zaXRlU25hcHNob3Qge1xuICAgIGNvbnN0IGNoaWxkU25hcHNob3RzOiBBcnJheTx7IGlkOiBzdHJpbmc7IG5hbWU6IHN0cmluZzsgZGF0YTogdW5rbm93biB9PiA9IFtdO1xuICAgIGZvciAoY29uc3QgYyBvZiB0aGlzLmNoaWxkcmVuKSB7XG4gICAgICBpZiAoYy50b1NuYXBzaG90KSB7XG4gICAgICAgIGNvbnN0IHsgbmFtZSwgZGF0YSB9ID0gYy50b1NuYXBzaG90KCk7XG4gICAgICAgIGNoaWxkU25hcHNob3RzLnB1c2goeyBpZDogYy5pZCwgbmFtZSwgZGF0YSB9KTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIG5hbWU6ICdDb21wb3NpdGUnLFxuICAgICAgZGF0YTogeyBjaGlsZHJlbjogY2hpbGRTbmFwc2hvdHMgfSxcbiAgICB9O1xuICB9XG59XG4iXX0=