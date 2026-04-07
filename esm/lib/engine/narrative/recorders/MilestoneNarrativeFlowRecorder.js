/**
 * MilestoneNarrativeFlowRecorder — Emits every Nth iteration (milestones only).
 *
 * Best for: High-iteration loops where you want regular progress markers
 * without caring about individual iterations.
 *
 * @example
 * ```typescript
 * // Emit every 10th iteration
 * executor.attachFlowRecorder(new MilestoneNarrativeFlowRecorder(10));
 * ```
 */
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
export class MilestoneNarrativeFlowRecorder extends NarrativeFlowRecorder {
    constructor(interval = 10, alwaysEmitFirst = true, id) {
        super(id !== null && id !== void 0 ? id : 'narrative-milestone');
        this.suppressedCount = 0;
        this.interval = interval;
        this.alwaysEmitFirst = alwaysEmitFirst;
    }
    onLoop(event) {
        if (this.alwaysEmitFirst && event.iteration === 1) {
            super.onLoop(event);
        }
        else if (event.iteration % this.interval === 0) {
            super.onLoop(event);
        }
        else {
            this.suppressedCount++;
        }
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTWlsZXN0b25lTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvbmFycmF0aXZlL3JlY29yZGVycy9NaWxlc3RvbmVOYXJyYXRpdmVGbG93UmVjb3JkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7O0dBV0c7QUFFSCxPQUFPLEVBQUUscUJBQXFCLEVBQUUsTUFBTSw2QkFBNkIsQ0FBQztBQUdwRSxNQUFNLE9BQU8sOEJBQStCLFNBQVEscUJBQXFCO0lBS3ZFLFlBQVksUUFBUSxHQUFHLEVBQUUsRUFBRSxlQUFlLEdBQUcsSUFBSSxFQUFFLEVBQVc7UUFDNUQsS0FBSyxDQUFDLEVBQUUsYUFBRixFQUFFLGNBQUYsRUFBRSxHQUFJLHFCQUFxQixDQUFDLENBQUM7UUFIN0Isb0JBQWUsR0FBRyxDQUFDLENBQUM7UUFJMUIsSUFBSSxDQUFDLFFBQVEsR0FBRyxRQUFRLENBQUM7UUFDekIsSUFBSSxDQUFDLGVBQWUsR0FBRyxlQUFlLENBQUM7SUFDekMsQ0FBQztJQUVRLE1BQU0sQ0FBQyxLQUFvQjtRQUNsQyxJQUFJLElBQUksQ0FBQyxlQUFlLElBQUksS0FBSyxDQUFDLFNBQVMsS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUNsRCxLQUFLLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3RCLENBQUM7YUFBTSxJQUFJLEtBQUssQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLFFBQVEsS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUNqRCxLQUFLLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ3RCLENBQUM7YUFBTSxDQUFDO1lBQ04sSUFBSSxDQUFDLGVBQWUsRUFBRSxDQUFDO1FBQ3pCLENBQUM7SUFDSCxDQUFDO0lBRUQsdURBQXVEO0lBQ3ZELGtCQUFrQjtRQUNoQixPQUFPLElBQUksQ0FBQyxlQUFlLENBQUM7SUFDOUIsQ0FBQztJQUVRLEtBQUs7UUFDWixLQUFLLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDZCxJQUFJLENBQUMsZUFBZSxHQUFHLENBQUMsQ0FBQztJQUMzQixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE1pbGVzdG9uZU5hcnJhdGl2ZUZsb3dSZWNvcmRlciDigJQgRW1pdHMgZXZlcnkgTnRoIGl0ZXJhdGlvbiAobWlsZXN0b25lcyBvbmx5KS5cbiAqXG4gKiBCZXN0IGZvcjogSGlnaC1pdGVyYXRpb24gbG9vcHMgd2hlcmUgeW91IHdhbnQgcmVndWxhciBwcm9ncmVzcyBtYXJrZXJzXG4gKiB3aXRob3V0IGNhcmluZyBhYm91dCBpbmRpdmlkdWFsIGl0ZXJhdGlvbnMuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIC8vIEVtaXQgZXZlcnkgMTB0aCBpdGVyYXRpb25cbiAqIGV4ZWN1dG9yLmF0dGFjaEZsb3dSZWNvcmRlcihuZXcgTWlsZXN0b25lTmFycmF0aXZlRmxvd1JlY29yZGVyKDEwKSk7XG4gKiBgYGBcbiAqL1xuXG5pbXBvcnQgeyBOYXJyYXRpdmVGbG93UmVjb3JkZXIgfSBmcm9tICcuLi9OYXJyYXRpdmVGbG93UmVjb3JkZXIuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93TG9vcEV2ZW50IH0gZnJvbSAnLi4vdHlwZXMuanMnO1xuXG5leHBvcnQgY2xhc3MgTWlsZXN0b25lTmFycmF0aXZlRmxvd1JlY29yZGVyIGV4dGVuZHMgTmFycmF0aXZlRmxvd1JlY29yZGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBpbnRlcnZhbDogbnVtYmVyO1xuICBwcml2YXRlIHJlYWRvbmx5IGFsd2F5c0VtaXRGaXJzdDogYm9vbGVhbjtcbiAgcHJpdmF0ZSBzdXBwcmVzc2VkQ291bnQgPSAwO1xuXG4gIGNvbnN0cnVjdG9yKGludGVydmFsID0gMTAsIGFsd2F5c0VtaXRGaXJzdCA9IHRydWUsIGlkPzogc3RyaW5nKSB7XG4gICAgc3VwZXIoaWQgPz8gJ25hcnJhdGl2ZS1taWxlc3RvbmUnKTtcbiAgICB0aGlzLmludGVydmFsID0gaW50ZXJ2YWw7XG4gICAgdGhpcy5hbHdheXNFbWl0Rmlyc3QgPSBhbHdheXNFbWl0Rmlyc3Q7XG4gIH1cblxuICBvdmVycmlkZSBvbkxvb3AoZXZlbnQ6IEZsb3dMb29wRXZlbnQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy5hbHdheXNFbWl0Rmlyc3QgJiYgZXZlbnQuaXRlcmF0aW9uID09PSAxKSB7XG4gICAgICBzdXBlci5vbkxvb3AoZXZlbnQpO1xuICAgIH0gZWxzZSBpZiAoZXZlbnQuaXRlcmF0aW9uICUgdGhpcy5pbnRlcnZhbCA9PT0gMCkge1xuICAgICAgc3VwZXIub25Mb29wKGV2ZW50KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zdXBwcmVzc2VkQ291bnQrKztcbiAgICB9XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgbnVtYmVyIG9mIHN1cHByZXNzZWQgbG9vcCBzZW50ZW5jZXMuICovXG4gIGdldFN1cHByZXNzZWRDb3VudCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnN1cHByZXNzZWRDb3VudDtcbiAgfVxuXG4gIG92ZXJyaWRlIGNsZWFyKCk6IHZvaWQge1xuICAgIHN1cGVyLmNsZWFyKCk7XG4gICAgdGhpcy5zdXBwcmVzc2VkQ291bnQgPSAwO1xuICB9XG59XG4iXX0=