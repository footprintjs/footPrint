/**
 * AdaptiveNarrativeFlowRecorder — Full detail until threshold, then samples every Nth.
 *
 * Best for: Unknown loop counts where you want full detail for short loops
 * but automatic compression for long ones.
 *
 * @example
 * ```typescript
 * // Full detail for first 5, then every 10th iteration
 * executor.attachFlowRecorder(new AdaptiveNarrativeFlowRecorder(5, 10));
 * ```
 */
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
export class AdaptiveNarrativeFlowRecorder extends NarrativeFlowRecorder {
    constructor(threshold = 5, sampleRate = 10, id) {
        super(id !== null && id !== void 0 ? id : 'narrative-adaptive');
        this.totalPerTarget = new Map();
        this.suppressedCount = 0;
        this.threshold = threshold;
        this.sampleRate = sampleRate;
    }
    onLoop(event) {
        var _a;
        const count = ((_a = this.totalPerTarget.get(event.target)) !== null && _a !== void 0 ? _a : 0) + 1;
        this.totalPerTarget.set(event.target, count);
        if (event.iteration <= this.threshold) {
            // Full detail phase
            super.onLoop(event);
        }
        else if ((event.iteration - this.threshold) % this.sampleRate === 0) {
            // Sample phase — emit every Nth
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
        this.totalPerTarget.clear();
        this.suppressedCount = 0;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiQWRhcHRpdmVOYXJyYXRpdmVGbG93UmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL0FkYXB0aXZlTmFycmF0aXZlRmxvd1JlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7OztHQVdHO0FBRUgsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sNkJBQTZCLENBQUM7QUFHcEUsTUFBTSxPQUFPLDZCQUE4QixTQUFRLHFCQUFxQjtJQU10RSxZQUFZLFNBQVMsR0FBRyxDQUFDLEVBQUUsVUFBVSxHQUFHLEVBQUUsRUFBRSxFQUFXO1FBQ3JELEtBQUssQ0FBQyxFQUFFLGFBQUYsRUFBRSxjQUFGLEVBQUUsR0FBSSxvQkFBb0IsQ0FBQyxDQUFDO1FBSjVCLG1CQUFjLEdBQXdCLElBQUksR0FBRyxFQUFFLENBQUM7UUFDaEQsb0JBQWUsR0FBRyxDQUFDLENBQUM7UUFJMUIsSUFBSSxDQUFDLFNBQVMsR0FBRyxTQUFTLENBQUM7UUFDM0IsSUFBSSxDQUFDLFVBQVUsR0FBRyxVQUFVLENBQUM7SUFDL0IsQ0FBQztJQUVRLE1BQU0sQ0FBQyxLQUFvQjs7UUFDbEMsTUFBTSxLQUFLLEdBQUcsQ0FBQyxNQUFBLElBQUksQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsbUNBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO1FBQy9ELElBQUksQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxNQUFNLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFN0MsSUFBSSxLQUFLLENBQUMsU0FBUyxJQUFJLElBQUksQ0FBQyxTQUFTLEVBQUUsQ0FBQztZQUN0QyxvQkFBb0I7WUFDcEIsS0FBSyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUN0QixDQUFDO2FBQU0sSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLFNBQVMsQ0FBQyxHQUFHLElBQUksQ0FBQyxVQUFVLEtBQUssQ0FBQyxFQUFFLENBQUM7WUFDdEUsZ0NBQWdDO1lBQ2hDLEtBQUssQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDdEIsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLENBQUMsZUFBZSxFQUFFLENBQUM7UUFDekIsQ0FBQztJQUNILENBQUM7SUFFRCx1REFBdUQ7SUFDdkQsa0JBQWtCO1FBQ2hCLE9BQU8sSUFBSSxDQUFDLGVBQWUsQ0FBQztJQUM5QixDQUFDO0lBRVEsS0FBSztRQUNaLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUNkLElBQUksQ0FBQyxjQUFjLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDNUIsSUFBSSxDQUFDLGVBQWUsR0FBRyxDQUFDLENBQUM7SUFDM0IsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBBZGFwdGl2ZU5hcnJhdGl2ZUZsb3dSZWNvcmRlciDigJQgRnVsbCBkZXRhaWwgdW50aWwgdGhyZXNob2xkLCB0aGVuIHNhbXBsZXMgZXZlcnkgTnRoLlxuICpcbiAqIEJlc3QgZm9yOiBVbmtub3duIGxvb3AgY291bnRzIHdoZXJlIHlvdSB3YW50IGZ1bGwgZGV0YWlsIGZvciBzaG9ydCBsb29wc1xuICogYnV0IGF1dG9tYXRpYyBjb21wcmVzc2lvbiBmb3IgbG9uZyBvbmVzLlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiAvLyBGdWxsIGRldGFpbCBmb3IgZmlyc3QgNSwgdGhlbiBldmVyeSAxMHRoIGl0ZXJhdGlvblxuICogZXhlY3V0b3IuYXR0YWNoRmxvd1JlY29yZGVyKG5ldyBBZGFwdGl2ZU5hcnJhdGl2ZUZsb3dSZWNvcmRlcig1LCAxMCkpO1xuICogYGBgXG4gKi9cblxuaW1wb3J0IHsgTmFycmF0aXZlRmxvd1JlY29yZGVyIH0gZnJvbSAnLi4vTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzJztcbmltcG9ydCB0eXBlIHsgRmxvd0xvb3BFdmVudCB9IGZyb20gJy4uL3R5cGVzLmpzJztcblxuZXhwb3J0IGNsYXNzIEFkYXB0aXZlTmFycmF0aXZlRmxvd1JlY29yZGVyIGV4dGVuZHMgTmFycmF0aXZlRmxvd1JlY29yZGVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSB0aHJlc2hvbGQ6IG51bWJlcjtcbiAgcHJpdmF0ZSByZWFkb25seSBzYW1wbGVSYXRlOiBudW1iZXI7XG4gIHByaXZhdGUgdG90YWxQZXJUYXJnZXQ6IE1hcDxzdHJpbmcsIG51bWJlcj4gPSBuZXcgTWFwKCk7XG4gIHByaXZhdGUgc3VwcHJlc3NlZENvdW50ID0gMDtcblxuICBjb25zdHJ1Y3Rvcih0aHJlc2hvbGQgPSA1LCBzYW1wbGVSYXRlID0gMTAsIGlkPzogc3RyaW5nKSB7XG4gICAgc3VwZXIoaWQgPz8gJ25hcnJhdGl2ZS1hZGFwdGl2ZScpO1xuICAgIHRoaXMudGhyZXNob2xkID0gdGhyZXNob2xkO1xuICAgIHRoaXMuc2FtcGxlUmF0ZSA9IHNhbXBsZVJhdGU7XG4gIH1cblxuICBvdmVycmlkZSBvbkxvb3AoZXZlbnQ6IEZsb3dMb29wRXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBjb3VudCA9ICh0aGlzLnRvdGFsUGVyVGFyZ2V0LmdldChldmVudC50YXJnZXQpID8/IDApICsgMTtcbiAgICB0aGlzLnRvdGFsUGVyVGFyZ2V0LnNldChldmVudC50YXJnZXQsIGNvdW50KTtcblxuICAgIGlmIChldmVudC5pdGVyYXRpb24gPD0gdGhpcy50aHJlc2hvbGQpIHtcbiAgICAgIC8vIEZ1bGwgZGV0YWlsIHBoYXNlXG4gICAgICBzdXBlci5vbkxvb3AoZXZlbnQpO1xuICAgIH0gZWxzZSBpZiAoKGV2ZW50Lml0ZXJhdGlvbiAtIHRoaXMudGhyZXNob2xkKSAlIHRoaXMuc2FtcGxlUmF0ZSA9PT0gMCkge1xuICAgICAgLy8gU2FtcGxlIHBoYXNlIOKAlCBlbWl0IGV2ZXJ5IE50aFxuICAgICAgc3VwZXIub25Mb29wKGV2ZW50KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zdXBwcmVzc2VkQ291bnQrKztcbiAgICB9XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgbnVtYmVyIG9mIHN1cHByZXNzZWQgbG9vcCBzZW50ZW5jZXMuICovXG4gIGdldFN1cHByZXNzZWRDb3VudCgpOiBudW1iZXIge1xuICAgIHJldHVybiB0aGlzLnN1cHByZXNzZWRDb3VudDtcbiAgfVxuXG4gIG92ZXJyaWRlIGNsZWFyKCk6IHZvaWQge1xuICAgIHN1cGVyLmNsZWFyKCk7XG4gICAgdGhpcy50b3RhbFBlclRhcmdldC5jbGVhcigpO1xuICAgIHRoaXMuc3VwcHJlc3NlZENvdW50ID0gMDtcbiAgfVxufVxuIl19