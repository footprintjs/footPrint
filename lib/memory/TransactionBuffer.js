"use strict";
/**
 * TransactionBuffer — Transactional write buffer for stage mutations
 *
 * Collects writes during execution and commits them atomically.
 * Like a database transaction buffer:
 * - Changes staged here before being committed to SharedMemory
 * - Enables read-after-write consistency within a stage
 * - Records operation trace for deterministic replay
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionBuffer = void 0;
const pathOps_js_1 = require("./pathOps.js");
const utils_js_1 = require("./utils.js");
class TransactionBuffer {
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
        (0, pathOps_js_1.nativeSet)(this.workingCopy, path, value);
        (0, pathOps_js_1.nativeSet)(this.overwritePatch, path, structuredClone(value));
        if (shouldRedact) {
            this.redactedPaths.add((0, utils_js_1.normalisePath)(path));
        }
        this.opTrace.push({ path: (0, utils_js_1.normalisePath)(path), verb: 'set' });
    }
    /** Deep union merge at the specified path. */
    merge(path, value, shouldRedact = false) {
        var _a, _b;
        const existing = (_a = (0, pathOps_js_1.nativeGet)(this.workingCopy, path)) !== null && _a !== void 0 ? _a : {};
        const merged = (0, utils_js_1.deepSmartMerge)(existing, value);
        (0, pathOps_js_1.nativeSet)(this.workingCopy, path, merged);
        (0, pathOps_js_1.nativeSet)(this.updatePatch, path, (0, utils_js_1.deepSmartMerge)((_b = (0, pathOps_js_1.nativeGet)(this.updatePatch, path)) !== null && _b !== void 0 ? _b : {}, value));
        if (shouldRedact) {
            this.redactedPaths.add((0, utils_js_1.normalisePath)(path));
        }
        this.opTrace.push({ path: (0, utils_js_1.normalisePath)(path), verb: 'merge' });
    }
    /** Read current value at path (includes uncommitted changes). */
    get(path, defaultValue) {
        return (0, pathOps_js_1.nativeGet)(this.workingCopy, path, defaultValue);
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
exports.TransactionBuffer = TransactionBuffer;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiVHJhbnNhY3Rpb25CdWZmZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL21lbW9yeS9UcmFuc2FjdGlvbkJ1ZmZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7O0dBUUc7OztBQUVILDZDQUFvRTtBQUVwRSx5Q0FBMkQ7QUFFM0QsTUFBYSxpQkFBaUI7SUFTNUIsWUFBWSxJQUFTO1FBTGIsbUJBQWMsR0FBZ0IsRUFBRSxDQUFDO1FBQ2pDLGdCQUFXLEdBQWdCLEVBQUUsQ0FBQztRQUM5QixZQUFPLEdBQThDLEVBQUUsQ0FBQztRQUN4RCxrQkFBYSxHQUFHLElBQUksR0FBRyxFQUFVLENBQUM7UUFHeEMsSUFBSSxDQUFDLFlBQVksR0FBRyxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUM7UUFDMUMsSUFBSSxDQUFDLFdBQVcsR0FBRyxlQUFlLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDM0MsQ0FBQztJQUVELDRDQUE0QztJQUM1QyxHQUFHLENBQUMsSUFBeUIsRUFBRSxLQUFVLEVBQUUsWUFBWSxHQUFHLEtBQUs7UUFDN0QsSUFBQSxzQkFBSSxFQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsSUFBSSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3BDLElBQUEsc0JBQUksRUFBQyxJQUFJLENBQUMsY0FBYyxFQUFFLElBQUksRUFBRSxlQUFlLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztRQUN4RCxJQUFJLFlBQVksRUFBRSxDQUFDO1lBQ2pCLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLElBQUEsd0JBQWEsRUFBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO1FBQzlDLENBQUM7UUFDRCxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxFQUFFLElBQUksRUFBRSxJQUFBLHdCQUFhLEVBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLEtBQUssRUFBRSxDQUFDLENBQUM7SUFDaEUsQ0FBQztJQUVELDhDQUE4QztJQUM5QyxLQUFLLENBQUMsSUFBeUIsRUFBRSxLQUFVLEVBQUUsWUFBWSxHQUFHLEtBQUs7O1FBQy9ELE1BQU0sUUFBUSxHQUFHLE1BQUEsSUFBQSxzQkFBSSxFQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLG1DQUFJLEVBQUUsQ0FBQztRQUNwRCxNQUFNLE1BQU0sR0FBRyxJQUFBLHlCQUFjLEVBQUMsUUFBUSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQy9DLElBQUEsc0JBQUksRUFBQyxJQUFJLENBQUMsV0FBVyxFQUFFLElBQUksRUFBRSxNQUFNLENBQUMsQ0FBQztRQUNyQyxJQUFBLHNCQUFJLEVBQUMsSUFBSSxDQUFDLFdBQVcsRUFBRSxJQUFJLEVBQUUsSUFBQSx5QkFBYyxFQUFDLE1BQUEsSUFBQSxzQkFBSSxFQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsSUFBSSxDQUFDLG1DQUFJLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQyxDQUFDO1FBQ3hGLElBQUksWUFBWSxFQUFFLENBQUM7WUFDakIsSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsSUFBQSx3QkFBYSxFQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7UUFDOUMsQ0FBQztRQUNELElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEVBQUUsSUFBSSxFQUFFLElBQUEsd0JBQWEsRUFBQyxJQUFJLENBQUMsRUFBRSxJQUFJLEVBQUUsT0FBTyxFQUFFLENBQUMsQ0FBQztJQUNsRSxDQUFDO0lBRUQsaUVBQWlFO0lBQ2pFLEdBQUcsQ0FBQyxJQUF5QixFQUFFLFlBQWtCO1FBQy9DLE9BQU8sSUFBQSxzQkFBSSxFQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsSUFBSSxFQUFFLFlBQVksQ0FBQyxDQUFDO0lBQ3BELENBQUM7SUFFRDs7O09BR0c7SUFDSCxNQUFNO1FBTUosTUFBTSxPQUFPLEdBQUc7WUFDZCxTQUFTLEVBQUUsZUFBZSxDQUFDLElBQUksQ0FBQyxjQUFjLENBQUM7WUFDL0MsT0FBTyxFQUFFLGVBQWUsQ0FBQyxJQUFJLENBQUMsV0FBVyxDQUFDO1lBQzFDLGFBQWEsRUFBRSxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDO1lBQzFDLEtBQUssRUFBRSxDQUFDLEdBQUcsSUFBSSxDQUFDLE9BQU8sQ0FBQztTQUN6QixDQUFDO1FBRUYsSUFBSSxDQUFDLGNBQWMsR0FBRyxFQUFFLENBQUM7UUFDekIsSUFBSSxDQUFDLFdBQVcsR0FBRyxFQUFFLENBQUM7UUFDdEIsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDO1FBQ3hCLElBQUksQ0FBQyxhQUFhLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDM0IsSUFBSSxDQUFDLFdBQVcsR0FBRyxFQUFFLENBQUM7UUFFdEIsT0FBTyxPQUFPLENBQUM7SUFDakIsQ0FBQztDQUNGO0FBbEVELDhDQWtFQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVHJhbnNhY3Rpb25CdWZmZXIg4oCUIFRyYW5zYWN0aW9uYWwgd3JpdGUgYnVmZmVyIGZvciBzdGFnZSBtdXRhdGlvbnNcbiAqXG4gKiBDb2xsZWN0cyB3cml0ZXMgZHVyaW5nIGV4ZWN1dGlvbiBhbmQgY29tbWl0cyB0aGVtIGF0b21pY2FsbHkuXG4gKiBMaWtlIGEgZGF0YWJhc2UgdHJhbnNhY3Rpb24gYnVmZmVyOlxuICogLSBDaGFuZ2VzIHN0YWdlZCBoZXJlIGJlZm9yZSBiZWluZyBjb21taXR0ZWQgdG8gU2hhcmVkTWVtb3J5XG4gKiAtIEVuYWJsZXMgcmVhZC1hZnRlci13cml0ZSBjb25zaXN0ZW5jeSB3aXRoaW4gYSBzdGFnZVxuICogLSBSZWNvcmRzIG9wZXJhdGlvbiB0cmFjZSBmb3IgZGV0ZXJtaW5pc3RpYyByZXBsYXlcbiAqL1xuXG5pbXBvcnQgeyBuYXRpdmVHZXQgYXMgX2dldCwgbmF0aXZlU2V0IGFzIF9zZXQgfSBmcm9tICcuL3BhdGhPcHMuanMnO1xuaW1wb3J0IHR5cGUgeyBNZW1vcnlQYXRjaCB9IGZyb20gJy4vdHlwZXMuanMnO1xuaW1wb3J0IHsgZGVlcFNtYXJ0TWVyZ2UsIG5vcm1hbGlzZVBhdGggfSBmcm9tICcuL3V0aWxzLmpzJztcblxuZXhwb3J0IGNsYXNzIFRyYW5zYWN0aW9uQnVmZmVyIHtcbiAgcHJpdmF0ZSByZWFkb25seSBiYXNlU25hcHNob3Q6IGFueTtcbiAgcHJpdmF0ZSB3b3JraW5nQ29weTogYW55O1xuXG4gIHByaXZhdGUgb3ZlcndyaXRlUGF0Y2g6IE1lbW9yeVBhdGNoID0ge307XG4gIHByaXZhdGUgdXBkYXRlUGF0Y2g6IE1lbW9yeVBhdGNoID0ge307XG4gIHByaXZhdGUgb3BUcmFjZTogeyBwYXRoOiBzdHJpbmc7IHZlcmI6ICdzZXQnIHwgJ21lcmdlJyB9W10gPSBbXTtcbiAgcHJpdmF0ZSByZWRhY3RlZFBhdGhzID0gbmV3IFNldDxzdHJpbmc+KCk7XG5cbiAgY29uc3RydWN0b3IoYmFzZTogYW55KSB7XG4gICAgdGhpcy5iYXNlU25hcHNob3QgPSBzdHJ1Y3R1cmVkQ2xvbmUoYmFzZSk7XG4gICAgdGhpcy53b3JraW5nQ29weSA9IHN0cnVjdHVyZWRDbG9uZShiYXNlKTtcbiAgfVxuXG4gIC8qKiBIYXJkIG92ZXJ3cml0ZSBhdCB0aGUgc3BlY2lmaWVkIHBhdGguICovXG4gIHNldChwYXRoOiAoc3RyaW5nIHwgbnVtYmVyKVtdLCB2YWx1ZTogYW55LCBzaG91bGRSZWRhY3QgPSBmYWxzZSk6IHZvaWQge1xuICAgIF9zZXQodGhpcy53b3JraW5nQ29weSwgcGF0aCwgdmFsdWUpO1xuICAgIF9zZXQodGhpcy5vdmVyd3JpdGVQYXRjaCwgcGF0aCwgc3RydWN0dXJlZENsb25lKHZhbHVlKSk7XG4gICAgaWYgKHNob3VsZFJlZGFjdCkge1xuICAgICAgdGhpcy5yZWRhY3RlZFBhdGhzLmFkZChub3JtYWxpc2VQYXRoKHBhdGgpKTtcbiAgICB9XG4gICAgdGhpcy5vcFRyYWNlLnB1c2goeyBwYXRoOiBub3JtYWxpc2VQYXRoKHBhdGgpLCB2ZXJiOiAnc2V0JyB9KTtcbiAgfVxuXG4gIC8qKiBEZWVwIHVuaW9uIG1lcmdlIGF0IHRoZSBzcGVjaWZpZWQgcGF0aC4gKi9cbiAgbWVyZ2UocGF0aDogKHN0cmluZyB8IG51bWJlcilbXSwgdmFsdWU6IGFueSwgc2hvdWxkUmVkYWN0ID0gZmFsc2UpOiB2b2lkIHtcbiAgICBjb25zdCBleGlzdGluZyA9IF9nZXQodGhpcy53b3JraW5nQ29weSwgcGF0aCkgPz8ge307XG4gICAgY29uc3QgbWVyZ2VkID0gZGVlcFNtYXJ0TWVyZ2UoZXhpc3RpbmcsIHZhbHVlKTtcbiAgICBfc2V0KHRoaXMud29ya2luZ0NvcHksIHBhdGgsIG1lcmdlZCk7XG4gICAgX3NldCh0aGlzLnVwZGF0ZVBhdGNoLCBwYXRoLCBkZWVwU21hcnRNZXJnZShfZ2V0KHRoaXMudXBkYXRlUGF0Y2gsIHBhdGgpID8/IHt9LCB2YWx1ZSkpO1xuICAgIGlmIChzaG91bGRSZWRhY3QpIHtcbiAgICAgIHRoaXMucmVkYWN0ZWRQYXRocy5hZGQobm9ybWFsaXNlUGF0aChwYXRoKSk7XG4gICAgfVxuICAgIHRoaXMub3BUcmFjZS5wdXNoKHsgcGF0aDogbm9ybWFsaXNlUGF0aChwYXRoKSwgdmVyYjogJ21lcmdlJyB9KTtcbiAgfVxuXG4gIC8qKiBSZWFkIGN1cnJlbnQgdmFsdWUgYXQgcGF0aCAoaW5jbHVkZXMgdW5jb21taXR0ZWQgY2hhbmdlcykuICovXG4gIGdldChwYXRoOiAoc3RyaW5nIHwgbnVtYmVyKVtdLCBkZWZhdWx0VmFsdWU/OiBhbnkpIHtcbiAgICByZXR1cm4gX2dldCh0aGlzLndvcmtpbmdDb3B5LCBwYXRoLCBkZWZhdWx0VmFsdWUpO1xuICB9XG5cbiAgLyoqXG4gICAqIEZsdXNoIGFsbCBzdGFnZWQgbXV0YXRpb25zIGFuZCByZXR1cm4gdGhlIGNvbW1pdCBidW5kbGUuXG4gICAqIFJlc2V0cyB0aGUgYnVmZmVyIHRvIGVtcHR5IHN0YXRlIGFmdGVyIGNvbW1pdC5cbiAgICovXG4gIGNvbW1pdCgpOiB7XG4gICAgb3ZlcndyaXRlOiBNZW1vcnlQYXRjaDtcbiAgICB1cGRhdGVzOiBNZW1vcnlQYXRjaDtcbiAgICByZWRhY3RlZFBhdGhzOiBTZXQ8c3RyaW5nPjtcbiAgICB0cmFjZTogeyBwYXRoOiBzdHJpbmc7IHZlcmI6ICdzZXQnIHwgJ21lcmdlJyB9W107XG4gIH0ge1xuICAgIGNvbnN0IHBheWxvYWQgPSB7XG4gICAgICBvdmVyd3JpdGU6IHN0cnVjdHVyZWRDbG9uZSh0aGlzLm92ZXJ3cml0ZVBhdGNoKSxcbiAgICAgIHVwZGF0ZXM6IHN0cnVjdHVyZWRDbG9uZSh0aGlzLnVwZGF0ZVBhdGNoKSxcbiAgICAgIHJlZGFjdGVkUGF0aHM6IG5ldyBTZXQodGhpcy5yZWRhY3RlZFBhdGhzKSxcbiAgICAgIHRyYWNlOiBbLi4udGhpcy5vcFRyYWNlXSxcbiAgICB9O1xuXG4gICAgdGhpcy5vdmVyd3JpdGVQYXRjaCA9IHt9O1xuICAgIHRoaXMudXBkYXRlUGF0Y2ggPSB7fTtcbiAgICB0aGlzLm9wVHJhY2UubGVuZ3RoID0gMDtcbiAgICB0aGlzLnJlZGFjdGVkUGF0aHMuY2xlYXIoKTtcbiAgICB0aGlzLndvcmtpbmdDb3B5ID0ge307XG5cbiAgICByZXR1cm4gcGF5bG9hZDtcbiAgfVxufVxuIl19