"use strict";
/**
 * EventLog — Time-travel snapshot storage for flowchart execution
 *
 * Like git history: stores commit bundles (diffs), not full snapshots.
 * materialise(stepIdx) reconstructs state at any point by replaying commits.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventLog = void 0;
const utils_js_1 = require("./utils.js");
class EventLog {
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
            out = (0, utils_js_1.applySmartMerge)(out, updates, overwrite, trace);
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
exports.EventLog = EventLog;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXZlbnRMb2cuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL21lbW9yeS9FdmVudExvZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUdILHlDQUE2QztBQUU3QyxNQUFhLFFBQVE7SUFNbkIsWUFBWSxhQUFrQjtRQUg5QixzQ0FBc0M7UUFDOUIsVUFBSyxHQUFtQixFQUFFLENBQUM7UUFHakMsSUFBSSxDQUFDLElBQUksR0FBRyxlQUFlLENBQUMsYUFBYSxDQUFDLENBQUM7SUFDN0MsQ0FBQztJQUVEOzs7T0FHRztJQUNILFdBQVcsQ0FBQyxPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNO1FBQ3JDLElBQUksR0FBRyxHQUFHLGVBQWUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDckMsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLE9BQU8sRUFBRSxDQUFDLEVBQUUsRUFBRSxDQUFDO1lBQ2pDLE1BQU0sRUFBRSxTQUFTLEVBQUUsT0FBTyxFQUFFLEtBQUssRUFBRSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7WUFDcEQsR0FBRyxHQUFHLElBQUEsMEJBQWUsRUFBQyxHQUFHLEVBQUUsT0FBc0IsRUFBRSxTQUF3QixFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3RGLENBQUM7UUFDRCxPQUFPLEdBQUcsQ0FBQztJQUNiLENBQUM7SUFFRCxxREFBcUQ7SUFDckQsTUFBTSxDQUFDLE1BQW9CO1FBQ3pCLE1BQU0sQ0FBQyxHQUFHLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUM7UUFDL0IsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDMUIsQ0FBQztJQUVELHdDQUF3QztJQUN4QyxJQUFJO1FBQ0YsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDO0lBQ3BCLENBQUM7SUFFRCxrQ0FBa0M7SUFDbEMsSUFBSSxNQUFNO1FBQ1IsT0FBTyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQztJQUMzQixDQUFDO0lBRUQsOENBQThDO0lBQzlDLEtBQUs7UUFDSCxJQUFJLENBQUMsS0FBSyxHQUFHLEVBQUUsQ0FBQztJQUNsQixDQUFDO0NBQ0Y7QUEzQ0QsNEJBMkNDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBFdmVudExvZyDigJQgVGltZS10cmF2ZWwgc25hcHNob3Qgc3RvcmFnZSBmb3IgZmxvd2NoYXJ0IGV4ZWN1dGlvblxuICpcbiAqIExpa2UgZ2l0IGhpc3Rvcnk6IHN0b3JlcyBjb21taXQgYnVuZGxlcyAoZGlmZnMpLCBub3QgZnVsbCBzbmFwc2hvdHMuXG4gKiBtYXRlcmlhbGlzZShzdGVwSWR4KSByZWNvbnN0cnVjdHMgc3RhdGUgYXQgYW55IHBvaW50IGJ5IHJlcGxheWluZyBjb21taXRzLlxuICovXG5cbmltcG9ydCB0eXBlIHsgQ29tbWl0QnVuZGxlLCBNZW1vcnlQYXRjaCB9IGZyb20gJy4vdHlwZXMuanMnO1xuaW1wb3J0IHsgYXBwbHlTbWFydE1lcmdlIH0gZnJvbSAnLi91dGlscy5qcyc7XG5cbmV4cG9ydCBjbGFzcyBFdmVudExvZyB7XG4gIC8qKiBCYXNlIHNuYXBzaG90IEJFRk9SRSB0aGUgZmlyc3Qgc3RhZ2UgbXV0YXRlcyBhbnl0aGluZy4gKi9cbiAgcHJpdmF0ZSBiYXNlOiBhbnk7XG4gIC8qKiBPcmRlcmVkIGxpc3Qgb2YgY29tbWl0IGJ1bmRsZXMuICovXG4gIHByaXZhdGUgc3RlcHM6IENvbW1pdEJ1bmRsZVtdID0gW107XG5cbiAgY29uc3RydWN0b3IoaW5pdGlhbE1lbW9yeTogYW55KSB7XG4gICAgdGhpcy5iYXNlID0gc3RydWN0dXJlZENsb25lKGluaXRpYWxNZW1vcnkpO1xuICB9XG5cbiAgLyoqXG4gICAqIFJlY29uc3RydWN0cyB0aGUgZnVsbCBzdGF0ZSBhdCBhbnkgZ2l2ZW4gc3RlcC5cbiAgICogUmVwbGF5cyBjb21taXRzIGZyb20gdGhlIGJlZ2lubmluZyDigJQgTyhuKSBidXQgbG93IG1lbW9yeSBmb290cHJpbnQuXG4gICAqL1xuICBtYXRlcmlhbGlzZShzdGVwSWR4ID0gdGhpcy5zdGVwcy5sZW5ndGgpOiBhbnkge1xuICAgIGxldCBvdXQgPSBzdHJ1Y3R1cmVkQ2xvbmUodGhpcy5iYXNlKTtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHN0ZXBJZHg7IGkrKykge1xuICAgICAgY29uc3QgeyBvdmVyd3JpdGUsIHVwZGF0ZXMsIHRyYWNlIH0gPSB0aGlzLnN0ZXBzW2ldO1xuICAgICAgb3V0ID0gYXBwbHlTbWFydE1lcmdlKG91dCwgdXBkYXRlcyBhcyBNZW1vcnlQYXRjaCwgb3ZlcndyaXRlIGFzIE1lbW9yeVBhdGNoLCB0cmFjZSk7XG4gICAgfVxuICAgIHJldHVybiBvdXQ7XG4gIH1cblxuICAvKiogUGVyc2lzdHMgYSBjb21taXQgYnVuZGxlIGZvciBhIGZpbmlzaGVkIHN0YWdlLiAqL1xuICByZWNvcmQoYnVuZGxlOiBDb21taXRCdW5kbGUpOiB2b2lkIHtcbiAgICBidW5kbGUuaWR4ID0gdGhpcy5zdGVwcy5sZW5ndGg7XG4gICAgdGhpcy5zdGVwcy5wdXNoKGJ1bmRsZSk7XG4gIH1cblxuICAvKiogR2V0cyBhbGwgcmVjb3JkZWQgY29tbWl0IGJ1bmRsZXMuICovXG4gIGxpc3QoKTogQ29tbWl0QnVuZGxlW10ge1xuICAgIHJldHVybiB0aGlzLnN0ZXBzO1xuICB9XG5cbiAgLyoqIE51bWJlciBvZiByZWNvcmRlZCBjb21taXRzLiAqL1xuICBnZXQgbGVuZ3RoKCk6IG51bWJlciB7XG4gICAgcmV0dXJuIHRoaXMuc3RlcHMubGVuZ3RoO1xuICB9XG5cbiAgLyoqIFdpcGVzIGhpc3RvcnkgKHVzZWZ1bCBmb3IgdGVzdCByZXNldHMpLiAqL1xuICBjbGVhcigpOiB2b2lkIHtcbiAgICB0aGlzLnN0ZXBzID0gW107XG4gIH1cbn1cbiJdfQ==