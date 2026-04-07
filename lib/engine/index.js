"use strict";
/* istanbul ignore file */
/**
 * engine/ — Graph traversal engine library.
 *
 * Executes flowcharts built by FlowChartBuilder via pre-order DFS traversal.
 * Handles linear, fork, decider, selector, loop, and subflow node shapes.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WindowedNarrativeFlowRecorder = exports.SilentNarrativeFlowRecorder = exports.SeparateNarrativeFlowRecorder = exports.RLENarrativeFlowRecorder = exports.ProgressiveNarrativeFlowRecorder = exports.MilestoneNarrativeFlowRecorder = exports.ManifestFlowRecorder = exports.AdaptiveNarrativeFlowRecorder = exports.formatErrorInfo = exports.extractErrorInfo = exports.NarrativeFlowRecorder = exports.FlowRecorderDispatcher = exports.NullControlFlowNarrativeGenerator = exports.isStageNodeReturn = exports.FlowchartTraverser = void 0;
var FlowchartTraverser_js_1 = require("./traversal/FlowchartTraverser.js");
Object.defineProperty(exports, "FlowchartTraverser", { enumerable: true, get: function () { return FlowchartTraverser_js_1.FlowchartTraverser; } });
// Graph node types (Decider, Selector, StageNode re-exported via ./types)
var StageNode_js_1 = require("./graph/StageNode.js");
Object.defineProperty(exports, "isStageNodeReturn", { enumerable: true, get: function () { return StageNode_js_1.isStageNodeReturn; } });
// Types
__exportStar(require("./types.js"), exports);
// Handlers (for advanced use cases and testing)
__exportStar(require("./handlers/index.js"), exports);
var NullControlFlowNarrativeGenerator_js_1 = require("./narrative/NullControlFlowNarrativeGenerator.js");
Object.defineProperty(exports, "NullControlFlowNarrativeGenerator", { enumerable: true, get: function () { return NullControlFlowNarrativeGenerator_js_1.NullControlFlowNarrativeGenerator; } });
// FlowRecorder system
var FlowRecorderDispatcher_js_1 = require("./narrative/FlowRecorderDispatcher.js");
Object.defineProperty(exports, "FlowRecorderDispatcher", { enumerable: true, get: function () { return FlowRecorderDispatcher_js_1.FlowRecorderDispatcher; } });
var NarrativeFlowRecorder_js_1 = require("./narrative/NarrativeFlowRecorder.js");
Object.defineProperty(exports, "NarrativeFlowRecorder", { enumerable: true, get: function () { return NarrativeFlowRecorder_js_1.NarrativeFlowRecorder; } });
var errorInfo_js_1 = require("./errors/errorInfo.js");
Object.defineProperty(exports, "extractErrorInfo", { enumerable: true, get: function () { return errorInfo_js_1.extractErrorInfo; } });
Object.defineProperty(exports, "formatErrorInfo", { enumerable: true, get: function () { return errorInfo_js_1.formatErrorInfo; } });
// Built-in FlowRecorder strategies (tree-shakeable)
var AdaptiveNarrativeFlowRecorder_js_1 = require("./narrative/recorders/AdaptiveNarrativeFlowRecorder.js");
Object.defineProperty(exports, "AdaptiveNarrativeFlowRecorder", { enumerable: true, get: function () { return AdaptiveNarrativeFlowRecorder_js_1.AdaptiveNarrativeFlowRecorder; } });
var ManifestFlowRecorder_js_1 = require("./narrative/recorders/ManifestFlowRecorder.js");
Object.defineProperty(exports, "ManifestFlowRecorder", { enumerable: true, get: function () { return ManifestFlowRecorder_js_1.ManifestFlowRecorder; } });
var MilestoneNarrativeFlowRecorder_js_1 = require("./narrative/recorders/MilestoneNarrativeFlowRecorder.js");
Object.defineProperty(exports, "MilestoneNarrativeFlowRecorder", { enumerable: true, get: function () { return MilestoneNarrativeFlowRecorder_js_1.MilestoneNarrativeFlowRecorder; } });
var ProgressiveNarrativeFlowRecorder_js_1 = require("./narrative/recorders/ProgressiveNarrativeFlowRecorder.js");
Object.defineProperty(exports, "ProgressiveNarrativeFlowRecorder", { enumerable: true, get: function () { return ProgressiveNarrativeFlowRecorder_js_1.ProgressiveNarrativeFlowRecorder; } });
var RLENarrativeFlowRecorder_js_1 = require("./narrative/recorders/RLENarrativeFlowRecorder.js");
Object.defineProperty(exports, "RLENarrativeFlowRecorder", { enumerable: true, get: function () { return RLENarrativeFlowRecorder_js_1.RLENarrativeFlowRecorder; } });
var SeparateNarrativeFlowRecorder_js_1 = require("./narrative/recorders/SeparateNarrativeFlowRecorder.js");
Object.defineProperty(exports, "SeparateNarrativeFlowRecorder", { enumerable: true, get: function () { return SeparateNarrativeFlowRecorder_js_1.SeparateNarrativeFlowRecorder; } });
var SilentNarrativeFlowRecorder_js_1 = require("./narrative/recorders/SilentNarrativeFlowRecorder.js");
Object.defineProperty(exports, "SilentNarrativeFlowRecorder", { enumerable: true, get: function () { return SilentNarrativeFlowRecorder_js_1.SilentNarrativeFlowRecorder; } });
var WindowedNarrativeFlowRecorder_js_1 = require("./narrative/recorders/WindowedNarrativeFlowRecorder.js");
Object.defineProperty(exports, "WindowedNarrativeFlowRecorder", { enumerable: true, get: function () { return WindowedNarrativeFlowRecorder_js_1.WindowedNarrativeFlowRecorder; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEsMEJBQTBCO0FBQzFCOzs7OztHQUtHOzs7Ozs7Ozs7Ozs7Ozs7OztBQUlILDJFQUF1RTtBQUE5RCwySEFBQSxrQkFBa0IsT0FBQTtBQUUzQiwwRUFBMEU7QUFDMUUscURBQXlEO0FBQWhELGlIQUFBLGlCQUFpQixPQUFBO0FBRTFCLFFBQVE7QUFDUiw2Q0FBMkI7QUFFM0IsZ0RBQWdEO0FBQ2hELHNEQUFvQztBQUlwQyx5R0FBcUc7QUFBNUYseUpBQUEsaUNBQWlDLE9BQUE7QUFHMUMsc0JBQXNCO0FBQ3RCLG1GQUErRTtBQUF0RSxtSUFBQSxzQkFBc0IsT0FBQTtBQUMvQixpRkFBNkU7QUFBcEUsaUlBQUEscUJBQXFCLE9BQUE7QUFrQjlCLHNEQUEwRTtBQUFqRSxnSEFBQSxnQkFBZ0IsT0FBQTtBQUFFLCtHQUFBLGVBQWUsT0FBQTtBQUUxQyxvREFBb0Q7QUFDcEQsMkdBQXVHO0FBQTlGLGlKQUFBLDZCQUE2QixPQUFBO0FBRXRDLHlGQUFxRjtBQUE1RSwrSEFBQSxvQkFBb0IsT0FBQTtBQUM3Qiw2R0FBeUc7QUFBaEcsbUpBQUEsOEJBQThCLE9BQUE7QUFDdkMsaUhBQTZHO0FBQXBHLHVKQUFBLGdDQUFnQyxPQUFBO0FBQ3pDLGlHQUE2RjtBQUFwRix1SUFBQSx3QkFBd0IsT0FBQTtBQUNqQywyR0FBdUc7QUFBOUYsaUpBQUEsNkJBQTZCLE9BQUE7QUFDdEMsdUdBQW1HO0FBQTFGLDZJQUFBLDJCQUEyQixPQUFBO0FBQ3BDLDJHQUF1RztBQUE5RixpSkFBQSw2QkFBNkIsT0FBQSIsInNvdXJjZXNDb250ZW50IjpbIi8qIGlzdGFuYnVsIGlnbm9yZSBmaWxlICovXG4vKipcbiAqIGVuZ2luZS8g4oCUIEdyYXBoIHRyYXZlcnNhbCBlbmdpbmUgbGlicmFyeS5cbiAqXG4gKiBFeGVjdXRlcyBmbG93Y2hhcnRzIGJ1aWx0IGJ5IEZsb3dDaGFydEJ1aWxkZXIgdmlhIHByZS1vcmRlciBERlMgdHJhdmVyc2FsLlxuICogSGFuZGxlcyBsaW5lYXIsIGZvcmssIGRlY2lkZXIsIHNlbGVjdG9yLCBsb29wLCBhbmQgc3ViZmxvdyBub2RlIHNoYXBlcy5cbiAqL1xuXG4vLyBDb3JlIHRyYXZlcnNlclxuZXhwb3J0IHR5cGUgeyBUcmF2ZXJzZXJPcHRpb25zIH0gZnJvbSAnLi90cmF2ZXJzYWwvRmxvd2NoYXJ0VHJhdmVyc2VyLmpzJztcbmV4cG9ydCB7IEZsb3djaGFydFRyYXZlcnNlciB9IGZyb20gJy4vdHJhdmVyc2FsL0Zsb3djaGFydFRyYXZlcnNlci5qcyc7XG5cbi8vIEdyYXBoIG5vZGUgdHlwZXMgKERlY2lkZXIsIFNlbGVjdG9yLCBTdGFnZU5vZGUgcmUtZXhwb3J0ZWQgdmlhIC4vdHlwZXMpXG5leHBvcnQgeyBpc1N0YWdlTm9kZVJldHVybiB9IGZyb20gJy4vZ3JhcGgvU3RhZ2VOb2RlLmpzJztcblxuLy8gVHlwZXNcbmV4cG9ydCAqIGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyBIYW5kbGVycyAoZm9yIGFkdmFuY2VkIHVzZSBjYXNlcyBhbmQgdGVzdGluZylcbmV4cG9ydCAqIGZyb20gJy4vaGFuZGxlcnMvaW5kZXguanMnO1xuXG4vLyBOYXJyYXRpdmUgZ2VuZXJhdGlvblxuZXhwb3J0IHR5cGUgeyBDb21iaW5lZE5hcnJhdGl2ZUVudHJ5LCBDb21iaW5lZE5hcnJhdGl2ZU9wdGlvbnMgfSBmcm9tICcuL25hcnJhdGl2ZS9uYXJyYXRpdmVUeXBlcy5qcyc7XG5leHBvcnQgeyBOdWxsQ29udHJvbEZsb3dOYXJyYXRpdmVHZW5lcmF0b3IgfSBmcm9tICcuL25hcnJhdGl2ZS9OdWxsQ29udHJvbEZsb3dOYXJyYXRpdmVHZW5lcmF0b3IuanMnO1xuZXhwb3J0IHR5cGUgeyBJQ29udHJvbEZsb3dOYXJyYXRpdmUgfSBmcm9tICcuL25hcnJhdGl2ZS90eXBlcy5qcyc7XG5cbi8vIEZsb3dSZWNvcmRlciBzeXN0ZW1cbmV4cG9ydCB7IEZsb3dSZWNvcmRlckRpc3BhdGNoZXIgfSBmcm9tICcuL25hcnJhdGl2ZS9GbG93UmVjb3JkZXJEaXNwYXRjaGVyLmpzJztcbmV4cG9ydCB7IE5hcnJhdGl2ZUZsb3dSZWNvcmRlciB9IGZyb20gJy4vbmFycmF0aXZlL05hcnJhdGl2ZUZsb3dSZWNvcmRlci5qcyc7XG5leHBvcnQgdHlwZSB7XG4gIEZsb3dCcmVha0V2ZW50LFxuICBGbG93RGVjaXNpb25FdmVudCxcbiAgRmxvd0Vycm9yRXZlbnQsXG4gIEZsb3dGb3JrRXZlbnQsXG4gIEZsb3dMb29wRXZlbnQsXG4gIEZsb3dOZXh0RXZlbnQsXG4gIEZsb3dSZWNvcmRlcixcbiAgRmxvd1NlbGVjdGVkRXZlbnQsXG4gIEZsb3dTdGFnZUV2ZW50LFxuICBGbG93U3ViZmxvd0V2ZW50LFxuICBGbG93U3ViZmxvd1JlZ2lzdGVyZWRFdmVudCxcbiAgVHJhdmVyc2FsQ29udGV4dCxcbn0gZnJvbSAnLi9uYXJyYXRpdmUvdHlwZXMuanMnO1xuXG4vLyBTdHJ1Y3R1cmVkIGVycm9yIGV4dHJhY3Rpb25cbmV4cG9ydCB0eXBlIHsgU3RydWN0dXJlZEVycm9ySW5mbyB9IGZyb20gJy4vZXJyb3JzL2Vycm9ySW5mby5qcyc7XG5leHBvcnQgeyBleHRyYWN0RXJyb3JJbmZvLCBmb3JtYXRFcnJvckluZm8gfSBmcm9tICcuL2Vycm9ycy9lcnJvckluZm8uanMnO1xuXG4vLyBCdWlsdC1pbiBGbG93UmVjb3JkZXIgc3RyYXRlZ2llcyAodHJlZS1zaGFrZWFibGUpXG5leHBvcnQgeyBBZGFwdGl2ZU5hcnJhdGl2ZUZsb3dSZWNvcmRlciB9IGZyb20gJy4vbmFycmF0aXZlL3JlY29yZGVycy9BZGFwdGl2ZU5hcnJhdGl2ZUZsb3dSZWNvcmRlci5qcyc7XG5leHBvcnQgdHlwZSB7IE1hbmlmZXN0RW50cnkgfSBmcm9tICcuL25hcnJhdGl2ZS9yZWNvcmRlcnMvTWFuaWZlc3RGbG93UmVjb3JkZXIuanMnO1xuZXhwb3J0IHsgTWFuaWZlc3RGbG93UmVjb3JkZXIgfSBmcm9tICcuL25hcnJhdGl2ZS9yZWNvcmRlcnMvTWFuaWZlc3RGbG93UmVjb3JkZXIuanMnO1xuZXhwb3J0IHsgTWlsZXN0b25lTmFycmF0aXZlRmxvd1JlY29yZGVyIH0gZnJvbSAnLi9uYXJyYXRpdmUvcmVjb3JkZXJzL01pbGVzdG9uZU5hcnJhdGl2ZUZsb3dSZWNvcmRlci5qcyc7XG5leHBvcnQgeyBQcm9ncmVzc2l2ZU5hcnJhdGl2ZUZsb3dSZWNvcmRlciB9IGZyb20gJy4vbmFycmF0aXZlL3JlY29yZGVycy9Qcm9ncmVzc2l2ZU5hcnJhdGl2ZUZsb3dSZWNvcmRlci5qcyc7XG5leHBvcnQgeyBSTEVOYXJyYXRpdmVGbG93UmVjb3JkZXIgfSBmcm9tICcuL25hcnJhdGl2ZS9yZWNvcmRlcnMvUkxFTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzJztcbmV4cG9ydCB7IFNlcGFyYXRlTmFycmF0aXZlRmxvd1JlY29yZGVyIH0gZnJvbSAnLi9uYXJyYXRpdmUvcmVjb3JkZXJzL1NlcGFyYXRlTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzJztcbmV4cG9ydCB7IFNpbGVudE5hcnJhdGl2ZUZsb3dSZWNvcmRlciB9IGZyb20gJy4vbmFycmF0aXZlL3JlY29yZGVycy9TaWxlbnROYXJyYXRpdmVGbG93UmVjb3JkZXIuanMnO1xuZXhwb3J0IHsgV2luZG93ZWROYXJyYXRpdmVGbG93UmVjb3JkZXIgfSBmcm9tICcuL25hcnJhdGl2ZS9yZWNvcmRlcnMvV2luZG93ZWROYXJyYXRpdmVGbG93UmVjb3JkZXIuanMnO1xuIl19