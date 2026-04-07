"use strict";
/* istanbul ignore file */
/**
 * memory/ — Foundation library (zero external deps)
 *
 * Transactional state management with namespace isolation,
 * atomic commits, and event-sourced time-travel.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateValue = exports.updateNestedValue = exports.setNestedValue = exports.redactPatch = exports.normalisePath = exports.getRunAndGlobalPaths = exports.getNestedValue = exports.DELIM = exports.deepSmartMerge = exports.applySmartMerge = exports.TransactionBuffer = exports.StageContext = exports.SharedMemory = exports.EventLog = exports.DiagnosticCollector = void 0;
// Classes
var DiagnosticCollector_js_1 = require("./DiagnosticCollector.js");
Object.defineProperty(exports, "DiagnosticCollector", { enumerable: true, get: function () { return DiagnosticCollector_js_1.DiagnosticCollector; } });
var EventLog_js_1 = require("./EventLog.js");
Object.defineProperty(exports, "EventLog", { enumerable: true, get: function () { return EventLog_js_1.EventLog; } });
var SharedMemory_js_1 = require("./SharedMemory.js");
Object.defineProperty(exports, "SharedMemory", { enumerable: true, get: function () { return SharedMemory_js_1.SharedMemory; } });
var StageContext_js_1 = require("./StageContext.js");
Object.defineProperty(exports, "StageContext", { enumerable: true, get: function () { return StageContext_js_1.StageContext; } });
var TransactionBuffer_js_1 = require("./TransactionBuffer.js");
Object.defineProperty(exports, "TransactionBuffer", { enumerable: true, get: function () { return TransactionBuffer_js_1.TransactionBuffer; } });
// Utilities
var utils_js_1 = require("./utils.js");
Object.defineProperty(exports, "applySmartMerge", { enumerable: true, get: function () { return utils_js_1.applySmartMerge; } });
Object.defineProperty(exports, "deepSmartMerge", { enumerable: true, get: function () { return utils_js_1.deepSmartMerge; } });
Object.defineProperty(exports, "DELIM", { enumerable: true, get: function () { return utils_js_1.DELIM; } });
Object.defineProperty(exports, "getNestedValue", { enumerable: true, get: function () { return utils_js_1.getNestedValue; } });
Object.defineProperty(exports, "getRunAndGlobalPaths", { enumerable: true, get: function () { return utils_js_1.getRunAndGlobalPaths; } });
Object.defineProperty(exports, "normalisePath", { enumerable: true, get: function () { return utils_js_1.normalisePath; } });
Object.defineProperty(exports, "redactPatch", { enumerable: true, get: function () { return utils_js_1.redactPatch; } });
Object.defineProperty(exports, "setNestedValue", { enumerable: true, get: function () { return utils_js_1.setNestedValue; } });
Object.defineProperty(exports, "updateNestedValue", { enumerable: true, get: function () { return utils_js_1.updateNestedValue; } });
Object.defineProperty(exports, "updateValue", { enumerable: true, get: function () { return utils_js_1.updateValue; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL21lbW9yeS9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUEsMEJBQTBCO0FBQzFCOzs7OztHQUtHOzs7QUFFSCxVQUFVO0FBQ1YsbUVBQStEO0FBQXRELDZIQUFBLG1CQUFtQixPQUFBO0FBQzVCLDZDQUF5QztBQUFoQyx1R0FBQSxRQUFRLE9BQUE7QUFDakIscURBQWlEO0FBQXhDLCtHQUFBLFlBQVksT0FBQTtBQUNyQixxREFBaUQ7QUFBeEMsK0dBQUEsWUFBWSxPQUFBO0FBQ3JCLCtEQUEyRDtBQUFsRCx5SEFBQSxpQkFBaUIsT0FBQTtBQWExQixZQUFZO0FBQ1osdUNBV29CO0FBVmxCLDJHQUFBLGVBQWUsT0FBQTtBQUNmLDBHQUFBLGNBQWMsT0FBQTtBQUNkLGlHQUFBLEtBQUssT0FBQTtBQUNMLDBHQUFBLGNBQWMsT0FBQTtBQUNkLGdIQUFBLG9CQUFvQixPQUFBO0FBQ3BCLHlHQUFBLGFBQWEsT0FBQTtBQUNiLHVHQUFBLFdBQVcsT0FBQTtBQUNYLDBHQUFBLGNBQWMsT0FBQTtBQUNkLDZHQUFBLGlCQUFpQixPQUFBO0FBQ2pCLHVHQUFBLFdBQVcsT0FBQSIsInNvdXJjZXNDb250ZW50IjpbIi8qIGlzdGFuYnVsIGlnbm9yZSBmaWxlICovXG4vKipcbiAqIG1lbW9yeS8g4oCUIEZvdW5kYXRpb24gbGlicmFyeSAoemVybyBleHRlcm5hbCBkZXBzKVxuICpcbiAqIFRyYW5zYWN0aW9uYWwgc3RhdGUgbWFuYWdlbWVudCB3aXRoIG5hbWVzcGFjZSBpc29sYXRpb24sXG4gKiBhdG9taWMgY29tbWl0cywgYW5kIGV2ZW50LXNvdXJjZWQgdGltZS10cmF2ZWwuXG4gKi9cblxuLy8gQ2xhc3Nlc1xuZXhwb3J0IHsgRGlhZ25vc3RpY0NvbGxlY3RvciB9IGZyb20gJy4vRGlhZ25vc3RpY0NvbGxlY3Rvci5qcyc7XG5leHBvcnQgeyBFdmVudExvZyB9IGZyb20gJy4vRXZlbnRMb2cuanMnO1xuZXhwb3J0IHsgU2hhcmVkTWVtb3J5IH0gZnJvbSAnLi9TaGFyZWRNZW1vcnkuanMnO1xuZXhwb3J0IHsgU3RhZ2VDb250ZXh0IH0gZnJvbSAnLi9TdGFnZUNvbnRleHQuanMnO1xuZXhwb3J0IHsgVHJhbnNhY3Rpb25CdWZmZXIgfSBmcm9tICcuL1RyYW5zYWN0aW9uQnVmZmVyLmpzJztcblxuLy8gVHlwZXNcbmV4cG9ydCB0eXBlIHtcbiAgQ29tbWl0QnVuZGxlLFxuICBGbG93Q29udHJvbFR5cGUsXG4gIEZsb3dNZXNzYWdlLFxuICBNZW1vcnlQYXRjaCxcbiAgU2NvcGVGYWN0b3J5LFxuICBTdGFnZVNuYXBzaG90LFxuICBUcmFjZUVudHJ5LFxufSBmcm9tICcuL3R5cGVzLmpzJztcblxuLy8gVXRpbGl0aWVzXG5leHBvcnQge1xuICBhcHBseVNtYXJ0TWVyZ2UsXG4gIGRlZXBTbWFydE1lcmdlLFxuICBERUxJTSxcbiAgZ2V0TmVzdGVkVmFsdWUsXG4gIGdldFJ1bkFuZEdsb2JhbFBhdGhzLFxuICBub3JtYWxpc2VQYXRoLFxuICByZWRhY3RQYXRjaCxcbiAgc2V0TmVzdGVkVmFsdWUsXG4gIHVwZGF0ZU5lc3RlZFZhbHVlLFxuICB1cGRhdGVWYWx1ZSxcbn0gZnJvbSAnLi91dGlscy5qcyc7XG4iXX0=