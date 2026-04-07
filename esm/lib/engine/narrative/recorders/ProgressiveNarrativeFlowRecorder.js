/**
 * ProgressiveNarrativeFlowRecorder — Exponentially decreasing detail as iterations grow.
 *
 * Emits at exponentially increasing intervals: 1, 2, 4, 8, 16, 32, ...
 * Gives rich detail for early iterations and progressively less as the loop continues.
 *
 * Best for: Convergence-style loops (gradient descent, iterative refinement)
 * where early iterations are most informative.
 *
 * @example
 * ```typescript
 * executor.attachFlowRecorder(new ProgressiveNarrativeFlowRecorder());
 * // Emits: pass 1, 2, 4, 8, 16, 32, 64, 128...
 * ```
 */
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
export class ProgressiveNarrativeFlowRecorder extends NarrativeFlowRecorder {
    /**
     * @param base - The exponential base. Default 2 means emit at 1, 2, 4, 8, 16...
     */
    constructor(base = 2, id) {
        super(id !== null && id !== void 0 ? id : 'narrative-progressive');
        this.suppressedCount = 0;
        this.base = base;
    }
    onLoop(event) {
        if (this.shouldEmit(event.iteration)) {
            super.onLoop(event);
        }
        else {
            this.suppressedCount++;
        }
    }
    shouldEmit(iteration) {
        // Always emit iteration 1
        if (iteration === 1)
            return true;
        // Emit if iteration is a power of base
        let power = 1;
        while (power < iteration) {
            power *= this.base;
        }
        return power === iteration;
    }
    /** Returns the number of suppressed loop sentences. */
    getSuppressedCount() {
        return this.suppressedCount;
    }
    clear() {
        super.clear();
        this.suppressedCount = 0;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUHJvZ3Jlc3NpdmVOYXJyYXRpdmVGbG93UmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL1Byb2dyZXNzaXZlTmFycmF0aXZlRmxvd1JlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7OztHQWNHO0FBRUgsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sNkJBQTZCLENBQUM7QUFHcEUsTUFBTSxPQUFPLGdDQUFpQyxTQUFRLHFCQUFxQjtJQUl6RTs7T0FFRztJQUNILFlBQVksSUFBSSxHQUFHLENBQUMsRUFBRSxFQUFXO1FBQy9CLEtBQUssQ0FBQyxFQUFFLGFBQUYsRUFBRSxjQUFGLEVBQUUsR0FBSSx1QkFBdUIsQ0FBQyxDQUFDO1FBTi9CLG9CQUFlLEdBQUcsQ0FBQyxDQUFDO1FBTzFCLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO0lBQ25CLENBQUM7SUFFUSxNQUFNLENBQUMsS0FBb0I7UUFDbEMsSUFBSSxJQUFJLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO1lBQ3JDLEtBQUssQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdEIsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLENBQUMsZUFBZSxFQUFFLENBQUM7UUFDekIsQ0FBQztJQUNILENBQUM7SUFFTyxVQUFVLENBQUMsU0FBaUI7UUFDbEMsMEJBQTBCO1FBQzFCLElBQUksU0FBUyxLQUFLLENBQUM7WUFBRSxPQUFPLElBQUksQ0FBQztRQUNqQyx1Q0FBdUM7UUFDdkMsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO1FBQ2QsT0FBTyxLQUFLLEdBQUcsU0FBUyxFQUFFLENBQUM7WUFDekIsS0FBSyxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUM7UUFDckIsQ0FBQztRQUNELE9BQU8sS0FBSyxLQUFLLFNBQVMsQ0FBQztJQUM3QixDQUFDO0lBRUQsdURBQXVEO0lBQ3ZELGtCQUFrQjtRQUNoQixPQUFPLElBQUksQ0FBQyxlQUFlLENBQUM7SUFDOUIsQ0FBQztJQUVRLEtBQUs7UUFDWixLQUFLLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDZCxJQUFJLENBQUMsZUFBZSxHQUFHLENBQUMsQ0FBQztJQUMzQixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFByb2dyZXNzaXZlTmFycmF0aXZlRmxvd1JlY29yZGVyIOKAlCBFeHBvbmVudGlhbGx5IGRlY3JlYXNpbmcgZGV0YWlsIGFzIGl0ZXJhdGlvbnMgZ3Jvdy5cbiAqXG4gKiBFbWl0cyBhdCBleHBvbmVudGlhbGx5IGluY3JlYXNpbmcgaW50ZXJ2YWxzOiAxLCAyLCA0LCA4LCAxNiwgMzIsIC4uLlxuICogR2l2ZXMgcmljaCBkZXRhaWwgZm9yIGVhcmx5IGl0ZXJhdGlvbnMgYW5kIHByb2dyZXNzaXZlbHkgbGVzcyBhcyB0aGUgbG9vcCBjb250aW51ZXMuXG4gKlxuICogQmVzdCBmb3I6IENvbnZlcmdlbmNlLXN0eWxlIGxvb3BzIChncmFkaWVudCBkZXNjZW50LCBpdGVyYXRpdmUgcmVmaW5lbWVudClcbiAqIHdoZXJlIGVhcmx5IGl0ZXJhdGlvbnMgYXJlIG1vc3QgaW5mb3JtYXRpdmUuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGV4ZWN1dG9yLmF0dGFjaEZsb3dSZWNvcmRlcihuZXcgUHJvZ3Jlc3NpdmVOYXJyYXRpdmVGbG93UmVjb3JkZXIoKSk7XG4gKiAvLyBFbWl0czogcGFzcyAxLCAyLCA0LCA4LCAxNiwgMzIsIDY0LCAxMjguLi5cbiAqIGBgYFxuICovXG5cbmltcG9ydCB7IE5hcnJhdGl2ZUZsb3dSZWNvcmRlciB9IGZyb20gJy4uL05hcnJhdGl2ZUZsb3dSZWNvcmRlci5qcyc7XG5pbXBvcnQgdHlwZSB7IEZsb3dMb29wRXZlbnQgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBjbGFzcyBQcm9ncmVzc2l2ZU5hcnJhdGl2ZUZsb3dSZWNvcmRlciBleHRlbmRzIE5hcnJhdGl2ZUZsb3dSZWNvcmRlciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgYmFzZTogbnVtYmVyO1xuICBwcml2YXRlIHN1cHByZXNzZWRDb3VudCA9IDA7XG5cbiAgLyoqXG4gICAqIEBwYXJhbSBiYXNlIC0gVGhlIGV4cG9uZW50aWFsIGJhc2UuIERlZmF1bHQgMiBtZWFucyBlbWl0IGF0IDEsIDIsIDQsIDgsIDE2Li4uXG4gICAqL1xuICBjb25zdHJ1Y3RvcihiYXNlID0gMiwgaWQ/OiBzdHJpbmcpIHtcbiAgICBzdXBlcihpZCA/PyAnbmFycmF0aXZlLXByb2dyZXNzaXZlJyk7XG4gICAgdGhpcy5iYXNlID0gYmFzZTtcbiAgfVxuXG4gIG92ZXJyaWRlIG9uTG9vcChldmVudDogRmxvd0xvb3BFdmVudCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnNob3VsZEVtaXQoZXZlbnQuaXRlcmF0aW9uKSkge1xuICAgICAgc3VwZXIub25Mb29wKGV2ZW50KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zdXBwcmVzc2VkQ291bnQrKztcbiAgICB9XG4gIH1cblxuICBwcml2YXRlIHNob3VsZEVtaXQoaXRlcmF0aW9uOiBudW1iZXIpOiBib29sZWFuIHtcbiAgICAvLyBBbHdheXMgZW1pdCBpdGVyYXRpb24gMVxuICAgIGlmIChpdGVyYXRpb24gPT09IDEpIHJldHVybiB0cnVlO1xuICAgIC8vIEVtaXQgaWYgaXRlcmF0aW9uIGlzIGEgcG93ZXIgb2YgYmFzZVxuICAgIGxldCBwb3dlciA9IDE7XG4gICAgd2hpbGUgKHBvd2VyIDwgaXRlcmF0aW9uKSB7XG4gICAgICBwb3dlciAqPSB0aGlzLmJhc2U7XG4gICAgfVxuICAgIHJldHVybiBwb3dlciA9PT0gaXRlcmF0aW9uO1xuICB9XG5cbiAgLyoqIFJldHVybnMgdGhlIG51bWJlciBvZiBzdXBwcmVzc2VkIGxvb3Agc2VudGVuY2VzLiAqL1xuICBnZXRTdXBwcmVzc2VkQ291bnQoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5zdXBwcmVzc2VkQ291bnQ7XG4gIH1cblxuICBvdmVycmlkZSBjbGVhcigpOiB2b2lkIHtcbiAgICBzdXBlci5jbGVhcigpO1xuICAgIHRoaXMuc3VwcHJlc3NlZENvdW50ID0gMDtcbiAgfVxufVxuIl19