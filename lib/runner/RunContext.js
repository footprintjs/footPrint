"use strict";
/**
 * RunContext -- d3-style chainable run configuration.
 *
 * Returned by chart.recorder() and chart.redact().
 * Accumulates recorders and redaction policy, then creates
 * a FlowChartExecutor internally when .run() is called.
 *
 * The chart is immutable. RunContext is ephemeral per-run config.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunContext = void 0;
const FlowChartExecutor_js_1 = require("./FlowChartExecutor.js");
class RunContext {
    constructor(chart) {
        this.scopeRecorders = [];
        this.flowRecorders = [];
        this.chart = chart;
    }
    /** Attach a recorder. Auto-detects scope vs flow recorder. Chainable. */
    recorder(r) {
        const hasId = typeof r.id === 'string';
        const isFlowRecorder = hasId &&
            (typeof r.onStageExecuted === 'function' ||
                typeof r.onDecision === 'function' ||
                typeof r.onFork === 'function' ||
                typeof r.onNext === 'function');
        const isScopeRecorder = hasId &&
            (typeof r.onRead === 'function' ||
                typeof r.onWrite === 'function' ||
                typeof r.onCommit === 'function');
        // CombinedNarrativeRecorder implements BOTH — add to both lists
        if (isFlowRecorder)
            this.flowRecorders.push(r);
        if (isScopeRecorder)
            this.scopeRecorders.push(r);
        // Pure scope recorder (no flow hooks)
        if (!isFlowRecorder && !isScopeRecorder && hasId) {
            this.scopeRecorders.push(r);
        }
        return this;
    }
    /** Set redaction policy for this run. Chainable. */
    redact(policy) {
        this.redactionPolicy = policy;
        return this;
    }
    /** Execute the chart with accumulated config. Returns RunResult. */
    async run(options) {
        const executor = new FlowChartExecutor_js_1.FlowChartExecutor(this.chart);
        // Attach scope recorders
        for (const r of this.scopeRecorders) {
            executor.attachRecorder(r);
        }
        // Attach flow recorders (auto-enables narrative)
        for (const r of this.flowRecorders) {
            executor.attachFlowRecorder(r);
        }
        // Set redaction
        if (this.redactionPolicy) {
            executor.setRedactionPolicy(this.redactionPolicy);
        }
        // Run
        await executor.run(options);
        // Build result
        const snapshot = executor.getSnapshot();
        const mapper = this.chart.outputMapper;
        const output = mapper ? mapper(snapshot.sharedState || {}) : snapshot.sharedState;
        return {
            state: snapshot.sharedState || {},
            output,
            narrative: executor.getNarrative(),
            executionTree: snapshot.executionTree,
            commitLog: snapshot.commitLog || [],
        };
    }
}
exports.RunContext = RunContext;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUnVuQ29udGV4dC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9saWIvcnVubmVyL1J1bkNvbnRleHQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7OztHQVFHOzs7QUFLSCxpRUFBMkQ7QUFnQjNELE1BQWEsVUFBVTtJQU1yQixZQUFZLEtBQThCO1FBSnpCLG1CQUFjLEdBQWUsRUFBRSxDQUFDO1FBQ2hDLGtCQUFhLEdBQW1CLEVBQUUsQ0FBQztRQUlsRCxJQUFJLENBQUMsS0FBSyxHQUFHLEtBQUssQ0FBQztJQUNyQixDQUFDO0lBRUQseUVBQXlFO0lBQ3pFLFFBQVEsQ0FBQyxDQUEwQjtRQUNqQyxNQUFNLEtBQUssR0FBRyxPQUFRLENBQVMsQ0FBQyxFQUFFLEtBQUssUUFBUSxDQUFDO1FBQ2hELE1BQU0sY0FBYyxHQUNsQixLQUFLO1lBQ0wsQ0FBQyxPQUFRLENBQWtCLENBQUMsZUFBZSxLQUFLLFVBQVU7Z0JBQ3hELE9BQVEsQ0FBa0IsQ0FBQyxVQUFVLEtBQUssVUFBVTtnQkFDcEQsT0FBUSxDQUFrQixDQUFDLE1BQU0sS0FBSyxVQUFVO2dCQUNoRCxPQUFRLENBQWtCLENBQUMsTUFBTSxLQUFLLFVBQVUsQ0FBQyxDQUFDO1FBQ3RELE1BQU0sZUFBZSxHQUNuQixLQUFLO1lBQ0wsQ0FBQyxPQUFRLENBQWMsQ0FBQyxNQUFNLEtBQUssVUFBVTtnQkFDM0MsT0FBUSxDQUFjLENBQUMsT0FBTyxLQUFLLFVBQVU7Z0JBQzdDLE9BQVEsQ0FBYyxDQUFDLFFBQVEsS0FBSyxVQUFVLENBQUMsQ0FBQztRQUVwRCxnRUFBZ0U7UUFDaEUsSUFBSSxjQUFjO1lBQUUsSUFBSSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsQ0FBaUIsQ0FBQyxDQUFDO1FBQy9ELElBQUksZUFBZTtZQUFFLElBQUksQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLENBQWEsQ0FBQyxDQUFDO1FBRTdELHNDQUFzQztRQUN0QyxJQUFJLENBQUMsY0FBYyxJQUFJLENBQUMsZUFBZSxJQUFJLEtBQUssRUFBRSxDQUFDO1lBQ2pELElBQUksQ0FBQyxjQUFjLENBQUMsSUFBSSxDQUFDLENBQWEsQ0FBQyxDQUFDO1FBQzFDLENBQUM7UUFFRCxPQUFPLElBQUksQ0FBQztJQUNkLENBQUM7SUFFRCxvREFBb0Q7SUFDcEQsTUFBTSxDQUFDLE1BQXVCO1FBQzVCLElBQUksQ0FBQyxlQUFlLEdBQUcsTUFBTSxDQUFDO1FBQzlCLE9BQU8sSUFBSSxDQUFDO0lBQ2QsQ0FBQztJQUVELG9FQUFvRTtJQUNwRSxLQUFLLENBQUMsR0FBRyxDQUFDLE9BQW9CO1FBQzVCLE1BQU0sUUFBUSxHQUFHLElBQUksd0NBQWlCLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBRW5ELHlCQUF5QjtRQUN6QixLQUFLLE1BQU0sQ0FBQyxJQUFJLElBQUksQ0FBQyxjQUFjLEVBQUUsQ0FBQztZQUNwQyxRQUFRLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQzdCLENBQUM7UUFFRCxpREFBaUQ7UUFDakQsS0FBSyxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7WUFDbkMsUUFBUSxDQUFDLGtCQUFrQixDQUFDLENBQUMsQ0FBQyxDQUFDO1FBQ2pDLENBQUM7UUFFRCxnQkFBZ0I7UUFDaEIsSUFBSSxJQUFJLENBQUMsZUFBZSxFQUFFLENBQUM7WUFDekIsUUFBUSxDQUFDLGtCQUFrQixDQUFDLElBQUksQ0FBQyxlQUFlLENBQUMsQ0FBQztRQUNwRCxDQUFDO1FBRUQsTUFBTTtRQUNOLE1BQU0sUUFBUSxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUU1QixlQUFlO1FBQ2YsTUFBTSxRQUFRLEdBQUcsUUFBUSxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBQ3hDLE1BQU0sTUFBTSxHQUFJLElBQUksQ0FBQyxLQUFhLENBQUMsWUFBcUUsQ0FBQztRQUN6RyxNQUFNLE1BQU0sR0FBRyxNQUFNLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxRQUFRLENBQUMsV0FBVyxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDO1FBRWxGLE9BQU87WUFDTCxLQUFLLEVBQUUsUUFBUSxDQUFDLFdBQVcsSUFBSSxFQUFFO1lBQ2pDLE1BQU07WUFDTixTQUFTLEVBQUUsUUFBUSxDQUFDLFlBQVksRUFBRTtZQUNsQyxhQUFhLEVBQUUsUUFBUSxDQUFDLGFBQWE7WUFDckMsU0FBUyxFQUFFLFFBQVEsQ0FBQyxTQUFTLElBQUksRUFBRTtTQUNwQyxDQUFDO0lBQ0osQ0FBQztDQUNGO0FBOUVELGdDQThFQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUnVuQ29udGV4dCAtLSBkMy1zdHlsZSBjaGFpbmFibGUgcnVuIGNvbmZpZ3VyYXRpb24uXG4gKlxuICogUmV0dXJuZWQgYnkgY2hhcnQucmVjb3JkZXIoKSBhbmQgY2hhcnQucmVkYWN0KCkuXG4gKiBBY2N1bXVsYXRlcyByZWNvcmRlcnMgYW5kIHJlZGFjdGlvbiBwb2xpY3ksIHRoZW4gY3JlYXRlc1xuICogYSBGbG93Q2hhcnRFeGVjdXRvciBpbnRlcm5hbGx5IHdoZW4gLnJ1bigpIGlzIGNhbGxlZC5cbiAqXG4gKiBUaGUgY2hhcnQgaXMgaW1tdXRhYmxlLiBSdW5Db250ZXh0IGlzIGVwaGVtZXJhbCBwZXItcnVuIGNvbmZpZy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEZsb3dSZWNvcmRlciB9IGZyb20gJy4uL2VuZ2luZS9uYXJyYXRpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93Q2hhcnQsIFJ1bk9wdGlvbnMgfSBmcm9tICcuLi9lbmdpbmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBSZWNvcmRlciwgUmVkYWN0aW9uUG9saWN5IH0gZnJvbSAnLi4vc2NvcGUvdHlwZXMuanMnO1xuaW1wb3J0IHsgRmxvd0NoYXJ0RXhlY3V0b3IgfSBmcm9tICcuL0Zsb3dDaGFydEV4ZWN1dG9yLmpzJztcblxuLyoqIFJlc3VsdCBmcm9tIFJ1bkNvbnRleHQucnVuKCkg4oCUIG93bnMgc3RhdGUgYW5kIG91dHB1dC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuUmVzdWx0IHtcbiAgLyoqIFJhdyBzY29wZSBzdGF0ZSBhZnRlciBleGVjdXRpb24uICovXG4gIHN0YXRlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgLyoqIE1hcHBlZCBvdXRwdXQgdmlhIGNvbnRyYWN0IG1hcHBlciAoaWYgZGVjbGFyZWQpLiAqL1xuICBvdXRwdXQ6IHVua25vd247XG4gIC8qKiBOYXJyYXRpdmUgbGluZXMgKGlmIG5hcnJhdGl2ZSB3YXMgZW5hYmxlZCkuICovXG4gIG5hcnJhdGl2ZTogc3RyaW5nW107XG4gIC8qKiBGdWxsIGV4ZWN1dGlvbiB0cmVlIGZvciBkZWJ1Z2dpbmcuICovXG4gIGV4ZWN1dGlvblRyZWU6IHVua25vd247XG4gIC8qKiBDb21taXQgbG9nIGZvciB0aW1lLXRyYXZlbC4gKi9cbiAgY29tbWl0TG9nOiB1bmtub3duW107XG59XG5cbmV4cG9ydCBjbGFzcyBSdW5Db250ZXh0PFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4ge1xuICBwcml2YXRlIHJlYWRvbmx5IGNoYXJ0OiBGbG93Q2hhcnQ8VE91dCwgVFNjb3BlPjtcbiAgcHJpdmF0ZSByZWFkb25seSBzY29wZVJlY29yZGVyczogUmVjb3JkZXJbXSA9IFtdO1xuICBwcml2YXRlIHJlYWRvbmx5IGZsb3dSZWNvcmRlcnM6IEZsb3dSZWNvcmRlcltdID0gW107XG4gIHByaXZhdGUgcmVkYWN0aW9uUG9saWN5PzogUmVkYWN0aW9uUG9saWN5O1xuXG4gIGNvbnN0cnVjdG9yKGNoYXJ0OiBGbG93Q2hhcnQ8VE91dCwgVFNjb3BlPikge1xuICAgIHRoaXMuY2hhcnQgPSBjaGFydDtcbiAgfVxuXG4gIC8qKiBBdHRhY2ggYSByZWNvcmRlci4gQXV0by1kZXRlY3RzIHNjb3BlIHZzIGZsb3cgcmVjb3JkZXIuIENoYWluYWJsZS4gKi9cbiAgcmVjb3JkZXIocjogUmVjb3JkZXIgfCBGbG93UmVjb3JkZXIpOiBSdW5Db250ZXh0PFRPdXQsIFRTY29wZT4ge1xuICAgIGNvbnN0IGhhc0lkID0gdHlwZW9mIChyIGFzIGFueSkuaWQgPT09ICdzdHJpbmcnO1xuICAgIGNvbnN0IGlzRmxvd1JlY29yZGVyID1cbiAgICAgIGhhc0lkICYmXG4gICAgICAodHlwZW9mIChyIGFzIEZsb3dSZWNvcmRlcikub25TdGFnZUV4ZWN1dGVkID09PSAnZnVuY3Rpb24nIHx8XG4gICAgICAgIHR5cGVvZiAociBhcyBGbG93UmVjb3JkZXIpLm9uRGVjaXNpb24gPT09ICdmdW5jdGlvbicgfHxcbiAgICAgICAgdHlwZW9mIChyIGFzIEZsb3dSZWNvcmRlcikub25Gb3JrID09PSAnZnVuY3Rpb24nIHx8XG4gICAgICAgIHR5cGVvZiAociBhcyBGbG93UmVjb3JkZXIpLm9uTmV4dCA9PT0gJ2Z1bmN0aW9uJyk7XG4gICAgY29uc3QgaXNTY29wZVJlY29yZGVyID1cbiAgICAgIGhhc0lkICYmXG4gICAgICAodHlwZW9mIChyIGFzIFJlY29yZGVyKS5vblJlYWQgPT09ICdmdW5jdGlvbicgfHxcbiAgICAgICAgdHlwZW9mIChyIGFzIFJlY29yZGVyKS5vbldyaXRlID09PSAnZnVuY3Rpb24nIHx8XG4gICAgICAgIHR5cGVvZiAociBhcyBSZWNvcmRlcikub25Db21taXQgPT09ICdmdW5jdGlvbicpO1xuXG4gICAgLy8gQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlciBpbXBsZW1lbnRzIEJPVEgg4oCUIGFkZCB0byBib3RoIGxpc3RzXG4gICAgaWYgKGlzRmxvd1JlY29yZGVyKSB0aGlzLmZsb3dSZWNvcmRlcnMucHVzaChyIGFzIEZsb3dSZWNvcmRlcik7XG4gICAgaWYgKGlzU2NvcGVSZWNvcmRlcikgdGhpcy5zY29wZVJlY29yZGVycy5wdXNoKHIgYXMgUmVjb3JkZXIpO1xuXG4gICAgLy8gUHVyZSBzY29wZSByZWNvcmRlciAobm8gZmxvdyBob29rcylcbiAgICBpZiAoIWlzRmxvd1JlY29yZGVyICYmICFpc1Njb3BlUmVjb3JkZXIgJiYgaGFzSWQpIHtcbiAgICAgIHRoaXMuc2NvcGVSZWNvcmRlcnMucHVzaChyIGFzIFJlY29yZGVyKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8qKiBTZXQgcmVkYWN0aW9uIHBvbGljeSBmb3IgdGhpcyBydW4uIENoYWluYWJsZS4gKi9cbiAgcmVkYWN0KHBvbGljeTogUmVkYWN0aW9uUG9saWN5KTogUnVuQ29udGV4dDxUT3V0LCBUU2NvcGU+IHtcbiAgICB0aGlzLnJlZGFjdGlvblBvbGljeSA9IHBvbGljeTtcbiAgICByZXR1cm4gdGhpcztcbiAgfVxuXG4gIC8qKiBFeGVjdXRlIHRoZSBjaGFydCB3aXRoIGFjY3VtdWxhdGVkIGNvbmZpZy4gUmV0dXJucyBSdW5SZXN1bHQuICovXG4gIGFzeW5jIHJ1bihvcHRpb25zPzogUnVuT3B0aW9ucyk6IFByb21pc2U8UnVuUmVzdWx0PiB7XG4gICAgY29uc3QgZXhlY3V0b3IgPSBuZXcgRmxvd0NoYXJ0RXhlY3V0b3IodGhpcy5jaGFydCk7XG5cbiAgICAvLyBBdHRhY2ggc2NvcGUgcmVjb3JkZXJzXG4gICAgZm9yIChjb25zdCByIG9mIHRoaXMuc2NvcGVSZWNvcmRlcnMpIHtcbiAgICAgIGV4ZWN1dG9yLmF0dGFjaFJlY29yZGVyKHIpO1xuICAgIH1cblxuICAgIC8vIEF0dGFjaCBmbG93IHJlY29yZGVycyAoYXV0by1lbmFibGVzIG5hcnJhdGl2ZSlcbiAgICBmb3IgKGNvbnN0IHIgb2YgdGhpcy5mbG93UmVjb3JkZXJzKSB7XG4gICAgICBleGVjdXRvci5hdHRhY2hGbG93UmVjb3JkZXIocik7XG4gICAgfVxuXG4gICAgLy8gU2V0IHJlZGFjdGlvblxuICAgIGlmICh0aGlzLnJlZGFjdGlvblBvbGljeSkge1xuICAgICAgZXhlY3V0b3Iuc2V0UmVkYWN0aW9uUG9saWN5KHRoaXMucmVkYWN0aW9uUG9saWN5KTtcbiAgICB9XG5cbiAgICAvLyBSdW5cbiAgICBhd2FpdCBleGVjdXRvci5ydW4ob3B0aW9ucyk7XG5cbiAgICAvLyBCdWlsZCByZXN1bHRcbiAgICBjb25zdCBzbmFwc2hvdCA9IGV4ZWN1dG9yLmdldFNuYXBzaG90KCk7XG4gICAgY29uc3QgbWFwcGVyID0gKHRoaXMuY2hhcnQgYXMgYW55KS5vdXRwdXRNYXBwZXIgYXMgKChzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gdW5rbm93bikgfCB1bmRlZmluZWQ7XG4gICAgY29uc3Qgb3V0cHV0ID0gbWFwcGVyID8gbWFwcGVyKHNuYXBzaG90LnNoYXJlZFN0YXRlIHx8IHt9KSA6IHNuYXBzaG90LnNoYXJlZFN0YXRlO1xuXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXRlOiBzbmFwc2hvdC5zaGFyZWRTdGF0ZSB8fCB7fSxcbiAgICAgIG91dHB1dCxcbiAgICAgIG5hcnJhdGl2ZTogZXhlY3V0b3IuZ2V0TmFycmF0aXZlKCksXG4gICAgICBleGVjdXRpb25UcmVlOiBzbmFwc2hvdC5leGVjdXRpb25UcmVlLFxuICAgICAgY29tbWl0TG9nOiBzbmFwc2hvdC5jb21taXRMb2cgfHwgW10sXG4gICAgfTtcbiAgfVxufVxuIl19