"use strict";
/* istanbul ignore file */
/**
 * contract/ — FlowChart I/O contract and OpenAPI generation layer.
 *
 * Standalone library: wraps a compiled FlowChart with input/output schemas
 * and generates OpenAPI 3.1 specs. Uses the same inputMapper/outputMapper
 * pattern as subflow mounting.
 *
 * Zero runtime deps on Zod — Zod schemas detected via duck-typing and
 * converted to JSON Schema at contract creation time.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateOpenAPI = exports.zodToJsonSchema = exports.normalizeSchema = exports.defineContract = void 0;
// Factory
var defineContract_js_1 = require("./defineContract.js");
Object.defineProperty(exports, "defineContract", { enumerable: true, get: function () { return defineContract_js_1.defineContract; } });
// Schema utilities
var schema_js_1 = require("./schema.js");
Object.defineProperty(exports, "normalizeSchema", { enumerable: true, get: function () { return schema_js_1.normalizeSchema; } });
Object.defineProperty(exports, "zodToJsonSchema", { enumerable: true, get: function () { return schema_js_1.zodToJsonSchema; } });
// OpenAPI generator
var openapi_js_1 = require("./openapi.js");
Object.defineProperty(exports, "generateOpenAPI", { enumerable: true, get: function () { return openapi_js_1.generateOpenAPI; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL2NvbnRyYWN0L2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQSwwQkFBMEI7QUFDMUI7Ozs7Ozs7OztHQVNHOzs7QUFFSCxVQUFVO0FBQ1YseURBQXFEO0FBQTVDLG1IQUFBLGNBQWMsT0FBQTtBQUV2QixtQkFBbUI7QUFDbkIseUNBQStEO0FBQXRELDRHQUFBLGVBQWUsT0FBQTtBQUFFLDRHQUFBLGVBQWUsT0FBQTtBQUV6QyxvQkFBb0I7QUFDcEIsMkNBQStDO0FBQXRDLDZHQUFBLGVBQWUsT0FBQSIsInNvdXJjZXNDb250ZW50IjpbIi8qIGlzdGFuYnVsIGlnbm9yZSBmaWxlICovXG4vKipcbiAqIGNvbnRyYWN0LyDigJQgRmxvd0NoYXJ0IEkvTyBjb250cmFjdCBhbmQgT3BlbkFQSSBnZW5lcmF0aW9uIGxheWVyLlxuICpcbiAqIFN0YW5kYWxvbmUgbGlicmFyeTogd3JhcHMgYSBjb21waWxlZCBGbG93Q2hhcnQgd2l0aCBpbnB1dC9vdXRwdXQgc2NoZW1hc1xuICogYW5kIGdlbmVyYXRlcyBPcGVuQVBJIDMuMSBzcGVjcy4gVXNlcyB0aGUgc2FtZSBpbnB1dE1hcHBlci9vdXRwdXRNYXBwZXJcbiAqIHBhdHRlcm4gYXMgc3ViZmxvdyBtb3VudGluZy5cbiAqXG4gKiBaZXJvIHJ1bnRpbWUgZGVwcyBvbiBab2Qg4oCUIFpvZCBzY2hlbWFzIGRldGVjdGVkIHZpYSBkdWNrLXR5cGluZyBhbmRcbiAqIGNvbnZlcnRlZCB0byBKU09OIFNjaGVtYSBhdCBjb250cmFjdCBjcmVhdGlvbiB0aW1lLlxuICovXG5cbi8vIEZhY3RvcnlcbmV4cG9ydCB7IGRlZmluZUNvbnRyYWN0IH0gZnJvbSAnLi9kZWZpbmVDb250cmFjdC5qcyc7XG5cbi8vIFNjaGVtYSB1dGlsaXRpZXNcbmV4cG9ydCB7IG5vcm1hbGl6ZVNjaGVtYSwgem9kVG9Kc29uU2NoZW1hIH0gZnJvbSAnLi9zY2hlbWEuanMnO1xuXG4vLyBPcGVuQVBJIGdlbmVyYXRvclxuZXhwb3J0IHsgZ2VuZXJhdGVPcGVuQVBJIH0gZnJvbSAnLi9vcGVuYXBpLmpzJztcblxuLy8gVHlwZXNcbmV4cG9ydCB0eXBlIHtcbiAgRmxvd0NoYXJ0Q29udHJhY3QsXG4gIEZsb3dDaGFydENvbnRyYWN0T3B0aW9ucyxcbiAgSnNvblNjaGVtYSxcbiAgT3BlbkFQSU9wdGlvbnMsXG4gIE9wZW5BUElTcGVjLFxuICBTY2hlbWFJbnB1dCxcbn0gZnJvbSAnLi90eXBlcy5qcyc7XG4iXX0=