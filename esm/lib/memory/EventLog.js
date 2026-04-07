/**
 * EventLog — Time-travel snapshot storage for flowchart execution
 *
 * Like git history: stores commit bundles (diffs), not full snapshots.
 * materialise(stepIdx) reconstructs state at any point by replaying commits.
 */
import { applySmartMerge } from './utils.js';
export class EventLog {
    constructor(initialMemory) {
        /** Ordered list of commit bundles. */
        this.steps = [];
        this.base = structuredClone(initialMemory);
    }
    /**
     * Reconstructs the full state at any given step.
     * Replays commits from the beginning — O(n) but low memory footprint.
     */
    materialise(stepIdx = this.steps.length) {
        let out = structuredClone(this.base);
        for (let i = 0; i < stepIdx; i++) {
            const { overwrite, updates, trace } = this.steps[i];
            out = applySmartMerge(out, updates, overwrite, trace);
        }
        return out;
    }
    /** Persists a commit bundle for a finished stage. */
    record(bundle) {
        bundle.idx = this.steps.length;
        this.steps.push(bundle);
    }
    /** Gets all recorded commit bundles. */
    list() {
        return this.steps;
    }
    /** Number of recorded commits. */
    get length() {
        return this.steps.length;
    }
    /** Wipes history (useful for test resets). */
    clear() {
        this.steps = [];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXZlbnRMb2cuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL21lbW9yeS9FdmVudExvZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7R0FLRztBQUdILE9BQU8sRUFBRSxlQUFlLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFFN0MsTUFBTSxPQUFPLFFBQVE7SUFNbkIsWUFBWSxhQUFrQjtRQUg5QixzQ0FBc0M7UUFDOUIsVUFBSyxHQUFtQixFQUFFLENBQUM7UUFHakMsSUFBSSxDQUFDLElBQUksR0FBRyxlQUFlLENBQUMsYUFBYSxDQUFDLENBQUM7SUFDN0MsQ0FBQztJQUVEOzs7T0FHRztJQUNILFdBQVcsQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNO1FBQ3JDLElBQUksR0FBRyxHQUFHLGVBQWUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDckMsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLE9BQU8sRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQ2pDLE1BQU0sRUFBRSxTQUFTLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDcEQsR0FBRyxHQUFHLGVBQWUsQ0FBQyxHQUFHLEVBQUUsT0FBc0IsRUFBRSxTQUF3QixFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3RGLENBQUM7UUFDRCxPQUFPLEdBQUcsQ0FBQztJQUNiLENBQUM7SUFFRCxxREFBcUQ7SUFDckQsTUFBTSxDQUFDLE1BQW9CO1FBQ3pCLE1BQU0sQ0FBQyxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUM7UUFDL0IsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDMUIsQ0FBQztJQUVELHdDQUF3QztJQUN4QyxJQUFJO1FBQ0YsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDO0lBQ3BCLENBQUM7SUFFRCxrQ0FBa0M7SUFDbEMsSUFBSSxNQUFNO1FBQ1IsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQztJQUMzQixDQUFDO0lBRUQsOENBQThDO0lBQzlDLEtBQUs7UUFDSCxJQUFJLENBQUMsS0FBSyxHQUFHLEVBQUUsQ0FBQztJQUNsQixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEV2ZW50TG9nIOKAlCBUaW1lLXRyYXZlbCBzbmFwc2hvdCBzdG9yYWdlIGZvciBmbG93Y2hhcnQgZXhlY3V0aW9uXG4gKlxuICogTGlrZSBnaXQgaGlzdG9yeTogc3RvcmVzIGNvbW1pdCBidW5kbGVzIChkaWZmcyksIG5vdCBmdWxsIHNuYXBzaG90cy5cbiAqIG1hdGVyaWFsaXNlKHN0ZXBJZHgpIHJlY29uc3RydWN0cyBzdGF0ZSBhdCBhbnkgcG9pbnQgYnkgcmVwbGF5aW5nIGNvbW1pdHMuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBDb21taXRCdW5kbGUsIE1lbW9yeVBhdGNoIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5pbXBvcnQgeyBhcHBseVNtYXJ0TWVyZ2UgfSBmcm9tICcuL3V0aWxzLmpzJztcblxuZXhwb3J0IGNsYXNzIEV2ZW50TG9nIHtcbiAgLyoqIEJhc2Ugc25hcHNob3QgQkVGT1JFIHRoZSBmaXJzdCBzdGFnZSBtdXRhdGVzIGFueXRoaW5nLiAqL1xuICBwcml2YXRlIGJhc2U6IGFueTtcbiAgLyoqIE9yZGVyZWQgbGlzdCBvZiBjb21taXQgYnVuZGxlcy4gKi9cbiAgcHJpdmF0ZSBzdGVwczogQ29tbWl0QnVuZGxlW10gPSBbXTtcblxuICBjb25zdHJ1Y3Rvcihpbml0aWFsTWVtb3J5OiBhbnkpIHtcbiAgICB0aGlzLmJhc2UgPSBzdHJ1Y3R1cmVkQ2xvbmUoaW5pdGlhbE1lbW9yeSk7XG4gIH1cblxuICAvKipcbiAgICogUmVjb25zdHJ1Y3RzIHRoZSBmdWxsIHN0YXRlIGF0IGFueSBnaXZlbiBzdGVwLlxuICAgKiBSZXBsYXlzIGNvbW1pdHMgZnJvbSB0aGUgYmVnaW5uaW5nIOKAlCBPKG4pIGJ1dCBsb3cgbWVtb3J5IGZvb3RwcmludC5cbiAgICovXG4gIG1hdGVyaWFsaXNlKHN0ZXBJZHggPSB0aGlzLnN0ZXBzLmxlbmd0aCk6IGFueSB7XG4gICAgbGV0IG91dCA9IHN0cnVjdHVyZWRDbG9uZSh0aGlzLmJhc2UpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgc3RlcElkeDsgaSsrKSB7XG4gICAgICBjb25zdCB7IG92ZXJ3cml0ZSwgdXBkYXRlcywgdHJhY2UgfSA9IHRoaXMuc3RlcHNbaV07XG4gICAgICBvdXQgPSBhcHBseVNtYXJ0TWVyZ2Uob3V0LCB1cGRhdGVzIGFzIE1lbW9yeVBhdGNoLCBvdmVyd3JpdGUgYXMgTWVtb3J5UGF0Y2gsIHRyYWNlKTtcbiAgICB9XG4gICAgcmV0dXJuIG91dDtcbiAgfVxuXG4gIC8qKiBQZXJzaXN0cyBhIGNvbW1pdCBidW5kbGUgZm9yIGEgZmluaXNoZWQgc3RhZ2UuICovXG4gIHJlY29yZChidW5kbGU6IENvbW1pdEJ1bmRsZSk6IHZvaWQge1xuICAgIGJ1bmRsZS5pZHggPSB0aGlzLnN0ZXBzLmxlbmd0aDtcbiAgICB0aGlzLnN0ZXBzLnB1c2goYnVuZGxlKTtcbiAgfVxuXG4gIC8qKiBHZXRzIGFsbCByZWNvcmRlZCBjb21taXQgYnVuZGxlcy4gKi9cbiAgbGlzdCgpOiBDb21taXRCdW5kbGVbXSB7XG4gICAgcmV0dXJuIHRoaXMuc3RlcHM7XG4gIH1cblxuICAvKiogTnVtYmVyIG9mIHJlY29yZGVkIGNvbW1pdHMuICovXG4gIGdldCBsZW5ndGgoKTogbnVtYmVyIHtcbiAgICByZXR1cm4gdGhpcy5zdGVwcy5sZW5ndGg7XG4gIH1cblxuICAvKiogV2lwZXMgaGlzdG9yeSAodXNlZnVsIGZvciB0ZXN0IHJlc2V0cykuICovXG4gIGNsZWFyKCk6IHZvaWQge1xuICAgIHRoaXMuc3RlcHMgPSBbXTtcbiAgfVxufVxuIl19