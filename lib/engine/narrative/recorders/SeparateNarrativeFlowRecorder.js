"use strict";
/**
 * SeparateNarrativeFlowRecorder — Collects loop iterations in a separate channel.
 *
 * Keeps the main narrative clean (no loop sentences) while preserving full
 * iteration detail in a separate accessor for consumers who need it.
 *
 * Best for: UIs or reports where loop detail is in a collapsible section,
 * or LLM pipelines where loop context should be available but not in the main prompt.
 *
 * @example
 * ```typescript
 * const recorder = new SeparateNarrativeFlowRecorder();
 * executor.attachFlowRecorder(recorder);
 * await executor.run();
 *
 * const mainNarrative = executor.getNarrative();     // No loop sentences
 * const loopDetail = recorder.getLoopSentences();    // All loop detail
 * ```
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeparateNarrativeFlowRecorder = void 0;
const NarrativeFlowRecorder_js_1 = require("../NarrativeFlowRecorder.js");
class SeparateNarrativeFlowRecorder extends NarrativeFlowRecorder_js_1.NarrativeFlowRecorder {
    constructor(id) {
        super(id !== null && id !== void 0 ? id : 'narrative-separate');
        this.loopSentences = [];
        this.loopCounts = new Map();
    }
    onLoop(event) {
        // Don't call super — keep loops out of main narrative
        var _a;
        // Track count for summary
        const count = ((_a = this.loopCounts.get(event.target)) !== null && _a !== void 0 ? _a : 0) + 1;
        this.loopCounts.set(event.target, count);
        // Store in separate channel
        if (event.description) {
            this.loopSentences.push(`On pass ${event.iteration}: ${event.description} again.`);
        }
        else {
            this.loopSentences.push(`On pass ${event.iteration} through ${event.target}.`);
        }
    }
    /** Returns all loop iteration sentences (the separate channel). */
    getLoopSentences() {
        return [...this.loopSentences];
    }
    /** Returns total loop count per target. */
    getLoopCounts() {
        return new Map(this.loopCounts);
    }
    clear() {
        super.clear();
        this.loopSentences = [];
        this.loopCounts.clear();
    }
}
exports.SeparateNarrativeFlowRecorder = SeparateNarrativeFlowRecorder;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU2VwYXJhdGVOYXJyYXRpdmVGbG93UmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL1NlcGFyYXRlTmFycmF0aXZlRmxvd1JlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBa0JHOzs7QUFFSCwwRUFBb0U7QUFHcEUsTUFBYSw2QkFBOEIsU0FBUSxnREFBcUI7SUFJdEUsWUFBWSxFQUFXO1FBQ3JCLEtBQUssQ0FBQyxFQUFFLGFBQUYsRUFBRSxjQUFGLEVBQUUsR0FBSSxvQkFBb0IsQ0FBQyxDQUFDO1FBSjVCLGtCQUFhLEdBQWEsRUFBRSxDQUFDO1FBQzdCLGVBQVUsR0FBd0IsSUFBSSxHQUFHLEVBQUUsQ0FBQztJQUlwRCxDQUFDO0lBRVEsTUFBTSxDQUFDLEtBQW9CO1FBQ2xDLHNEQUFzRDs7UUFFdEQsMEJBQTBCO1FBQzFCLE1BQU0sS0FBSyxHQUFHLENBQUMsTUFBQSxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLG1DQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUMzRCxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXpDLDRCQUE0QjtRQUM1QixJQUFJLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUN0QixJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxXQUFXLEtBQUssQ0FBQyxTQUFTLEtBQUssS0FBSyxDQUFDLFdBQVcsU0FBUyxDQUFDLENBQUM7UUFDckYsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxXQUFXLEtBQUssQ0FBQyxTQUFTLFlBQVksS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUM7UUFDakYsQ0FBQztJQUNILENBQUM7SUFFRCxtRUFBbUU7SUFDbkUsZ0JBQWdCO1FBQ2QsT0FBTyxDQUFDLEdBQUcsSUFBSSxDQUFDLGFBQWEsQ0FBQyxDQUFDO0lBQ2pDLENBQUM7SUFFRCwyQ0FBMkM7SUFDM0MsYUFBYTtRQUNYLE9BQU8sSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQ2xDLENBQUM7SUFFUSxLQUFLO1FBQ1osS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ2QsSUFBSSxDQUFDLGFBQWEsR0FBRyxFQUFFLENBQUM7UUFDeEIsSUFBSSxDQUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUMxQixDQUFDO0NBQ0Y7QUF0Q0Qsc0VBc0NDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTZXBhcmF0ZU5hcnJhdGl2ZUZsb3dSZWNvcmRlciDigJQgQ29sbGVjdHMgbG9vcCBpdGVyYXRpb25zIGluIGEgc2VwYXJhdGUgY2hhbm5lbC5cbiAqXG4gKiBLZWVwcyB0aGUgbWFpbiBuYXJyYXRpdmUgY2xlYW4gKG5vIGxvb3Agc2VudGVuY2VzKSB3aGlsZSBwcmVzZXJ2aW5nIGZ1bGxcbiAqIGl0ZXJhdGlvbiBkZXRhaWwgaW4gYSBzZXBhcmF0ZSBhY2Nlc3NvciBmb3IgY29uc3VtZXJzIHdobyBuZWVkIGl0LlxuICpcbiAqIEJlc3QgZm9yOiBVSXMgb3IgcmVwb3J0cyB3aGVyZSBsb29wIGRldGFpbCBpcyBpbiBhIGNvbGxhcHNpYmxlIHNlY3Rpb24sXG4gKiBvciBMTE0gcGlwZWxpbmVzIHdoZXJlIGxvb3AgY29udGV4dCBzaG91bGQgYmUgYXZhaWxhYmxlIGJ1dCBub3QgaW4gdGhlIG1haW4gcHJvbXB0LlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBjb25zdCByZWNvcmRlciA9IG5ldyBTZXBhcmF0ZU5hcnJhdGl2ZUZsb3dSZWNvcmRlcigpO1xuICogZXhlY3V0b3IuYXR0YWNoRmxvd1JlY29yZGVyKHJlY29yZGVyKTtcbiAqIGF3YWl0IGV4ZWN1dG9yLnJ1bigpO1xuICpcbiAqIGNvbnN0IG1haW5OYXJyYXRpdmUgPSBleGVjdXRvci5nZXROYXJyYXRpdmUoKTsgICAgIC8vIE5vIGxvb3Agc2VudGVuY2VzXG4gKiBjb25zdCBsb29wRGV0YWlsID0gcmVjb3JkZXIuZ2V0TG9vcFNlbnRlbmNlcygpOyAgICAvLyBBbGwgbG9vcCBkZXRhaWxcbiAqIGBgYFxuICovXG5cbmltcG9ydCB7IE5hcnJhdGl2ZUZsb3dSZWNvcmRlciB9IGZyb20gJy4uL05hcnJhdGl2ZUZsb3dSZWNvcmRlci5qcyc7XG5pbXBvcnQgdHlwZSB7IEZsb3dMb29wRXZlbnQgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBjbGFzcyBTZXBhcmF0ZU5hcnJhdGl2ZUZsb3dSZWNvcmRlciBleHRlbmRzIE5hcnJhdGl2ZUZsb3dSZWNvcmRlciB7XG4gIHByaXZhdGUgbG9vcFNlbnRlbmNlczogc3RyaW5nW10gPSBbXTtcbiAgcHJpdmF0ZSBsb29wQ291bnRzOiBNYXA8c3RyaW5nLCBudW1iZXI+ID0gbmV3IE1hcCgpO1xuXG4gIGNvbnN0cnVjdG9yKGlkPzogc3RyaW5nKSB7XG4gICAgc3VwZXIoaWQgPz8gJ25hcnJhdGl2ZS1zZXBhcmF0ZScpO1xuICB9XG5cbiAgb3ZlcnJpZGUgb25Mb29wKGV2ZW50OiBGbG93TG9vcEV2ZW50KTogdm9pZCB7XG4gICAgLy8gRG9uJ3QgY2FsbCBzdXBlciDigJQga2VlcCBsb29wcyBvdXQgb2YgbWFpbiBuYXJyYXRpdmVcblxuICAgIC8vIFRyYWNrIGNvdW50IGZvciBzdW1tYXJ5XG4gICAgY29uc3QgY291bnQgPSAodGhpcy5sb29wQ291bnRzLmdldChldmVudC50YXJnZXQpID8/IDApICsgMTtcbiAgICB0aGlzLmxvb3BDb3VudHMuc2V0KGV2ZW50LnRhcmdldCwgY291bnQpO1xuXG4gICAgLy8gU3RvcmUgaW4gc2VwYXJhdGUgY2hhbm5lbFxuICAgIGlmIChldmVudC5kZXNjcmlwdGlvbikge1xuICAgICAgdGhpcy5sb29wU2VudGVuY2VzLnB1c2goYE9uIHBhc3MgJHtldmVudC5pdGVyYXRpb259OiAke2V2ZW50LmRlc2NyaXB0aW9ufSBhZ2Fpbi5gKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5sb29wU2VudGVuY2VzLnB1c2goYE9uIHBhc3MgJHtldmVudC5pdGVyYXRpb259IHRocm91Z2ggJHtldmVudC50YXJnZXR9LmApO1xuICAgIH1cbiAgfVxuXG4gIC8qKiBSZXR1cm5zIGFsbCBsb29wIGl0ZXJhdGlvbiBzZW50ZW5jZXMgKHRoZSBzZXBhcmF0ZSBjaGFubmVsKS4gKi9cbiAgZ2V0TG9vcFNlbnRlbmNlcygpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIFsuLi50aGlzLmxvb3BTZW50ZW5jZXNdO1xuICB9XG5cbiAgLyoqIFJldHVybnMgdG90YWwgbG9vcCBjb3VudCBwZXIgdGFyZ2V0LiAqL1xuICBnZXRMb29wQ291bnRzKCk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICAgIHJldHVybiBuZXcgTWFwKHRoaXMubG9vcENvdW50cyk7XG4gIH1cblxuICBvdmVycmlkZSBjbGVhcigpOiB2b2lkIHtcbiAgICBzdXBlci5jbGVhcigpO1xuICAgIHRoaXMubG9vcFNlbnRlbmNlcyA9IFtdO1xuICAgIHRoaXMubG9vcENvdW50cy5jbGVhcigpO1xuICB9XG59XG4iXX0=