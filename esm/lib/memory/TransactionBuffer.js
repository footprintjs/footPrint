/**
 * TransactionBuffer — Transactional write buffer for stage mutations
 *
 * Collects writes during execution and commits them atomically.
 * Like a database transaction buffer:
 * - Changes staged here before being committed to SharedMemory
 * - Enables read-after-write consistency within a stage
 * - Records operation trace for deterministic replay
 */
import { nativeGet as _get, nativeSet as _set } from './pathOps.js';
import { deepSmartMerge, normalisePath } from './utils.js';
export class TransactionBuffer {
    constructor(base) {
        this.overwritePatch = {};
        this.updatePatch = {};
        this.opTrace = [];
        this.redactedPaths = new Set();
        this.baseSnapshot = structuredClone(base);
        this.workingCopy = structuredClone(base);
    }
    /** Hard overwrite at the specified path. */
    set(path, value, shouldRedact = false) {
        _set(this.workingCopy, path, value);
        _set(this.overwritePatch, path, structuredClone(value));
        if (shouldRedact) {
            this.redactedPaths.add(normalisePath(path));
        }
        this.opTrace.push({ path: normalisePath(path), verb: 'set' });
    }
    /** Deep union merge at the specified path. */
    merge(path, value, shouldRedact = false) {
        var _a, _b;
        const existing = (_a = _get(this.workingCopy, path)) !== null && _a !== void 0 ? _a : {};
        const merged = deepSmartMerge(existing, value);
        _set(this.workingCopy, path, merged);
        _set(this.updatePatch, path, deepSmartMerge((_b = _get(this.updatePatch, path)) !== null && _b !== void 0 ? _b : {}, value));
        if (shouldRedact) {
            this.redactedPaths.add(normalisePath(path));
        }
        this.opTrace.push({ path: normalisePath(path), verb: 'merge' });
    }
    /** Read current value at path (includes uncommitted changes). */
    get(path, defaultValue) {
        return _get(this.workingCopy, path, defaultValue);
    }
    /**
     * Flush all staged mutations and return the commit bundle.
     * Resets the buffer to empty state after commit.
     */
    commit() {
        const payload = {
            overwrite: structuredClone(this.overwritePatch),
            updates: structuredClone(this.updatePatch),
            redactedPaths: new Set(this.redactedPaths),
            trace: [...this.opTrace],
        };
        this.overwritePatch = {};
        this.updatePatch = {};
        this.opTrace.length = 0;
        this.redactedPaths.clear();
        this.workingCopy = {};
        return payload;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiVHJhbnNhY3Rpb25CdWZmZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL21lbW9yeS9UcmFuc2FjdGlvbkJ1ZmZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7R0FRRztBQUVILE9BQU8sRUFBRSxTQUFTLElBQUksSUFBSSxFQUFFLFNBQVMsSUFBSSxJQUFJLEVBQUUsTUFBTSxjQUFjLENBQUM7QUFFcEUsT0FBTyxFQUFFLGNBQWMsRUFBRSxhQUFhLEVBQUUsTUFBTSxZQUFZLENBQUM7QUFFM0QsTUFBTSxPQUFPLGlCQUFpQjtJQVM1QixZQUFZLElBQVM7UUFMYixtQkFBYyxHQUFnQixFQUFFLENBQUM7UUFDakMsZ0JBQVcsR0FBZ0IsRUFBRSxDQUFDO1FBQzlCLFlBQU8sR0FBOEMsRUFBRSxDQUFDO1FBQ3hELGtCQUFhLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztRQUd4QyxJQUFJLENBQUMsWUFBWSxHQUFHLGVBQWUsQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUMxQyxJQUFJLENBQUMsV0FBVyxHQUFHLGVBQWUsQ0FBQyxJQUFJLENBQUMsQ0FBQztJQUMzQyxDQUFDO0lBRUQsNENBQTRDO0lBQzVDLEdBQUcsQ0FBQyxJQUF5QixFQUFFLEtBQVUsRUFBRSxZQUFZLEdBQUcsS0FBSztRQUM3RCxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxJQUFJLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDcEMsSUFBSSxDQUFDLElBQUksQ0FBQyxjQUFjLEVBQUUsSUFBSSxFQUFFLGVBQWUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO1FBQ3hELElBQUksWUFBWSxFQUFFLENBQUM7WUFDakIsSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsYUFBYSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7UUFDOUMsQ0FBQztRQUNELElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLGFBQWEsQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLENBQUMsQ0FBQztJQUNoRSxDQUFDO0lBRUQsOENBQThDO0lBQzlDLEtBQUssQ0FBQyxJQUF5QixFQUFFLEtBQVUsRUFBRSxZQUFZLEdBQUcsS0FBSzs7UUFDL0QsTUFBTSxRQUFRLEdBQUcsTUFBQSxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxJQUFJLENBQUMsbUNBQUksRUFBRSxDQUFDO1FBQ3BELE1BQU0sTUFBTSxHQUFHLGNBQWMsQ0FBQyxRQUFRLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDL0MsSUFBSSxDQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsSUFBSSxFQUFFLE1BQU0sQ0FBQyxDQUFDO1FBQ3JDLElBQUksQ0FBQyxJQUFJLENBQUMsV0FBVyxFQUFFLElBQUksRUFBRSxjQUFjLENBQUMsTUFBQSxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxJQUFJLENBQUMsbUNBQUksRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDLENBQUM7UUFDeEYsSUFBSSxZQUFZLEVBQUUsQ0FBQztZQUNqQixJQUFJLENBQUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztRQUM5QyxDQUFDO1FBQ0QsSUFBSSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsYUFBYSxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksRUFBRSxPQUFPLEVBQUUsQ0FBQyxDQUFDO0lBQ2xFLENBQUM7SUFFRCxpRUFBaUU7SUFDakUsR0FBRyxDQUFDLElBQXlCLEVBQUUsWUFBa0I7UUFDL0MsT0FBTyxJQUFJLENBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxJQUFJLEVBQUUsWUFBWSxDQUFDLENBQUM7SUFDcEQsQ0FBQztJQUVEOzs7T0FHRztJQUNILE1BQU07UUFNSixNQUFNLE9BQU8sR0FBRztZQUNkLFNBQVMsRUFBRSxlQUFlLENBQUMsSUFBSSxDQUFDLGNBQWMsQ0FBQztZQUMvQyxPQUFPLEVBQUUsZUFBZSxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUM7WUFDMUMsYUFBYSxFQUFFLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUM7WUFDMUMsS0FBSyxFQUFFLENBQUMsR0FBRyxJQUFJLENBQUMsT0FBTyxDQUFDO1NBQ3pCLENBQUM7UUFFRixJQUFJLENBQUMsY0FBYyxHQUFHLEVBQUUsQ0FBQztRQUN6QixJQUFJLENBQUMsV0FBVyxHQUFHLEVBQUUsQ0FBQztRQUN0QixJQUFJLENBQUMsT0FBTyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUM7UUFDeEIsSUFBSSxDQUFDLGFBQWEsQ0FBQyxLQUFLLEVBQUUsQ0FBQztRQUMzQixJQUFJLENBQUMsV0FBVyxHQUFHLEVBQUUsQ0FBQztRQUV0QixPQUFPLE9BQU8sQ0FBQztJQUNqQixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRyYW5zYWN0aW9uQnVmZmVyIOKAlCBUcmFuc2FjdGlvbmFsIHdyaXRlIGJ1ZmZlciBmb3Igc3RhZ2UgbXV0YXRpb25zXG4gKlxuICogQ29sbGVjdHMgd3JpdGVzIGR1cmluZyBleGVjdXRpb24gYW5kIGNvbW1pdHMgdGhlbSBhdG9taWNhbGx5LlxuICogTGlrZSBhIGRhdGFiYXNlIHRyYW5zYWN0aW9uIGJ1ZmZlcjpcbiAqIC0gQ2hhbmdlcyBzdGFnZWQgaGVyZSBiZWZvcmUgYmVpbmcgY29tbWl0dGVkIHRvIFNoYXJlZE1lbW9yeVxuICogLSBFbmFibGVzIHJlYWQtYWZ0ZXItd3JpdGUgY29uc2lzdGVuY3kgd2l0aGluIGEgc3RhZ2VcbiAqIC0gUmVjb3JkcyBvcGVyYXRpb24gdHJhY2UgZm9yIGRldGVybWluaXN0aWMgcmVwbGF5XG4gKi9cblxuaW1wb3J0IHsgbmF0aXZlR2V0IGFzIF9nZXQsIG5hdGl2ZVNldCBhcyBfc2V0IH0gZnJvbSAnLi9wYXRoT3BzLmpzJztcbmltcG9ydCB0eXBlIHsgTWVtb3J5UGF0Y2ggfSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB7IGRlZXBTbWFydE1lcmdlLCBub3JtYWxpc2VQYXRoIH0gZnJvbSAnLi91dGlscy5qcyc7XG5cbmV4cG9ydCBjbGFzcyBUcmFuc2FjdGlvbkJ1ZmZlciB7XG4gIHByaXZhdGUgcmVhZG9ubHkgYmFzZVNuYXBzaG90OiBhbnk7XG4gIHByaXZhdGUgd29ya2luZ0NvcHk6IGFueTtcblxuICBwcml2YXRlIG92ZXJ3cml0ZVBhdGNoOiBNZW1vcnlQYXRjaCA9IHt9O1xuICBwcml2YXRlIHVwZGF0ZVBhdGNoOiBNZW1vcnlQYXRjaCA9IHt9O1xuICBwcml2YXRlIG9wVHJhY2U6IHsgcGF0aDogc3RyaW5nOyB2ZXJiOiAnc2V0JyB8ICdtZXJnZScgfVtdID0gW107XG4gIHByaXZhdGUgcmVkYWN0ZWRQYXRocyA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuXG4gIGNvbnN0cnVjdG9yKGJhc2U6IGFueSkge1xuICAgIHRoaXMuYmFzZVNuYXBzaG90ID0gc3RydWN0dXJlZENsb25lKGJhc2UpO1xuICAgIHRoaXMud29ya2luZ0NvcHkgPSBzdHJ1Y3R1cmVkQ2xvbmUoYmFzZSk7XG4gIH1cblxuICAvKiogSGFyZCBvdmVyd3JpdGUgYXQgdGhlIHNwZWNpZmllZCBwYXRoLiAqL1xuICBzZXQocGF0aDogKHN0cmluZyB8IG51bWJlcilbXSwgdmFsdWU6IGFueSwgc2hvdWxkUmVkYWN0ID0gZmFsc2UpOiB2b2lkIHtcbiAgICBfc2V0KHRoaXMud29ya2luZ0NvcHksIHBhdGgsIHZhbHVlKTtcbiAgICBfc2V0KHRoaXMub3ZlcndyaXRlUGF0Y2gsIHBhdGgsIHN0cnVjdHVyZWRDbG9uZSh2YWx1ZSkpO1xuICAgIGlmIChzaG91bGRSZWRhY3QpIHtcbiAgICAgIHRoaXMucmVkYWN0ZWRQYXRocy5hZGQobm9ybWFsaXNlUGF0aChwYXRoKSk7XG4gICAgfVxuICAgIHRoaXMub3BUcmFjZS5wdXNoKHsgcGF0aDogbm9ybWFsaXNlUGF0aChwYXRoKSwgdmVyYjogJ3NldCcgfSk7XG4gIH1cblxuICAvKiogRGVlcCB1bmlvbiBtZXJnZSBhdCB0aGUgc3BlY2lmaWVkIHBhdGguICovXG4gIG1lcmdlKHBhdGg6IChzdHJpbmcgfCBudW1iZXIpW10sIHZhbHVlOiBhbnksIHNob3VsZFJlZGFjdCA9IGZhbHNlKTogdm9pZCB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBfZ2V0KHRoaXMud29ya2luZ0NvcHksIHBhdGgpID8/IHt9O1xuICAgIGNvbnN0IG1lcmdlZCA9IGRlZXBTbWFydE1lcmdlKGV4aXN0aW5nLCB2YWx1ZSk7XG4gICAgX3NldCh0aGlzLndvcmtpbmdDb3B5LCBwYXRoLCBtZXJnZWQpO1xuICAgIF9zZXQodGhpcy51cGRhdGVQYXRjaCwgcGF0aCwgZGVlcFNtYXJ0TWVyZ2UoX2dldCh0aGlzLnVwZGF0ZVBhdGNoLCBwYXRoKSA/PyB7fSwgdmFsdWUpKTtcbiAgICBpZiAoc2hvdWxkUmVkYWN0KSB7XG4gICAgICB0aGlzLnJlZGFjdGVkUGF0aHMuYWRkKG5vcm1hbGlzZVBhdGgocGF0aCkpO1xuICAgIH1cbiAgICB0aGlzLm9wVHJhY2UucHVzaCh7IHBhdGg6IG5vcm1hbGlzZVBhdGgocGF0aCksIHZlcmI6ICdtZXJnZScgfSk7XG4gIH1cblxuICAvKiogUmVhZCBjdXJyZW50IHZhbHVlIGF0IHBhdGggKGluY2x1ZGVzIHVuY29tbWl0dGVkIGNoYW5nZXMpLiAqL1xuICBnZXQocGF0aDogKHN0cmluZyB8IG51bWJlcilbXSwgZGVmYXVsdFZhbHVlPzogYW55KSB7XG4gICAgcmV0dXJuIF9nZXQodGhpcy53b3JraW5nQ29weSwgcGF0aCwgZGVmYXVsdFZhbHVlKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGbHVzaCBhbGwgc3RhZ2VkIG11dGF0aW9ucyBhbmQgcmV0dXJuIHRoZSBjb21taXQgYnVuZGxlLlxuICAgKiBSZXNldHMgdGhlIGJ1ZmZlciB0byBlbXB0eSBzdGF0ZSBhZnRlciBjb21taXQuXG4gICAqL1xuICBjb21taXQoKToge1xuICAgIG92ZXJ3cml0ZTogTWVtb3J5UGF0Y2g7XG4gICAgdXBkYXRlczogTWVtb3J5UGF0Y2g7XG4gICAgcmVkYWN0ZWRQYXRoczogU2V0PHN0cmluZz47XG4gICAgdHJhY2U6IHsgcGF0aDogc3RyaW5nOyB2ZXJiOiAnc2V0JyB8ICdtZXJnZScgfVtdO1xuICB9IHtcbiAgICBjb25zdCBwYXlsb2FkID0ge1xuICAgICAgb3ZlcndyaXRlOiBzdHJ1Y3R1cmVkQ2xvbmUodGhpcy5vdmVyd3JpdGVQYXRjaCksXG4gICAgICB1cGRhdGVzOiBzdHJ1Y3R1cmVkQ2xvbmUodGhpcy51cGRhdGVQYXRjaCksXG4gICAgICByZWRhY3RlZFBhdGhzOiBuZXcgU2V0KHRoaXMucmVkYWN0ZWRQYXRocyksXG4gICAgICB0cmFjZTogWy4uLnRoaXMub3BUcmFjZV0sXG4gICAgfTtcblxuICAgIHRoaXMub3ZlcndyaXRlUGF0Y2ggPSB7fTtcbiAgICB0aGlzLnVwZGF0ZVBhdGNoID0ge307XG4gICAgdGhpcy5vcFRyYWNlLmxlbmd0aCA9IDA7XG4gICAgdGhpcy5yZWRhY3RlZFBhdGhzLmNsZWFyKCk7XG4gICAgdGhpcy53b3JraW5nQ29weSA9IHt9O1xuXG4gICAgcmV0dXJuIHBheWxvYWQ7XG4gIH1cbn1cbiJdfQ==