"use strict";
/**
 * WindowedNarrativeFlowRecorder — Shows first N and last M loop iterations, skips the middle.
 *
 * Best for: Moderate loops (10–200 iterations) where you want to see how it started
 * and how it ended, without the noise in between.
 *
 * When total iterations <= head + tail, all iterations are emitted (no compression).
 * When total > head + tail, the middle is replaced with a summary line.
 *
 * @example
 * ```typescript
 * // Show first 3 and last 2 iterations
 * executor.attachFlowRecorder(new WindowedNarrativeFlowRecorder(3, 2));
 * ```
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WindowedNarrativeFlowRecorder = void 0;
const NarrativeFlowRecorder_js_1 = require("../NarrativeFlowRecorder.js");
class WindowedNarrativeFlowRecorder extends NarrativeFlowRecorder_js_1.NarrativeFlowRecorder {
    constructor(head = 3, tail = 2, id) {
        super(id !== null && id !== void 0 ? id : 'narrative-windowed');
        this.loopEvents = new Map();
        this.head = head;
        this.tail = tail;
    }
    onLoop(event) {
        // Accumulate all loop events — we'll render them in getSentences
        const key = event.target;
        let events = this.loopEvents.get(key);
        if (!events) {
            events = [];
            this.loopEvents.set(key, events);
        }
        events.push(event);
        // Don't call super — we handle all loop sentence generation in getSentences
    }
    getSentences() {
        const baseSentences = super.getSentences();
        // Append windowed loop sentences for each target
        const result = [...baseSentences];
        for (const [, events] of this.loopEvents) {
            const total = events.length;
            if (total <= this.head + this.tail) {
                // Small loop — emit all iterations
                for (const ev of events) {
                    result.push(this.formatLoopSentence(ev));
                }
            }
            else {
                // Large loop — head + skip summary + tail
                for (let i = 0; i < this.head; i++) {
                    result.push(this.formatLoopSentence(events[i]));
                }
                const skipped = total - this.head - this.tail;
                result.push(`... (${skipped} iterations omitted)`);
                for (let i = total - this.tail; i < total; i++) {
                    result.push(this.formatLoopSentence(events[i]));
                }
            }
        }
        return result;
    }
    /** Returns the number of suppressed loop sentences. */
    getSuppressedCount() {
        let total = 0;
        for (const [, events] of this.loopEvents) {
            if (events.length > this.head + this.tail) {
                total += events.length - this.head - this.tail;
            }
        }
        return total;
    }
    clear() {
        super.clear();
        this.loopEvents.clear();
    }
    formatLoopSentence(event) {
        if (event.description) {
            return `On pass ${event.iteration}: ${event.description} again.`;
        }
        return `On pass ${event.iteration} through ${event.target}.`;
    }
}
exports.WindowedNarrativeFlowRecorder = WindowedNarrativeFlowRecorder;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiV2luZG93ZWROYXJyYXRpdmVGbG93UmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL1dpbmRvd2VkTmFycmF0aXZlRmxvd1JlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7R0FjRzs7O0FBRUgsMEVBQW9FO0FBR3BFLE1BQWEsNkJBQThCLFNBQVEsZ0RBQXFCO0lBS3RFLFlBQVksSUFBSSxHQUFHLENBQUMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxFQUFFLEVBQVc7UUFDekMsS0FBSyxDQUFDLEVBQUUsYUFBRixFQUFFLGNBQUYsRUFBRSxHQUFJLG9CQUFvQixDQUFDLENBQUM7UUFINUIsZUFBVSxHQUFpQyxJQUFJLEdBQUcsRUFBRSxDQUFDO1FBSTNELElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO1FBQ2pCLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDO0lBQ25CLENBQUM7SUFFUSxNQUFNLENBQUMsS0FBb0I7UUFDbEMsaUVBQWlFO1FBQ2pFLE1BQU0sR0FBRyxHQUFHLEtBQUssQ0FBQyxNQUFNLENBQUM7UUFDekIsSUFBSSxNQUFNLEdBQUcsSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDdEMsSUFBSSxDQUFDLE1BQU0sRUFBRSxDQUFDO1lBQ1osTUFBTSxHQUFHLEVBQUUsQ0FBQztZQUNaLElBQUksQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLEdBQUcsRUFBRSxNQUFNLENBQUMsQ0FBQztRQUNuQyxDQUFDO1FBQ0QsTUFBTSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUVuQiw0RUFBNEU7SUFDOUUsQ0FBQztJQUVRLFlBQVk7UUFDbkIsTUFBTSxhQUFhLEdBQUcsS0FBSyxDQUFDLFlBQVksRUFBRSxDQUFDO1FBRTNDLGlEQUFpRDtRQUNqRCxNQUFNLE1BQU0sR0FBRyxDQUFDLEdBQUcsYUFBYSxDQUFDLENBQUM7UUFDbEMsS0FBSyxNQUFNLENBQUMsRUFBRSxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDekMsTUFBTSxLQUFLLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQztZQUU1QixJQUFJLEtBQUssSUFBSSxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQztnQkFDbkMsbUNBQW1DO2dCQUNuQyxLQUFLLE1BQU0sRUFBRSxJQUFJLE1BQU0sRUFBRSxDQUFDO29CQUN4QixNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO2dCQUMzQyxDQUFDO1lBQ0gsQ0FBQztpQkFBTSxDQUFDO2dCQUNOLDBDQUEwQztnQkFDMUMsS0FBSyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLElBQUksQ0FBQyxJQUFJLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztvQkFDbkMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDbEQsQ0FBQztnQkFDRCxNQUFNLE9BQU8sR0FBRyxLQUFLLEdBQUcsSUFBSSxDQUFDLElBQUksR0FBRyxJQUFJLENBQUMsSUFBSSxDQUFDO2dCQUM5QyxNQUFNLENBQUMsSUFBSSxDQUFDLFFBQVEsT0FBTyxzQkFBc0IsQ0FBQyxDQUFDO2dCQUNuRCxLQUFLLElBQUksQ0FBQyxHQUFHLEtBQUssR0FBRyxJQUFJLENBQUMsSUFBSSxFQUFFLENBQUMsR0FBRyxLQUFLLEVBQUUsQ0FBQyxFQUFFLEVBQUUsQ0FBQztvQkFDL0MsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsa0JBQWtCLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztnQkFDbEQsQ0FBQztZQUNILENBQUM7UUFDSCxDQUFDO1FBRUQsT0FBTyxNQUFNLENBQUM7SUFDaEIsQ0FBQztJQUVELHVEQUF1RDtJQUN2RCxrQkFBa0I7UUFDaEIsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO1FBQ2QsS0FBSyxNQUFNLENBQUMsRUFBRSxNQUFNLENBQUMsSUFBSSxJQUFJLENBQUMsVUFBVSxFQUFFLENBQUM7WUFDekMsSUFBSSxNQUFNLENBQUMsTUFBTSxHQUFHLElBQUksQ0FBQyxJQUFJLEdBQUcsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUMxQyxLQUFLLElBQUksTUFBTSxDQUFDLE1BQU0sR0FBRyxJQUFJLENBQUMsSUFBSSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUM7WUFDakQsQ0FBQztRQUNILENBQUM7UUFDRCxPQUFPLEtBQUssQ0FBQztJQUNmLENBQUM7SUFFUSxLQUFLO1FBQ1osS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ2QsSUFBSSxDQUFDLFVBQVUsQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUMxQixDQUFDO0lBRU8sa0JBQWtCLENBQUMsS0FBb0I7UUFDN0MsSUFBSSxLQUFLLENBQUMsV0FBVyxFQUFFLENBQUM7WUFDdEIsT0FBTyxXQUFXLEtBQUssQ0FBQyxTQUFTLEtBQUssS0FBSyxDQUFDLFdBQVcsU0FBUyxDQUFDO1FBQ25FLENBQUM7UUFDRCxPQUFPLFdBQVcsS0FBSyxDQUFDLFNBQVMsWUFBWSxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUM7SUFDL0QsQ0FBQztDQUNGO0FBM0VELHNFQTJFQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogV2luZG93ZWROYXJyYXRpdmVGbG93UmVjb3JkZXIg4oCUIFNob3dzIGZpcnN0IE4gYW5kIGxhc3QgTSBsb29wIGl0ZXJhdGlvbnMsIHNraXBzIHRoZSBtaWRkbGUuXG4gKlxuICogQmVzdCBmb3I6IE1vZGVyYXRlIGxvb3BzICgxMOKAkzIwMCBpdGVyYXRpb25zKSB3aGVyZSB5b3Ugd2FudCB0byBzZWUgaG93IGl0IHN0YXJ0ZWRcbiAqIGFuZCBob3cgaXQgZW5kZWQsIHdpdGhvdXQgdGhlIG5vaXNlIGluIGJldHdlZW4uXG4gKlxuICogV2hlbiB0b3RhbCBpdGVyYXRpb25zIDw9IGhlYWQgKyB0YWlsLCBhbGwgaXRlcmF0aW9ucyBhcmUgZW1pdHRlZCAobm8gY29tcHJlc3Npb24pLlxuICogV2hlbiB0b3RhbCA+IGhlYWQgKyB0YWlsLCB0aGUgbWlkZGxlIGlzIHJlcGxhY2VkIHdpdGggYSBzdW1tYXJ5IGxpbmUuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIC8vIFNob3cgZmlyc3QgMyBhbmQgbGFzdCAyIGl0ZXJhdGlvbnNcbiAqIGV4ZWN1dG9yLmF0dGFjaEZsb3dSZWNvcmRlcihuZXcgV2luZG93ZWROYXJyYXRpdmVGbG93UmVjb3JkZXIoMywgMikpO1xuICogYGBgXG4gKi9cblxuaW1wb3J0IHsgTmFycmF0aXZlRmxvd1JlY29yZGVyIH0gZnJvbSAnLi4vTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzJztcbmltcG9ydCB0eXBlIHsgRmxvd0xvb3BFdmVudCB9IGZyb20gJy4uL3R5cGVzLmpzJztcblxuZXhwb3J0IGNsYXNzIFdpbmRvd2VkTmFycmF0aXZlRmxvd1JlY29yZGVyIGV4dGVuZHMgTmFycmF0aXZlRmxvd1JlY29yZGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBoZWFkOiBudW1iZXI7XG4gIHByaXZhdGUgcmVhZG9ubHkgdGFpbDogbnVtYmVyO1xuICBwcml2YXRlIGxvb3BFdmVudHM6IE1hcDxzdHJpbmcsIEZsb3dMb29wRXZlbnRbXT4gPSBuZXcgTWFwKCk7XG5cbiAgY29uc3RydWN0b3IoaGVhZCA9IDMsIHRhaWwgPSAyLCBpZD86IHN0cmluZykge1xuICAgIHN1cGVyKGlkID8/ICduYXJyYXRpdmUtd2luZG93ZWQnKTtcbiAgICB0aGlzLmhlYWQgPSBoZWFkO1xuICAgIHRoaXMudGFpbCA9IHRhaWw7XG4gIH1cblxuICBvdmVycmlkZSBvbkxvb3AoZXZlbnQ6IEZsb3dMb29wRXZlbnQpOiB2b2lkIHtcbiAgICAvLyBBY2N1bXVsYXRlIGFsbCBsb29wIGV2ZW50cyDigJQgd2UnbGwgcmVuZGVyIHRoZW0gaW4gZ2V0U2VudGVuY2VzXG4gICAgY29uc3Qga2V5ID0gZXZlbnQudGFyZ2V0O1xuICAgIGxldCBldmVudHMgPSB0aGlzLmxvb3BFdmVudHMuZ2V0KGtleSk7XG4gICAgaWYgKCFldmVudHMpIHtcbiAgICAgIGV2ZW50cyA9IFtdO1xuICAgICAgdGhpcy5sb29wRXZlbnRzLnNldChrZXksIGV2ZW50cyk7XG4gICAgfVxuICAgIGV2ZW50cy5wdXNoKGV2ZW50KTtcblxuICAgIC8vIERvbid0IGNhbGwgc3VwZXIg4oCUIHdlIGhhbmRsZSBhbGwgbG9vcCBzZW50ZW5jZSBnZW5lcmF0aW9uIGluIGdldFNlbnRlbmNlc1xuICB9XG5cbiAgb3ZlcnJpZGUgZ2V0U2VudGVuY2VzKCk6IHN0cmluZ1tdIHtcbiAgICBjb25zdCBiYXNlU2VudGVuY2VzID0gc3VwZXIuZ2V0U2VudGVuY2VzKCk7XG5cbiAgICAvLyBBcHBlbmQgd2luZG93ZWQgbG9vcCBzZW50ZW5jZXMgZm9yIGVhY2ggdGFyZ2V0XG4gICAgY29uc3QgcmVzdWx0ID0gWy4uLmJhc2VTZW50ZW5jZXNdO1xuICAgIGZvciAoY29uc3QgWywgZXZlbnRzXSBvZiB0aGlzLmxvb3BFdmVudHMpIHtcbiAgICAgIGNvbnN0IHRvdGFsID0gZXZlbnRzLmxlbmd0aDtcblxuICAgICAgaWYgKHRvdGFsIDw9IHRoaXMuaGVhZCArIHRoaXMudGFpbCkge1xuICAgICAgICAvLyBTbWFsbCBsb29wIOKAlCBlbWl0IGFsbCBpdGVyYXRpb25zXG4gICAgICAgIGZvciAoY29uc3QgZXYgb2YgZXZlbnRzKSB7XG4gICAgICAgICAgcmVzdWx0LnB1c2godGhpcy5mb3JtYXRMb29wU2VudGVuY2UoZXYpKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gTGFyZ2UgbG9vcCDigJQgaGVhZCArIHNraXAgc3VtbWFyeSArIHRhaWxcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCB0aGlzLmhlYWQ7IGkrKykge1xuICAgICAgICAgIHJlc3VsdC5wdXNoKHRoaXMuZm9ybWF0TG9vcFNlbnRlbmNlKGV2ZW50c1tpXSkpO1xuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHNraXBwZWQgPSB0b3RhbCAtIHRoaXMuaGVhZCAtIHRoaXMudGFpbDtcbiAgICAgICAgcmVzdWx0LnB1c2goYC4uLiAoJHtza2lwcGVkfSBpdGVyYXRpb25zIG9taXR0ZWQpYCk7XG4gICAgICAgIGZvciAobGV0IGkgPSB0b3RhbCAtIHRoaXMudGFpbDsgaSA8IHRvdGFsOyBpKyspIHtcbiAgICAgICAgICByZXN1bHQucHVzaCh0aGlzLmZvcm1hdExvb3BTZW50ZW5jZShldmVudHNbaV0pKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiByZXN1bHQ7XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgbnVtYmVyIG9mIHN1cHByZXNzZWQgbG9vcCBzZW50ZW5jZXMuICovXG4gIGdldFN1cHByZXNzZWRDb3VudCgpOiBudW1iZXIge1xuICAgIGxldCB0b3RhbCA9IDA7XG4gICAgZm9yIChjb25zdCBbLCBldmVudHNdIG9mIHRoaXMubG9vcEV2ZW50cykge1xuICAgICAgaWYgKGV2ZW50cy5sZW5ndGggPiB0aGlzLmhlYWQgKyB0aGlzLnRhaWwpIHtcbiAgICAgICAgdG90YWwgKz0gZXZlbnRzLmxlbmd0aCAtIHRoaXMuaGVhZCAtIHRoaXMudGFpbDtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHRvdGFsO1xuICB9XG5cbiAgb3ZlcnJpZGUgY2xlYXIoKTogdm9pZCB7XG4gICAgc3VwZXIuY2xlYXIoKTtcbiAgICB0aGlzLmxvb3BFdmVudHMuY2xlYXIoKTtcbiAgfVxuXG4gIHByaXZhdGUgZm9ybWF0TG9vcFNlbnRlbmNlKGV2ZW50OiBGbG93TG9vcEV2ZW50KTogc3RyaW5nIHtcbiAgICBpZiAoZXZlbnQuZGVzY3JpcHRpb24pIHtcbiAgICAgIHJldHVybiBgT24gcGFzcyAke2V2ZW50Lml0ZXJhdGlvbn06ICR7ZXZlbnQuZGVzY3JpcHRpb259IGFnYWluLmA7XG4gICAgfVxuICAgIHJldHVybiBgT24gcGFzcyAke2V2ZW50Lml0ZXJhdGlvbn0gdGhyb3VnaCAke2V2ZW50LnRhcmdldH0uYDtcbiAgfVxufVxuIl19