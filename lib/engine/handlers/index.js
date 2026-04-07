"use strict";
/* istanbul ignore file */
/**
 * Barrel export for all engine handler modules.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuntimeStructureManager = exports.computeNodeType = exports.ExtractorRunner = exports.seedSubflowGlobalStore = exports.getInitialScopeValues = exports.extractParentScopeValues = exports.createSubflowHandlerDeps = exports.applyOutputMapping = exports.SubflowExecutor = exports.DEFAULT_MAX_ITERATIONS = exports.ContinuationResolver = exports.SelectorHandler = exports.DeciderHandler = exports.ChildrenExecutor = exports.NodeResolver = exports.StageRunner = void 0;
// Stage execution
var StageRunner_js_1 = require("./StageRunner.js");
Object.defineProperty(exports, "StageRunner", { enumerable: true, get: function () { return StageRunner_js_1.StageRunner; } });
// Node resolution and subflow reference handling
var NodeResolver_js_1 = require("./NodeResolver.js");
Object.defineProperty(exports, "NodeResolver", { enumerable: true, get: function () { return NodeResolver_js_1.NodeResolver; } });
// Parallel children execution
var ChildrenExecutor_js_1 = require("./ChildrenExecutor.js");
Object.defineProperty(exports, "ChildrenExecutor", { enumerable: true, get: function () { return ChildrenExecutor_js_1.ChildrenExecutor; } });
// Single-choice conditional branching
var DeciderHandler_js_1 = require("./DeciderHandler.js");
Object.defineProperty(exports, "DeciderHandler", { enumerable: true, get: function () { return DeciderHandler_js_1.DeciderHandler; } });
// Multi-choice filtered fan-out
var SelectorHandler_js_1 = require("./SelectorHandler.js");
Object.defineProperty(exports, "SelectorHandler", { enumerable: true, get: function () { return SelectorHandler_js_1.SelectorHandler; } });
// Back-edge resolution + iteration counting (was LoopHandler)
var ContinuationResolver_js_1 = require("./ContinuationResolver.js");
Object.defineProperty(exports, "ContinuationResolver", { enumerable: true, get: function () { return ContinuationResolver_js_1.ContinuationResolver; } });
Object.defineProperty(exports, "DEFAULT_MAX_ITERATIONS", { enumerable: true, get: function () { return ContinuationResolver_js_1.DEFAULT_MAX_ITERATIONS; } });
// Subflow execution with isolated contexts
var SubflowExecutor_js_1 = require("./SubflowExecutor.js");
Object.defineProperty(exports, "SubflowExecutor", { enumerable: true, get: function () { return SubflowExecutor_js_1.SubflowExecutor; } });
// Subflow input/output mapping
var SubflowInputMapper_js_1 = require("./SubflowInputMapper.js");
Object.defineProperty(exports, "applyOutputMapping", { enumerable: true, get: function () { return SubflowInputMapper_js_1.applyOutputMapping; } });
Object.defineProperty(exports, "createSubflowHandlerDeps", { enumerable: true, get: function () { return SubflowInputMapper_js_1.createSubflowHandlerDeps; } });
Object.defineProperty(exports, "extractParentScopeValues", { enumerable: true, get: function () { return SubflowInputMapper_js_1.extractParentScopeValues; } });
Object.defineProperty(exports, "getInitialScopeValues", { enumerable: true, get: function () { return SubflowInputMapper_js_1.getInitialScopeValues; } });
Object.defineProperty(exports, "seedSubflowGlobalStore", { enumerable: true, get: function () { return SubflowInputMapper_js_1.seedSubflowGlobalStore; } });
// Traversal extractor coordination
var ExtractorRunner_js_1 = require("./ExtractorRunner.js");
Object.defineProperty(exports, "ExtractorRunner", { enumerable: true, get: function () { return ExtractorRunner_js_1.ExtractorRunner; } });
// Runtime structure management (dynamic pipeline structure tracking)
var RuntimeStructureManager_js_1 = require("./RuntimeStructureManager.js");
Object.defineProperty(exports, "computeNodeType", { enumerable: true, get: function () { return RuntimeStructureManager_js_1.computeNodeType; } });
Object.defineProperty(exports, "RuntimeStructureManager", { enumerable: true, get: function () { return RuntimeStructureManager_js_1.RuntimeStructureManager; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9oYW5kbGVycy9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEsMEJBQTBCO0FBQzFCOztHQUVHOzs7QUFFSCxrQkFBa0I7QUFDbEIsbURBQStDO0FBQXRDLDZHQUFBLFdBQVcsT0FBQTtBQUVwQixpREFBaUQ7QUFDakQscURBQWlEO0FBQXhDLCtHQUFBLFlBQVksT0FBQTtBQUtyQiw4QkFBOEI7QUFDOUIsNkRBQXlEO0FBQWhELHVIQUFBLGdCQUFnQixPQUFBO0FBRXpCLHNDQUFzQztBQUN0Qyx5REFBcUQ7QUFBNUMsbUhBQUEsY0FBYyxPQUFBO0FBRXZCLGdDQUFnQztBQUNoQywyREFBdUQ7QUFBOUMscUhBQUEsZUFBZSxPQUFBO0FBRXhCLDhEQUE4RDtBQUM5RCxxRUFBeUY7QUFBaEYsK0hBQUEsb0JBQW9CLE9BQUE7QUFBRSxpSUFBQSxzQkFBc0IsT0FBQTtBQUVyRCwyQ0FBMkM7QUFDM0MsMkRBQXVEO0FBQTlDLHFIQUFBLGVBQWUsT0FBQTtBQUV4QiwrQkFBK0I7QUFDL0IsaUVBTWlDO0FBTC9CLDJIQUFBLGtCQUFrQixPQUFBO0FBQ2xCLGlJQUFBLHdCQUF3QixPQUFBO0FBQ3hCLGlJQUFBLHdCQUF3QixPQUFBO0FBQ3hCLDhIQUFBLHFCQUFxQixPQUFBO0FBQ3JCLCtIQUFBLHNCQUFzQixPQUFBO0FBR3hCLG1DQUFtQztBQUNuQywyREFBdUQ7QUFBOUMscUhBQUEsZUFBZSxPQUFBO0FBRXhCLHFFQUFxRTtBQUNyRSwyRUFBd0Y7QUFBL0UsNkhBQUEsZUFBZSxPQUFBO0FBQUUscUlBQUEsdUJBQXVCLE9BQUEiLCJzb3VyY2VzQ29udGVudCI6WyIvKiBpc3RhbmJ1bCBpZ25vcmUgZmlsZSAqL1xuLyoqXG4gKiBCYXJyZWwgZXhwb3J0IGZvciBhbGwgZW5naW5lIGhhbmRsZXIgbW9kdWxlcy5cbiAqL1xuXG4vLyBTdGFnZSBleGVjdXRpb25cbmV4cG9ydCB7IFN0YWdlUnVubmVyIH0gZnJvbSAnLi9TdGFnZVJ1bm5lci5qcyc7XG5cbi8vIE5vZGUgcmVzb2x1dGlvbiBhbmQgc3ViZmxvdyByZWZlcmVuY2UgaGFuZGxpbmdcbmV4cG9ydCB7IE5vZGVSZXNvbHZlciB9IGZyb20gJy4vTm9kZVJlc29sdmVyLmpzJztcblxuLy8gSGFuZGxlciBjYWxsYmFjayB0eXBlcyAoY2Fub25pY2FsIOKAlCBhdm9pZHMgY2lyY3VsYXIgZGVwIHdpdGggdHJhdmVyc2VyKVxuZXhwb3J0IHR5cGUgeyBDYWxsRXh0cmFjdG9yRm4sIEV4ZWN1dGVOb2RlRm4sIEdldFN0YWdlUGF0aEZuLCBSdW5TdGFnZUZuIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8vIFBhcmFsbGVsIGNoaWxkcmVuIGV4ZWN1dGlvblxuZXhwb3J0IHsgQ2hpbGRyZW5FeGVjdXRvciB9IGZyb20gJy4vQ2hpbGRyZW5FeGVjdXRvci5qcyc7XG5cbi8vIFNpbmdsZS1jaG9pY2UgY29uZGl0aW9uYWwgYnJhbmNoaW5nXG5leHBvcnQgeyBEZWNpZGVySGFuZGxlciB9IGZyb20gJy4vRGVjaWRlckhhbmRsZXIuanMnO1xuXG4vLyBNdWx0aS1jaG9pY2UgZmlsdGVyZWQgZmFuLW91dFxuZXhwb3J0IHsgU2VsZWN0b3JIYW5kbGVyIH0gZnJvbSAnLi9TZWxlY3RvckhhbmRsZXIuanMnO1xuXG4vLyBCYWNrLWVkZ2UgcmVzb2x1dGlvbiArIGl0ZXJhdGlvbiBjb3VudGluZyAod2FzIExvb3BIYW5kbGVyKVxuZXhwb3J0IHsgQ29udGludWF0aW9uUmVzb2x2ZXIsIERFRkFVTFRfTUFYX0lURVJBVElPTlMgfSBmcm9tICcuL0NvbnRpbnVhdGlvblJlc29sdmVyLmpzJztcblxuLy8gU3ViZmxvdyBleGVjdXRpb24gd2l0aCBpc29sYXRlZCBjb250ZXh0c1xuZXhwb3J0IHsgU3ViZmxvd0V4ZWN1dG9yIH0gZnJvbSAnLi9TdWJmbG93RXhlY3V0b3IuanMnO1xuXG4vLyBTdWJmbG93IGlucHV0L291dHB1dCBtYXBwaW5nXG5leHBvcnQge1xuICBhcHBseU91dHB1dE1hcHBpbmcsXG4gIGNyZWF0ZVN1YmZsb3dIYW5kbGVyRGVwcyxcbiAgZXh0cmFjdFBhcmVudFNjb3BlVmFsdWVzLFxuICBnZXRJbml0aWFsU2NvcGVWYWx1ZXMsXG4gIHNlZWRTdWJmbG93R2xvYmFsU3RvcmUsXG59IGZyb20gJy4vU3ViZmxvd0lucHV0TWFwcGVyLmpzJztcblxuLy8gVHJhdmVyc2FsIGV4dHJhY3RvciBjb29yZGluYXRpb25cbmV4cG9ydCB7IEV4dHJhY3RvclJ1bm5lciB9IGZyb20gJy4vRXh0cmFjdG9yUnVubmVyLmpzJztcblxuLy8gUnVudGltZSBzdHJ1Y3R1cmUgbWFuYWdlbWVudCAoZHluYW1pYyBwaXBlbGluZSBzdHJ1Y3R1cmUgdHJhY2tpbmcpXG5leHBvcnQgeyBjb21wdXRlTm9kZVR5cGUsIFJ1bnRpbWVTdHJ1Y3R1cmVNYW5hZ2VyIH0gZnJvbSAnLi9SdW50aW1lU3RydWN0dXJlTWFuYWdlci5qcyc7XG4iXX0=