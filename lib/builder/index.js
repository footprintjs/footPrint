"use strict";
/* istanbul ignore file */
/**
 * builder/ — Flowchart construction library (zero deps on old code)
 *
 * Fluent API for building StageNode trees and SerializedPipelineStructure.
 * Can be used standalone for building flowchart specs without execution.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArrayMergeMode = exports.specToStageNode = exports.flowChart = exports.SelectorFnList = exports.FlowChartBuilder = exports.DeciderList = void 0;
// Classes
var FlowChartBuilder_js_1 = require("./FlowChartBuilder.js");
Object.defineProperty(exports, "DeciderList", { enumerable: true, get: function () { return FlowChartBuilder_js_1.DeciderList; } });
Object.defineProperty(exports, "FlowChartBuilder", { enumerable: true, get: function () { return FlowChartBuilder_js_1.FlowChartBuilder; } });
Object.defineProperty(exports, "SelectorFnList", { enumerable: true, get: function () { return FlowChartBuilder_js_1.SelectorFnList; } });
// Factory & utilities
var FlowChartBuilder_js_2 = require("./FlowChartBuilder.js");
Object.defineProperty(exports, "flowChart", { enumerable: true, get: function () { return FlowChartBuilder_js_2.flowChart; } });
Object.defineProperty(exports, "specToStageNode", { enumerable: true, get: function () { return FlowChartBuilder_js_2.specToStageNode; } });
var types_js_1 = require("./types.js");
Object.defineProperty(exports, "ArrayMergeMode", { enumerable: true, get: function () { return types_js_1.ArrayMergeMode; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL2J1aWxkZXIvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBLDBCQUEwQjtBQUMxQjs7Ozs7R0FLRzs7O0FBRUgsVUFBVTtBQUNWLDZEQUFzRjtBQUE3RSxrSEFBQSxXQUFXLE9BQUE7QUFBRSx1SEFBQSxnQkFBZ0IsT0FBQTtBQUFFLHFIQUFBLGNBQWMsT0FBQTtBQUV0RCxzQkFBc0I7QUFDdEIsNkRBQW1FO0FBQTFELGdIQUFBLFNBQVMsT0FBQTtBQUFFLHNIQUFBLGVBQWUsT0FBQTtBQXdCbkMsdUNBQTRDO0FBQW5DLDBHQUFBLGNBQWMsT0FBQSIsInNvdXJjZXNDb250ZW50IjpbIi8qIGlzdGFuYnVsIGlnbm9yZSBmaWxlICovXG4vKipcbiAqIGJ1aWxkZXIvIOKAlCBGbG93Y2hhcnQgY29uc3RydWN0aW9uIGxpYnJhcnkgKHplcm8gZGVwcyBvbiBvbGQgY29kZSlcbiAqXG4gKiBGbHVlbnQgQVBJIGZvciBidWlsZGluZyBTdGFnZU5vZGUgdHJlZXMgYW5kIFNlcmlhbGl6ZWRQaXBlbGluZVN0cnVjdHVyZS5cbiAqIENhbiBiZSB1c2VkIHN0YW5kYWxvbmUgZm9yIGJ1aWxkaW5nIGZsb3djaGFydCBzcGVjcyB3aXRob3V0IGV4ZWN1dGlvbi5cbiAqL1xuXG4vLyBDbGFzc2VzXG5leHBvcnQgeyBEZWNpZGVyTGlzdCwgRmxvd0NoYXJ0QnVpbGRlciwgU2VsZWN0b3JGbkxpc3QgfSBmcm9tICcuL0Zsb3dDaGFydEJ1aWxkZXIuanMnO1xuXG4vLyBGYWN0b3J5ICYgdXRpbGl0aWVzXG5leHBvcnQgeyBmbG93Q2hhcnQsIHNwZWNUb1N0YWdlTm9kZSB9IGZyb20gJy4vRmxvd0NoYXJ0QnVpbGRlci5qcyc7XG5cbi8vIFR5cGVzXG5leHBvcnQgdHlwZSB7XG4gIEJ1aWxkVGltZUV4dHJhY3RvcixcbiAgQnVpbGRUaW1lTm9kZU1ldGFkYXRhLFxuICBFeGVjT3B0aW9ucyxcbiAgRmxvd0NoYXJ0LFxuICBGbG93Q2hhcnRTcGVjLFxuICBJTG9nZ2VyLFxuICBTY29wZVByb3RlY3Rpb25Nb2RlLFxuICBTZXJpYWxpemVkUGlwZWxpbmVTdHJ1Y3R1cmUsXG4gIFNpbXBsaWZpZWRQYXJhbGxlbFNwZWMsXG4gIFN0YWdlRm4sXG4gIFN0YWdlRnVuY3Rpb24sXG4gIFN0YWdlTm9kZSxcbiAgU3RyZWFtQ2FsbGJhY2ssXG4gIFN0cmVhbUhhbmRsZXJzLFxuICBTdHJlYW1MaWZlY3ljbGVIYW5kbGVyLFxuICBTdHJlYW1Ub2tlbkhhbmRsZXIsXG4gIFN1YmZsb3dNb3VudE9wdGlvbnMsXG4gIFN1YmZsb3dSZWYsXG4gIFRyYXZlcnNhbEV4dHJhY3Rvcixcbn0gZnJvbSAnLi90eXBlcy5qcyc7XG5leHBvcnQgeyBBcnJheU1lcmdlTW9kZSB9IGZyb20gJy4vdHlwZXMuanMnO1xuIl19