"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toScopeFactory = exports.registerScopeResolver = exports.resolveScopeProvider = exports.__clearScopeResolversForTests = exports.makeFactoryProvider = exports.makeClassProvider = exports.looksLikeFactory = exports.looksLikeClassCtor = exports.isSubclassOfScopeFacade = exports.attachScopeMethods = void 0;
/* istanbul ignore file */
var baseStateCompatible_js_1 = require("./baseStateCompatible.js");
Object.defineProperty(exports, "attachScopeMethods", { enumerable: true, get: function () { return baseStateCompatible_js_1.attachScopeMethods; } });
var guards_js_1 = require("./guards.js");
Object.defineProperty(exports, "isSubclassOfScopeFacade", { enumerable: true, get: function () { return guards_js_1.isSubclassOfScopeFacade; } });
Object.defineProperty(exports, "looksLikeClassCtor", { enumerable: true, get: function () { return guards_js_1.looksLikeClassCtor; } });
Object.defineProperty(exports, "looksLikeFactory", { enumerable: true, get: function () { return guards_js_1.looksLikeFactory; } });
var providers_js_1 = require("./providers.js");
Object.defineProperty(exports, "makeClassProvider", { enumerable: true, get: function () { return providers_js_1.makeClassProvider; } });
Object.defineProperty(exports, "makeFactoryProvider", { enumerable: true, get: function () { return providers_js_1.makeFactoryProvider; } });
var registry_js_1 = require("./registry.js");
Object.defineProperty(exports, "__clearScopeResolversForTests", { enumerable: true, get: function () { return registry_js_1.__clearScopeResolversForTests; } });
Object.defineProperty(exports, "resolveScopeProvider", { enumerable: true, get: function () { return registry_js_1.resolveScopeProvider; } });
var resolve_js_1 = require("./resolve.js");
Object.defineProperty(exports, "registerScopeResolver", { enumerable: true, get: function () { return resolve_js_1.registerScopeResolver; } });
Object.defineProperty(exports, "toScopeFactory", { enumerable: true, get: function () { return resolve_js_1.toScopeFactory; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL3Byb3ZpZGVycy9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSwwQkFBMEI7QUFDMUIsbUVBQThEO0FBQXJELDRIQUFBLGtCQUFrQixPQUFBO0FBQzNCLHlDQUE0RjtBQUFuRixvSEFBQSx1QkFBdUIsT0FBQTtBQUFFLCtHQUFBLGtCQUFrQixPQUFBO0FBQUUsNkdBQUEsZ0JBQWdCLE9BQUE7QUFDdEUsK0NBQXdFO0FBQS9ELGlIQUFBLGlCQUFpQixPQUFBO0FBQUUsbUhBQUEsbUJBQW1CLE9BQUE7QUFDL0MsNkNBQW9GO0FBQTNFLDRIQUFBLDZCQUE2QixPQUFBO0FBQUUsbUhBQUEsb0JBQW9CLE9BQUE7QUFDNUQsMkNBQXFFO0FBQTVELG1IQUFBLHFCQUFxQixPQUFBO0FBQUUsNEdBQUEsY0FBYyxPQUFBIiwic291cmNlc0NvbnRlbnQiOlsiLyogaXN0YW5idWwgaWdub3JlIGZpbGUgKi9cbmV4cG9ydCB7IGF0dGFjaFNjb3BlTWV0aG9kcyB9IGZyb20gJy4vYmFzZVN0YXRlQ29tcGF0aWJsZS5qcyc7XG5leHBvcnQgeyBpc1N1YmNsYXNzT2ZTY29wZUZhY2FkZSwgbG9va3NMaWtlQ2xhc3NDdG9yLCBsb29rc0xpa2VGYWN0b3J5IH0gZnJvbSAnLi9ndWFyZHMuanMnO1xuZXhwb3J0IHsgbWFrZUNsYXNzUHJvdmlkZXIsIG1ha2VGYWN0b3J5UHJvdmlkZXIgfSBmcm9tICcuL3Byb3ZpZGVycy5qcyc7XG5leHBvcnQgeyBfX2NsZWFyU2NvcGVSZXNvbHZlcnNGb3JUZXN0cywgcmVzb2x2ZVNjb3BlUHJvdmlkZXIgfSBmcm9tICcuL3JlZ2lzdHJ5LmpzJztcbmV4cG9ydCB7IHJlZ2lzdGVyU2NvcGVSZXNvbHZlciwgdG9TY29wZUZhY3RvcnkgfSBmcm9tICcuL3Jlc29sdmUuanMnO1xuZXhwb3J0IHR5cGUge1xuICBQcm92aWRlclJlc29sdmVyLFxuICBSZXNvbHZlT3B0aW9ucyxcbiAgU2NvcGVGYWN0b3J5LFxuICBTY29wZVByb3ZpZGVyLFxuICBTdGFnZUNvbnRleHRMaWtlLFxuICBTdHJpY3RNb2RlLFxufSBmcm9tICcuL3R5cGVzLmpzJztcbiJdfQ==