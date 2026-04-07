"use strict";
/**
 * DiagnosticCollector — Per-stage metadata collector
 *
 * Collects non-execution metadata during a stage's run:
 * - logs, errors, metrics, evals, flowMessages
 *
 * Like a compiler's diagnostic collector — gathers warnings, errors,
 * and timing info without affecting the compilation output.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiagnosticCollector = void 0;
const utils_js_1 = require("./utils.js");
class DiagnosticCollector {
    constructor() {
        this.logContext = {};
        this.errorContext = {};
        this.metricContext = {};
        this.evalContext = {};
        this.flowMessages = [];
    }
    addLog(key, value, path = []) {
        (0, utils_js_1.updateNestedValue)(this.logContext, '', path, key, value);
    }
    setLog(key, value, path = []) {
        (0, utils_js_1.setNestedValue)(this.logContext, '', path, key, value);
    }
    addError(key, value, path = []) {
        (0, utils_js_1.updateNestedValue)(this.errorContext, '', path, key, value);
    }
    addMetric(key, value, path = []) {
        (0, utils_js_1.updateNestedValue)(this.metricContext, '', path, key, value);
    }
    setMetric(key, value, path = []) {
        (0, utils_js_1.setNestedValue)(this.metricContext, '', path, key, value);
    }
    addEval(key, value, path = []) {
        (0, utils_js_1.updateNestedValue)(this.evalContext, '', path, key, value);
    }
    setEval(key, value, path = []) {
        (0, utils_js_1.setNestedValue)(this.evalContext, '', path, key, value);
    }
    addFlowMessage(flowMessage) {
        this.flowMessages.push(flowMessage);
    }
}
exports.DiagnosticCollector = DiagnosticCollector;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRGlhZ25vc3RpY0NvbGxlY3Rvci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9saWIvbWVtb3J5L0RpYWdub3N0aWNDb2xsZWN0b3IudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7OztHQVFHOzs7QUFHSCx5Q0FBK0Q7QUFFL0QsTUFBYSxtQkFBbUI7SUFBaEM7UUFDUyxlQUFVLEdBQTJCLEVBQUUsQ0FBQztRQUN4QyxpQkFBWSxHQUEyQixFQUFFLENBQUM7UUFDMUMsa0JBQWEsR0FBMkIsRUFBRSxDQUFDO1FBQzNDLGdCQUFXLEdBQTJCLEVBQUUsQ0FBQztRQUN6QyxpQkFBWSxHQUFrQixFQUFFLENBQUM7SUFpQzFDLENBQUM7SUEvQkMsTUFBTSxDQUFDLEdBQVcsRUFBRSxLQUFVLEVBQUUsT0FBaUIsRUFBRTtRQUNqRCxJQUFBLDRCQUFpQixFQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDM0QsQ0FBQztJQUVELE1BQU0sQ0FBQyxHQUFXLEVBQUUsS0FBVSxFQUFFLE9BQWlCLEVBQUU7UUFDakQsSUFBQSx5QkFBYyxFQUFDLElBQUksQ0FBQyxVQUFVLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDeEQsQ0FBQztJQUVELFFBQVEsQ0FBQyxHQUFXLEVBQUUsS0FBVSxFQUFFLE9BQWlCLEVBQUU7UUFDbkQsSUFBQSw0QkFBaUIsRUFBQyxJQUFJLENBQUMsWUFBWSxFQUFFLEVBQUUsRUFBRSxJQUFJLEVBQUUsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQzdELENBQUM7SUFFRCxTQUFTLENBQUMsR0FBVyxFQUFFLEtBQVUsRUFBRSxPQUFpQixFQUFFO1FBQ3BELElBQUEsNEJBQWlCLEVBQUMsSUFBSSxDQUFDLGFBQWEsRUFBRSxFQUFFLEVBQUUsSUFBSSxFQUFFLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztJQUM5RCxDQUFDO0lBRUQsU0FBUyxDQUFDLEdBQVcsRUFBRSxLQUFVLEVBQUUsT0FBaUIsRUFBRTtRQUNwRCxJQUFBLHlCQUFjLEVBQUMsSUFBSSxDQUFDLGFBQWEsRUFBRSxFQUFFLEVBQUUsSUFBSSxFQUFFLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztJQUMzRCxDQUFDO0lBRUQsT0FBTyxDQUFDLEdBQVcsRUFBRSxLQUFVLEVBQUUsT0FBaUIsRUFBRTtRQUNsRCxJQUFBLDRCQUFpQixFQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDNUQsQ0FBQztJQUVELE9BQU8sQ0FBQyxHQUFXLEVBQUUsS0FBVSxFQUFFLE9BQWlCLEVBQUU7UUFDbEQsSUFBQSx5QkFBYyxFQUFDLElBQUksQ0FBQyxXQUFXLEVBQUUsRUFBRSxFQUFFLElBQUksRUFBRSxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7SUFDekQsQ0FBQztJQUVELGNBQWMsQ0FBQyxXQUF3QjtRQUNyQyxJQUFJLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUN0QyxDQUFDO0NBQ0Y7QUF0Q0Qsa0RBc0NDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEaWFnbm9zdGljQ29sbGVjdG9yIOKAlCBQZXItc3RhZ2UgbWV0YWRhdGEgY29sbGVjdG9yXG4gKlxuICogQ29sbGVjdHMgbm9uLWV4ZWN1dGlvbiBtZXRhZGF0YSBkdXJpbmcgYSBzdGFnZSdzIHJ1bjpcbiAqIC0gbG9ncywgZXJyb3JzLCBtZXRyaWNzLCBldmFscywgZmxvd01lc3NhZ2VzXG4gKlxuICogTGlrZSBhIGNvbXBpbGVyJ3MgZGlhZ25vc3RpYyBjb2xsZWN0b3Ig4oCUIGdhdGhlcnMgd2FybmluZ3MsIGVycm9ycyxcbiAqIGFuZCB0aW1pbmcgaW5mbyB3aXRob3V0IGFmZmVjdGluZyB0aGUgY29tcGlsYXRpb24gb3V0cHV0LlxuICovXG5cbmltcG9ydCB0eXBlIHsgRmxvd01lc3NhZ2UgfSBmcm9tICcuL3R5cGVzLmpzJztcbmltcG9ydCB7IHNldE5lc3RlZFZhbHVlLCB1cGRhdGVOZXN0ZWRWYWx1ZSB9IGZyb20gJy4vdXRpbHMuanMnO1xuXG5leHBvcnQgY2xhc3MgRGlhZ25vc3RpY0NvbGxlY3RvciB7XG4gIHB1YmxpYyBsb2dDb250ZXh0OiB7IFtrZXk6IHN0cmluZ106IGFueSB9ID0ge307XG4gIHB1YmxpYyBlcnJvckNvbnRleHQ6IHsgW2tleTogc3RyaW5nXTogYW55IH0gPSB7fTtcbiAgcHVibGljIG1ldHJpY0NvbnRleHQ6IHsgW2tleTogc3RyaW5nXTogYW55IH0gPSB7fTtcbiAgcHVibGljIGV2YWxDb250ZXh0OiB7IFtrZXk6IHN0cmluZ106IGFueSB9ID0ge307XG4gIHB1YmxpYyBmbG93TWVzc2FnZXM6IEZsb3dNZXNzYWdlW10gPSBbXTtcblxuICBhZGRMb2coa2V5OiBzdHJpbmcsIHZhbHVlOiBhbnksIHBhdGg6IHN0cmluZ1tdID0gW10pIHtcbiAgICB1cGRhdGVOZXN0ZWRWYWx1ZSh0aGlzLmxvZ0NvbnRleHQsICcnLCBwYXRoLCBrZXksIHZhbHVlKTtcbiAgfVxuXG4gIHNldExvZyhrZXk6IHN0cmluZywgdmFsdWU6IGFueSwgcGF0aDogc3RyaW5nW10gPSBbXSkge1xuICAgIHNldE5lc3RlZFZhbHVlKHRoaXMubG9nQ29udGV4dCwgJycsIHBhdGgsIGtleSwgdmFsdWUpO1xuICB9XG5cbiAgYWRkRXJyb3Ioa2V5OiBzdHJpbmcsIHZhbHVlOiBhbnksIHBhdGg6IHN0cmluZ1tdID0gW10pIHtcbiAgICB1cGRhdGVOZXN0ZWRWYWx1ZSh0aGlzLmVycm9yQ29udGV4dCwgJycsIHBhdGgsIGtleSwgdmFsdWUpO1xuICB9XG5cbiAgYWRkTWV0cmljKGtleTogc3RyaW5nLCB2YWx1ZTogYW55LCBwYXRoOiBzdHJpbmdbXSA9IFtdKSB7XG4gICAgdXBkYXRlTmVzdGVkVmFsdWUodGhpcy5tZXRyaWNDb250ZXh0LCAnJywgcGF0aCwga2V5LCB2YWx1ZSk7XG4gIH1cblxuICBzZXRNZXRyaWMoa2V5OiBzdHJpbmcsIHZhbHVlOiBhbnksIHBhdGg6IHN0cmluZ1tdID0gW10pIHtcbiAgICBzZXROZXN0ZWRWYWx1ZSh0aGlzLm1ldHJpY0NvbnRleHQsICcnLCBwYXRoLCBrZXksIHZhbHVlKTtcbiAgfVxuXG4gIGFkZEV2YWwoa2V5OiBzdHJpbmcsIHZhbHVlOiBhbnksIHBhdGg6IHN0cmluZ1tdID0gW10pIHtcbiAgICB1cGRhdGVOZXN0ZWRWYWx1ZSh0aGlzLmV2YWxDb250ZXh0LCAnJywgcGF0aCwga2V5LCB2YWx1ZSk7XG4gIH1cblxuICBzZXRFdmFsKGtleTogc3RyaW5nLCB2YWx1ZTogYW55LCBwYXRoOiBzdHJpbmdbXSA9IFtdKSB7XG4gICAgc2V0TmVzdGVkVmFsdWUodGhpcy5ldmFsQ29udGV4dCwgJycsIHBhdGgsIGtleSwgdmFsdWUpO1xuICB9XG5cbiAgYWRkRmxvd01lc3NhZ2UoZmxvd01lc3NhZ2U6IEZsb3dNZXNzYWdlKSB7XG4gICAgdGhpcy5mbG93TWVzc2FnZXMucHVzaChmbG93TWVzc2FnZSk7XG4gIH1cbn1cbiJdfQ==