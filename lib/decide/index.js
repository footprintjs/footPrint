"use strict";
/**
 * decide/ -- Decision reasoning capture for footprintjs.
 *
 * decide() and select() auto-capture evidence from decider/selector functions:
 * - Function when: (s) => s.creditScore > 700  (auto-captures reads)
 * - Filter when:  { creditScore: { gt: 700 } }  (captures reads + operators + thresholds)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvidenceCollector = exports.evaluateFilter = exports.select = exports.decide = exports.DECISION_RESULT = void 0;
// Runtime constants
var types_js_1 = require("./types.js");
Object.defineProperty(exports, "DECISION_RESULT", { enumerable: true, get: function () { return types_js_1.DECISION_RESULT; } });
// Core functions
var decide_js_1 = require("./decide.js");
Object.defineProperty(exports, "decide", { enumerable: true, get: function () { return decide_js_1.decide; } });
Object.defineProperty(exports, "select", { enumerable: true, get: function () { return decide_js_1.select; } });
// Evaluator (for advanced use)
var evaluator_js_1 = require("./evaluator.js");
Object.defineProperty(exports, "evaluateFilter", { enumerable: true, get: function () { return evaluator_js_1.evaluateFilter; } });
// Evidence collector (for advanced use)
var evidence_js_1 = require("./evidence.js");
Object.defineProperty(exports, "EvidenceCollector", { enumerable: true, get: function () { return evidence_js_1.EvidenceCollector; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL2RlY2lkZS9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7OztHQU1HOzs7QUFtQkgsb0JBQW9CO0FBQ3BCLHVDQUE2QztBQUFwQywyR0FBQSxlQUFlLE9BQUE7QUFFeEIsaUJBQWlCO0FBQ2pCLHlDQUE2QztBQUFwQyxtR0FBQSxNQUFNLE9BQUE7QUFBRSxtR0FBQSxNQUFNLE9BQUE7QUFFdkIsK0JBQStCO0FBQy9CLCtDQUFnRDtBQUF2Qyw4R0FBQSxjQUFjLE9BQUE7QUFFdkIsd0NBQXdDO0FBQ3hDLDZDQUFrRDtBQUF6QyxnSEFBQSxpQkFBaUIsT0FBQSIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogZGVjaWRlLyAtLSBEZWNpc2lvbiByZWFzb25pbmcgY2FwdHVyZSBmb3IgZm9vdHByaW50anMuXG4gKlxuICogZGVjaWRlKCkgYW5kIHNlbGVjdCgpIGF1dG8tY2FwdHVyZSBldmlkZW5jZSBmcm9tIGRlY2lkZXIvc2VsZWN0b3IgZnVuY3Rpb25zOlxuICogLSBGdW5jdGlvbiB3aGVuOiAocykgPT4gcy5jcmVkaXRTY29yZSA+IDcwMCAgKGF1dG8tY2FwdHVyZXMgcmVhZHMpXG4gKiAtIEZpbHRlciB3aGVuOiAgeyBjcmVkaXRTY29yZTogeyBndDogNzAwIH0gfSAgKGNhcHR1cmVzIHJlYWRzICsgb3BlcmF0b3JzICsgdGhyZXNob2xkcylcbiAqL1xuXG4vLyBUeXBlc1xuZXhwb3J0IHR5cGUge1xuICBEZWNpZGVSdWxlLFxuICBEZWNpc2lvbkV2aWRlbmNlLFxuICBEZWNpc2lvblJlc3VsdCxcbiAgRmlsdGVyQ29uZGl0aW9uLFxuICBGaWx0ZXJPcHMsXG4gIEZpbHRlclJ1bGVFdmlkZW5jZSxcbiAgRnVuY3Rpb25SdWxlRXZpZGVuY2UsXG4gIFJlYWRJbnB1dCxcbiAgUnVsZUV2aWRlbmNlLFxuICBTZWxlY3Rpb25FdmlkZW5jZSxcbiAgU2VsZWN0aW9uUmVzdWx0LFxuICBXaGVuQ2xhdXNlLFxuICBXaGVyZUZpbHRlcixcbn0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8vIFJ1bnRpbWUgY29uc3RhbnRzXG5leHBvcnQgeyBERUNJU0lPTl9SRVNVTFQgfSBmcm9tICcuL3R5cGVzLmpzJztcblxuLy8gQ29yZSBmdW5jdGlvbnNcbmV4cG9ydCB7IGRlY2lkZSwgc2VsZWN0IH0gZnJvbSAnLi9kZWNpZGUuanMnO1xuXG4vLyBFdmFsdWF0b3IgKGZvciBhZHZhbmNlZCB1c2UpXG5leHBvcnQgeyBldmFsdWF0ZUZpbHRlciB9IGZyb20gJy4vZXZhbHVhdG9yLmpzJztcblxuLy8gRXZpZGVuY2UgY29sbGVjdG9yIChmb3IgYWR2YW5jZWQgdXNlKVxuZXhwb3J0IHsgRXZpZGVuY2VDb2xsZWN0b3IgfSBmcm9tICcuL2V2aWRlbmNlLmpzJztcbiJdfQ==