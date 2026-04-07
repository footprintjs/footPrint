/**
 * RLENarrativeFlowRecorder — Run-Length Encoding for consecutive identical loop targets.
 *
 * Instead of emitting one sentence per iteration, collapses consecutive loops
 * through the same target into a single "Looped N times through X" sentence.
 *
 * Best for: Simple retry loops where every iteration looks the same.
 *
 * @example
 * ```typescript
 * executor.attachFlowRecorder(new RLENarrativeFlowRecorder());
 * // Instead of 50 "On pass N..." lines:
 * // "Looped through AskLLM 50 times (passes 1–50)."
 * ```
 */
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
export class RLENarrativeFlowRecorder extends NarrativeFlowRecorder {
    constructor(id) {
        super(id !== null && id !== void 0 ? id : 'narrative-rle');
        this.currentRun = null;
        this.completedRuns = [];
    }
    onLoop(event) {
        // Don't call super — we handle sentence generation ourselves
        if (this.currentRun && this.currentRun.target === event.target) {
            // Extend the current run
            this.currentRun.endIteration = event.iteration;
        }
        else {
            // Flush previous run and start new one
            if (this.currentRun) {
                this.completedRuns.push(this.currentRun);
            }
            this.currentRun = {
                target: event.target,
                startIteration: event.iteration,
                endIteration: event.iteration,
                description: event.description,
            };
        }
    }
    getSentences() {
        // Flush any pending run
        const runs = [...this.completedRuns];
        if (this.currentRun) {
            runs.push(this.currentRun);
        }
        const base = super.getSentences();
        // Inject RLE summaries
        const summaries = [];
        for (const run of runs) {
            const count = run.endIteration - run.startIteration + 1;
            if (count === 1) {
                // Single iteration — emit normal sentence
                if (run.description) {
                    summaries.push(`On pass ${run.startIteration}: ${run.description} again.`);
                }
                else {
                    summaries.push(`On pass ${run.startIteration} through ${run.target}.`);
                }
            }
            else {
                summaries.push(`Looped through ${run.target} ${count} times (passes ${run.startIteration}–${run.endIteration}).`);
            }
        }
        return [...base, ...summaries];
    }
    clear() {
        super.clear();
        this.currentRun = null;
        this.completedRuns = [];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUkxFTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvbmFycmF0aXZlL3JlY29yZGVycy9STEVOYXJyYXRpdmVGbG93UmVjb3JkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7O0dBY0c7QUFFSCxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQztBQVVwRSxNQUFNLE9BQU8sd0JBQXlCLFNBQVEscUJBQXFCO0lBSWpFLFlBQVksRUFBVztRQUNyQixLQUFLLENBQUMsRUFBRSxhQUFGLEVBQUUsY0FBRixFQUFFLEdBQUksZUFBZSxDQUFDLENBQUM7UUFKdkIsZUFBVSxHQUFvQixJQUFJLENBQUM7UUFDbkMsa0JBQWEsR0FBZSxFQUFFLENBQUM7SUFJdkMsQ0FBQztJQUVRLE1BQU0sQ0FBQyxLQUFvQjtRQUNsQyw2REFBNkQ7UUFFN0QsSUFBSSxJQUFJLENBQUMsVUFBVSxJQUFJLElBQUksQ0FBQyxVQUFVLENBQUMsTUFBTSxLQUFLLEtBQUssQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUMvRCx5QkFBeUI7WUFDekIsSUFBSSxDQUFDLFVBQVUsQ0FBQyxZQUFZLEdBQUcsS0FBSyxDQUFDLFNBQVMsQ0FBQztRQUNqRCxDQUFDO2FBQU0sQ0FBQztZQUNOLHVDQUF1QztZQUN2QyxJQUFJLElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQztnQkFDcEIsSUFBSSxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1lBQzNDLENBQUM7WUFDRCxJQUFJLENBQUMsVUFBVSxHQUFHO2dCQUNoQixNQUFNLEVBQUUsS0FBSyxDQUFDLE1BQU07Z0JBQ3BCLGNBQWMsRUFBRSxLQUFLLENBQUMsU0FBUztnQkFDL0IsWUFBWSxFQUFFLEtBQUssQ0FBQyxTQUFTO2dCQUM3QixXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVc7YUFDL0IsQ0FBQztRQUNKLENBQUM7SUFDSCxDQUFDO0lBRVEsWUFBWTtRQUNuQix3QkFBd0I7UUFDeEIsTUFBTSxJQUFJLEdBQUcsQ0FBQyxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNyQyxJQUFJLElBQUksQ0FBQyxVQUFVLEVBQUUsQ0FBQztZQUNwQixJQUFJLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxVQUFVLENBQUMsQ0FBQztRQUM3QixDQUFDO1FBRUQsTUFBTSxJQUFJLEdBQUcsS0FBSyxDQUFDLFlBQVksRUFBRSxDQUFDO1FBRWxDLHVCQUF1QjtRQUN2QixNQUFNLFNBQVMsR0FBYSxFQUFFLENBQUM7UUFDL0IsS0FBSyxNQUFNLEdBQUcsSUFBSSxJQUFJLEVBQUUsQ0FBQztZQUN2QixNQUFNLEtBQUssR0FBRyxHQUFHLENBQUMsWUFBWSxHQUFHLEdBQUcsQ0FBQyxjQUFjLEdBQUcsQ0FBQyxDQUFDO1lBQ3hELElBQUksS0FBSyxLQUFLLENBQUMsRUFBRSxDQUFDO2dCQUNoQiwwQ0FBMEM7Z0JBQzFDLElBQUksR0FBRyxDQUFDLFdBQVcsRUFBRSxDQUFDO29CQUNwQixTQUFTLENBQUMsSUFBSSxDQUFDLFdBQVcsR0FBRyxDQUFDLGNBQWMsS0FBSyxHQUFHLENBQUMsV0FBVyxTQUFTLENBQUMsQ0FBQztnQkFDN0UsQ0FBQztxQkFBTSxDQUFDO29CQUNOLFNBQVMsQ0FBQyxJQUFJLENBQUMsV0FBVyxHQUFHLENBQUMsY0FBYyxZQUFZLEdBQUcsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO2dCQUN6RSxDQUFDO1lBQ0gsQ0FBQztpQkFBTSxDQUFDO2dCQUNOLFNBQVMsQ0FBQyxJQUFJLENBQ1osa0JBQWtCLEdBQUcsQ0FBQyxNQUFNLElBQUksS0FBSyxrQkFBa0IsR0FBRyxDQUFDLGNBQWMsSUFBSSxHQUFHLENBQUMsWUFBWSxJQUFJLENBQ2xHLENBQUM7WUFDSixDQUFDO1FBQ0gsQ0FBQztRQUVELE9BQU8sQ0FBQyxHQUFHLElBQUksRUFBRSxHQUFHLFNBQVMsQ0FBQyxDQUFDO0lBQ2pDLENBQUM7SUFFUSxLQUFLO1FBQ1osS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ2QsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLENBQUM7UUFDdkIsSUFBSSxDQUFDLGFBQWEsR0FBRyxFQUFFLENBQUM7SUFDMUIsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSTEVOYXJyYXRpdmVGbG93UmVjb3JkZXIg4oCUIFJ1bi1MZW5ndGggRW5jb2RpbmcgZm9yIGNvbnNlY3V0aXZlIGlkZW50aWNhbCBsb29wIHRhcmdldHMuXG4gKlxuICogSW5zdGVhZCBvZiBlbWl0dGluZyBvbmUgc2VudGVuY2UgcGVyIGl0ZXJhdGlvbiwgY29sbGFwc2VzIGNvbnNlY3V0aXZlIGxvb3BzXG4gKiB0aHJvdWdoIHRoZSBzYW1lIHRhcmdldCBpbnRvIGEgc2luZ2xlIFwiTG9vcGVkIE4gdGltZXMgdGhyb3VnaCBYXCIgc2VudGVuY2UuXG4gKlxuICogQmVzdCBmb3I6IFNpbXBsZSByZXRyeSBsb29wcyB3aGVyZSBldmVyeSBpdGVyYXRpb24gbG9va3MgdGhlIHNhbWUuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGV4ZWN1dG9yLmF0dGFjaEZsb3dSZWNvcmRlcihuZXcgUkxFTmFycmF0aXZlRmxvd1JlY29yZGVyKCkpO1xuICogLy8gSW5zdGVhZCBvZiA1MCBcIk9uIHBhc3MgTi4uLlwiIGxpbmVzOlxuICogLy8gXCJMb29wZWQgdGhyb3VnaCBBc2tMTE0gNTAgdGltZXMgKHBhc3NlcyAx4oCTNTApLlwiXG4gKiBgYGBcbiAqL1xuXG5pbXBvcnQgeyBOYXJyYXRpdmVGbG93UmVjb3JkZXIgfSBmcm9tICcuLi9OYXJyYXRpdmVGbG93UmVjb3JkZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93TG9vcEV2ZW50IH0gZnJvbSAnLi4vdHlwZXMuanMnO1xuXG5pbnRlcmZhY2UgUnVuR3JvdXAge1xuICB0YXJnZXQ6IHN0cmluZztcbiAgc3RhcnRJdGVyYXRpb246IG51bWJlcjtcbiAgZW5kSXRlcmF0aW9uOiBudW1iZXI7XG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xufVxuXG5leHBvcnQgY2xhc3MgUkxFTmFycmF0aXZlRmxvd1JlY29yZGVyIGV4dGVuZHMgTmFycmF0aXZlRmxvd1JlY29yZGVyIHtcbiAgcHJpdmF0ZSBjdXJyZW50UnVuOiBSdW5Hcm91cCB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGNvbXBsZXRlZFJ1bnM6IFJ1bkdyb3VwW10gPSBbXTtcblxuICBjb25zdHJ1Y3RvcihpZD86IHN0cmluZykge1xuICAgIHN1cGVyKGlkID8/ICduYXJyYXRpdmUtcmxlJyk7XG4gIH1cblxuICBvdmVycmlkZSBvbkxvb3AoZXZlbnQ6IEZsb3dMb29wRXZlbnQpOiB2b2lkIHtcbiAgICAvLyBEb24ndCBjYWxsIHN1cGVyIOKAlCB3ZSBoYW5kbGUgc2VudGVuY2UgZ2VuZXJhdGlvbiBvdXJzZWx2ZXNcblxuICAgIGlmICh0aGlzLmN1cnJlbnRSdW4gJiYgdGhpcy5jdXJyZW50UnVuLnRhcmdldCA9PT0gZXZlbnQudGFyZ2V0KSB7XG4gICAgICAvLyBFeHRlbmQgdGhlIGN1cnJlbnQgcnVuXG4gICAgICB0aGlzLmN1cnJlbnRSdW4uZW5kSXRlcmF0aW9uID0gZXZlbnQuaXRlcmF0aW9uO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBGbHVzaCBwcmV2aW91cyBydW4gYW5kIHN0YXJ0IG5ldyBvbmVcbiAgICAgIGlmICh0aGlzLmN1cnJlbnRSdW4pIHtcbiAgICAgICAgdGhpcy5jb21wbGV0ZWRSdW5zLnB1c2godGhpcy5jdXJyZW50UnVuKTtcbiAgICAgIH1cbiAgICAgIHRoaXMuY3VycmVudFJ1biA9IHtcbiAgICAgICAgdGFyZ2V0OiBldmVudC50YXJnZXQsXG4gICAgICAgIHN0YXJ0SXRlcmF0aW9uOiBldmVudC5pdGVyYXRpb24sXG4gICAgICAgIGVuZEl0ZXJhdGlvbjogZXZlbnQuaXRlcmF0aW9uLFxuICAgICAgICBkZXNjcmlwdGlvbjogZXZlbnQuZGVzY3JpcHRpb24sXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIG92ZXJyaWRlIGdldFNlbnRlbmNlcygpOiBzdHJpbmdbXSB7XG4gICAgLy8gRmx1c2ggYW55IHBlbmRpbmcgcnVuXG4gICAgY29uc3QgcnVucyA9IFsuLi50aGlzLmNvbXBsZXRlZFJ1bnNdO1xuICAgIGlmICh0aGlzLmN1cnJlbnRSdW4pIHtcbiAgICAgIHJ1bnMucHVzaCh0aGlzLmN1cnJlbnRSdW4pO1xuICAgIH1cblxuICAgIGNvbnN0IGJhc2UgPSBzdXBlci5nZXRTZW50ZW5jZXMoKTtcblxuICAgIC8vIEluamVjdCBSTEUgc3VtbWFyaWVzXG4gICAgY29uc3Qgc3VtbWFyaWVzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgcnVuIG9mIHJ1bnMpIHtcbiAgICAgIGNvbnN0IGNvdW50ID0gcnVuLmVuZEl0ZXJhdGlvbiAtIHJ1bi5zdGFydEl0ZXJhdGlvbiArIDE7XG4gICAgICBpZiAoY291bnQgPT09IDEpIHtcbiAgICAgICAgLy8gU2luZ2xlIGl0ZXJhdGlvbiDigJQgZW1pdCBub3JtYWwgc2VudGVuY2VcbiAgICAgICAgaWYgKHJ1bi5kZXNjcmlwdGlvbikge1xuICAgICAgICAgIHN1bW1hcmllcy5wdXNoKGBPbiBwYXNzICR7cnVuLnN0YXJ0SXRlcmF0aW9ufTogJHtydW4uZGVzY3JpcHRpb259IGFnYWluLmApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHN1bW1hcmllcy5wdXNoKGBPbiBwYXNzICR7cnVuLnN0YXJ0SXRlcmF0aW9ufSB0aHJvdWdoICR7cnVuLnRhcmdldH0uYCk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHN1bW1hcmllcy5wdXNoKFxuICAgICAgICAgIGBMb29wZWQgdGhyb3VnaCAke3J1bi50YXJnZXR9ICR7Y291bnR9IHRpbWVzIChwYXNzZXMgJHtydW4uc3RhcnRJdGVyYXRpb2594oCTJHtydW4uZW5kSXRlcmF0aW9ufSkuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICByZXR1cm4gWy4uLmJhc2UsIC4uLnN1bW1hcmllc107XG4gIH1cblxuICBvdmVycmlkZSBjbGVhcigpOiB2b2lkIHtcbiAgICBzdXBlci5jbGVhcigpO1xuICAgIHRoaXMuY3VycmVudFJ1biA9IG51bGw7XG4gICAgdGhpcy5jb21wbGV0ZWRSdW5zID0gW107XG4gIH1cbn1cbiJdfQ==