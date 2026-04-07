"use strict";
/**
 * reactive/ -- Deep Proxy system for TypedScope<T>.
 *
 * Provides typed property access to footprintjs scope state:
 *   scope.creditTier = 'A'  instead of  scope.setValue('creditTier', 'A')
 *   scope.customer.address.zip = '90210'  instead of  scope.updateValue(...)
 *   scope.tags.push('vip')  instead of  scope.setValue('tags', [...tags, 'vip'])
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.joinPath = exports.buildNestedPatch = exports.createArrayProxy = exports.shouldWrapWithProxy = exports.createTypedScope = exports.SCOPE_METHOD_NAMES = exports.IS_TYPED_SCOPE = exports.EXECUTOR_INTERNAL_METHODS = exports.BREAK_SETTER = void 0;
// Runtime constants
var types_js_1 = require("./types.js");
Object.defineProperty(exports, "BREAK_SETTER", { enumerable: true, get: function () { return types_js_1.BREAK_SETTER; } });
Object.defineProperty(exports, "EXECUTOR_INTERNAL_METHODS", { enumerable: true, get: function () { return types_js_1.EXECUTOR_INTERNAL_METHODS; } });
Object.defineProperty(exports, "IS_TYPED_SCOPE", { enumerable: true, get: function () { return types_js_1.IS_TYPED_SCOPE; } });
Object.defineProperty(exports, "SCOPE_METHOD_NAMES", { enumerable: true, get: function () { return types_js_1.SCOPE_METHOD_NAMES; } });
// Core factory
var createTypedScope_js_1 = require("./createTypedScope.js");
Object.defineProperty(exports, "createTypedScope", { enumerable: true, get: function () { return createTypedScope_js_1.createTypedScope; } });
// Utilities
var allowlist_js_1 = require("./allowlist.js");
Object.defineProperty(exports, "shouldWrapWithProxy", { enumerable: true, get: function () { return allowlist_js_1.shouldWrapWithProxy; } });
var arrayTraps_js_1 = require("./arrayTraps.js");
Object.defineProperty(exports, "createArrayProxy", { enumerable: true, get: function () { return arrayTraps_js_1.createArrayProxy; } });
var pathBuilder_js_1 = require("./pathBuilder.js");
Object.defineProperty(exports, "buildNestedPatch", { enumerable: true, get: function () { return pathBuilder_js_1.buildNestedPatch; } });
Object.defineProperty(exports, "joinPath", { enumerable: true, get: function () { return pathBuilder_js_1.joinPath; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL3JlYWN0aXZlL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7OztHQU9HOzs7QUFLSCxvQkFBb0I7QUFDcEIsdUNBQXlHO0FBQWhHLHdHQUFBLFlBQVksT0FBQTtBQUFFLHFIQUFBLHlCQUF5QixPQUFBO0FBQUUsMEdBQUEsY0FBYyxPQUFBO0FBQUUsOEdBQUEsa0JBQWtCLE9BQUE7QUFFcEYsZUFBZTtBQUNmLDZEQUF5RDtBQUFoRCx1SEFBQSxnQkFBZ0IsT0FBQTtBQUV6QixZQUFZO0FBQ1osK0NBQXFEO0FBQTVDLG1IQUFBLG1CQUFtQixPQUFBO0FBQzVCLGlEQUFtRDtBQUExQyxpSEFBQSxnQkFBZ0IsT0FBQTtBQUN6QixtREFBOEQ7QUFBckQsa0hBQUEsZ0JBQWdCLE9BQUE7QUFBRSwwR0FBQSxRQUFRLE9BQUEiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHJlYWN0aXZlLyAtLSBEZWVwIFByb3h5IHN5c3RlbSBmb3IgVHlwZWRTY29wZTxUPi5cbiAqXG4gKiBQcm92aWRlcyB0eXBlZCBwcm9wZXJ0eSBhY2Nlc3MgdG8gZm9vdHByaW50anMgc2NvcGUgc3RhdGU6XG4gKiAgIHNjb3BlLmNyZWRpdFRpZXIgPSAnQScgIGluc3RlYWQgb2YgIHNjb3BlLnNldFZhbHVlKCdjcmVkaXRUaWVyJywgJ0EnKVxuICogICBzY29wZS5jdXN0b21lci5hZGRyZXNzLnppcCA9ICc5MDIxMCcgIGluc3RlYWQgb2YgIHNjb3BlLnVwZGF0ZVZhbHVlKC4uLilcbiAqICAgc2NvcGUudGFncy5wdXNoKCd2aXAnKSAgaW5zdGVhZCBvZiAgc2NvcGUuc2V0VmFsdWUoJ3RhZ3MnLCBbLi4udGFncywgJ3ZpcCddKVxuICovXG5cbi8vIFR5cGVzXG5leHBvcnQgdHlwZSB7IFJlYWN0aXZlT3B0aW9ucywgUmVhY3RpdmVUYXJnZXQsIFNjb3BlTWV0aG9kcywgVHlwZWRTY29wZSB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyBSdW50aW1lIGNvbnN0YW50c1xuZXhwb3J0IHsgQlJFQUtfU0VUVEVSLCBFWEVDVVRPUl9JTlRFUk5BTF9NRVRIT0RTLCBJU19UWVBFRF9TQ09QRSwgU0NPUEVfTUVUSE9EX05BTUVTIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8vIENvcmUgZmFjdG9yeVxuZXhwb3J0IHsgY3JlYXRlVHlwZWRTY29wZSB9IGZyb20gJy4vY3JlYXRlVHlwZWRTY29wZS5qcyc7XG5cbi8vIFV0aWxpdGllc1xuZXhwb3J0IHsgc2hvdWxkV3JhcFdpdGhQcm94eSB9IGZyb20gJy4vYWxsb3dsaXN0LmpzJztcbmV4cG9ydCB7IGNyZWF0ZUFycmF5UHJveHkgfSBmcm9tICcuL2FycmF5VHJhcHMuanMnO1xuZXhwb3J0IHsgYnVpbGROZXN0ZWRQYXRjaCwgam9pblBhdGggfSBmcm9tICcuL3BhdGhCdWlsZGVyLmpzJztcbiJdfQ==