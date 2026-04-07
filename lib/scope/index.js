"use strict";
/* istanbul ignore file */
/**
 * scope/ — Scope management library
 *
 * Depends on memory/ (Phase 1). Provides ScopeFacade, recorders,
 * providers, protection, and Zod-based scope definitions.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createScopeProxyFromZod = exports.isScopeSchema = exports.defineScopeSchema = exports.ZodScopeResolver = exports.defineScopeFromZod = exports.toScopeFactory = exports.resolveScopeProvider = exports.registerScopeResolver = exports.makeFactoryProvider = exports.makeClassProvider = exports.looksLikeFactory = exports.looksLikeClassCtor = exports.isSubclassOfScopeFacade = exports.attachScopeMethods = exports.__clearScopeResolversForTests = exports.createProtectedScope = exports.createErrorMessage = exports.MetricRecorder = exports.DebugRecorder = exports.ScopeFacade = void 0;
// Core
var ScopeFacade_js_1 = require("./ScopeFacade.js");
Object.defineProperty(exports, "ScopeFacade", { enumerable: true, get: function () { return ScopeFacade_js_1.ScopeFacade; } });
var DebugRecorder_js_1 = require("./recorders/DebugRecorder.js");
Object.defineProperty(exports, "DebugRecorder", { enumerable: true, get: function () { return DebugRecorder_js_1.DebugRecorder; } });
var MetricRecorder_js_1 = require("./recorders/MetricRecorder.js");
Object.defineProperty(exports, "MetricRecorder", { enumerable: true, get: function () { return MetricRecorder_js_1.MetricRecorder; } });
var index_js_1 = require("./protection/index.js");
Object.defineProperty(exports, "createErrorMessage", { enumerable: true, get: function () { return index_js_1.createErrorMessage; } });
Object.defineProperty(exports, "createProtectedScope", { enumerable: true, get: function () { return index_js_1.createProtectedScope; } });
var index_js_2 = require("./providers/index.js");
Object.defineProperty(exports, "__clearScopeResolversForTests", { enumerable: true, get: function () { return index_js_2.__clearScopeResolversForTests; } });
Object.defineProperty(exports, "attachScopeMethods", { enumerable: true, get: function () { return index_js_2.attachScopeMethods; } });
Object.defineProperty(exports, "isSubclassOfScopeFacade", { enumerable: true, get: function () { return index_js_2.isSubclassOfScopeFacade; } });
Object.defineProperty(exports, "looksLikeClassCtor", { enumerable: true, get: function () { return index_js_2.looksLikeClassCtor; } });
Object.defineProperty(exports, "looksLikeFactory", { enumerable: true, get: function () { return index_js_2.looksLikeFactory; } });
Object.defineProperty(exports, "makeClassProvider", { enumerable: true, get: function () { return index_js_2.makeClassProvider; } });
Object.defineProperty(exports, "makeFactoryProvider", { enumerable: true, get: function () { return index_js_2.makeFactoryProvider; } });
Object.defineProperty(exports, "registerScopeResolver", { enumerable: true, get: function () { return index_js_2.registerScopeResolver; } });
Object.defineProperty(exports, "resolveScopeProvider", { enumerable: true, get: function () { return index_js_2.resolveScopeProvider; } });
Object.defineProperty(exports, "toScopeFactory", { enumerable: true, get: function () { return index_js_2.toScopeFactory; } });
var defineScopeFromZod_js_1 = require("./state/zod/defineScopeFromZod.js");
Object.defineProperty(exports, "defineScopeFromZod", { enumerable: true, get: function () { return defineScopeFromZod_js_1.defineScopeFromZod; } });
var resolver_js_1 = require("./state/zod/resolver.js");
Object.defineProperty(exports, "ZodScopeResolver", { enumerable: true, get: function () { return resolver_js_1.ZodScopeResolver; } });
var builder_js_1 = require("./state/zod/schema/builder.js");
Object.defineProperty(exports, "defineScopeSchema", { enumerable: true, get: function () { return builder_js_1.defineScopeSchema; } });
Object.defineProperty(exports, "isScopeSchema", { enumerable: true, get: function () { return builder_js_1.isScopeSchema; } });
var scopeFactory_js_1 = require("./state/zod/scopeFactory.js");
Object.defineProperty(exports, "createScopeProxyFromZod", { enumerable: true, get: function () { return scopeFactory_js_1.createScopeProxyFromZod; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL3Njb3BlL2luZGV4LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQSwwQkFBMEI7QUFDMUI7Ozs7O0dBS0c7OztBQUVILE9BQU87QUFDUCxtREFBK0M7QUFBdEMsNkdBQUEsV0FBVyxPQUFBO0FBaUJwQixpRUFBNkQ7QUFBcEQsaUhBQUEsYUFBYSxPQUFBO0FBRXRCLG1FQUErRDtBQUF0RCxtSEFBQSxjQUFjLE9BQUE7QUFJdkIsa0RBQWlGO0FBQXhFLDhHQUFBLGtCQUFrQixPQUFBO0FBQUUsZ0hBQUEsb0JBQW9CLE9BQUE7QUFXakQsaURBVzhCO0FBVjVCLHlIQUFBLDZCQUE2QixPQUFBO0FBQzdCLDhHQUFBLGtCQUFrQixPQUFBO0FBQ2xCLG1IQUFBLHVCQUF1QixPQUFBO0FBQ3ZCLDhHQUFBLGtCQUFrQixPQUFBO0FBQ2xCLDRHQUFBLGdCQUFnQixPQUFBO0FBQ2hCLDZHQUFBLGlCQUFpQixPQUFBO0FBQ2pCLCtHQUFBLG1CQUFtQixPQUFBO0FBQ25CLGlIQUFBLHFCQUFxQixPQUFBO0FBQ3JCLGdIQUFBLG9CQUFvQixPQUFBO0FBQ3BCLDBHQUFBLGNBQWMsT0FBQTtBQUtoQiwyRUFBdUU7QUFBOUQsMkhBQUEsa0JBQWtCLE9BQUE7QUFDM0IsdURBQTJEO0FBQWxELCtHQUFBLGdCQUFnQixPQUFBO0FBQ3pCLDREQUFpRjtBQUF4RSwrR0FBQSxpQkFBaUIsT0FBQTtBQUFFLDJHQUFBLGFBQWEsT0FBQTtBQUN6QywrREFBc0U7QUFBN0QsMEhBQUEsdUJBQXVCLE9BQUEiLCJzb3VyY2VzQ29udGVudCI6WyIvKiBpc3RhbmJ1bCBpZ25vcmUgZmlsZSAqL1xuLyoqXG4gKiBzY29wZS8g4oCUIFNjb3BlIG1hbmFnZW1lbnQgbGlicmFyeVxuICpcbiAqIERlcGVuZHMgb24gbWVtb3J5LyAoUGhhc2UgMSkuIFByb3ZpZGVzIFNjb3BlRmFjYWRlLCByZWNvcmRlcnMsXG4gKiBwcm92aWRlcnMsIHByb3RlY3Rpb24sIGFuZCBab2QtYmFzZWQgc2NvcGUgZGVmaW5pdGlvbnMuXG4gKi9cblxuLy8gQ29yZVxuZXhwb3J0IHsgU2NvcGVGYWNhZGUgfSBmcm9tICcuL1Njb3BlRmFjYWRlLmpzJztcblxuLy8gVHlwZXNcbmV4cG9ydCB0eXBlIHtcbiAgQ29tbWl0RXZlbnQsXG4gIEVycm9yRXZlbnQsXG4gIFJlYWRFdmVudCxcbiAgUmVjb3JkZXIsXG4gIFJlY29yZGVyQ29udGV4dCxcbiAgUmVkYWN0aW9uUG9saWN5LFxuICBSZWRhY3Rpb25SZXBvcnQsXG4gIFN0YWdlRXZlbnQsXG4gIFdyaXRlRXZlbnQsXG59IGZyb20gJy4vdHlwZXMuanMnO1xuXG4vLyBSZWNvcmRlcnNcbmV4cG9ydCB0eXBlIHsgRGVidWdFbnRyeSwgRGVidWdSZWNvcmRlck9wdGlvbnMsIERlYnVnVmVyYm9zaXR5IH0gZnJvbSAnLi9yZWNvcmRlcnMvRGVidWdSZWNvcmRlci5qcyc7XG5leHBvcnQgeyBEZWJ1Z1JlY29yZGVyIH0gZnJvbSAnLi9yZWNvcmRlcnMvRGVidWdSZWNvcmRlci5qcyc7XG5leHBvcnQgdHlwZSB7IEFnZ3JlZ2F0ZWRNZXRyaWNzLCBTdGFnZU1ldHJpY3MgfSBmcm9tICcuL3JlY29yZGVycy9NZXRyaWNSZWNvcmRlci5qcyc7XG5leHBvcnQgeyBNZXRyaWNSZWNvcmRlciB9IGZyb20gJy4vcmVjb3JkZXJzL01ldHJpY1JlY29yZGVyLmpzJztcblxuLy8gUHJvdGVjdGlvblxuZXhwb3J0IHR5cGUgeyBTY29wZVByb3RlY3Rpb25Nb2RlLCBTY29wZVByb3RlY3Rpb25PcHRpb25zIH0gZnJvbSAnLi9wcm90ZWN0aW9uL2luZGV4LmpzJztcbmV4cG9ydCB7IGNyZWF0ZUVycm9yTWVzc2FnZSwgY3JlYXRlUHJvdGVjdGVkU2NvcGUgfSBmcm9tICcuL3Byb3RlY3Rpb24vaW5kZXguanMnO1xuXG4vLyBQcm92aWRlcnNcbmV4cG9ydCB0eXBlIHtcbiAgUHJvdmlkZXJSZXNvbHZlcixcbiAgUmVzb2x2ZU9wdGlvbnMsXG4gIFNjb3BlRmFjdG9yeSxcbiAgU2NvcGVQcm92aWRlcixcbiAgU3RhZ2VDb250ZXh0TGlrZSxcbiAgU3RyaWN0TW9kZSxcbn0gZnJvbSAnLi9wcm92aWRlcnMvaW5kZXguanMnO1xuZXhwb3J0IHtcbiAgX19jbGVhclNjb3BlUmVzb2x2ZXJzRm9yVGVzdHMsXG4gIGF0dGFjaFNjb3BlTWV0aG9kcyxcbiAgaXNTdWJjbGFzc09mU2NvcGVGYWNhZGUsXG4gIGxvb2tzTGlrZUNsYXNzQ3RvcixcbiAgbG9va3NMaWtlRmFjdG9yeSxcbiAgbWFrZUNsYXNzUHJvdmlkZXIsXG4gIG1ha2VGYWN0b3J5UHJvdmlkZXIsXG4gIHJlZ2lzdGVyU2NvcGVSZXNvbHZlcixcbiAgcmVzb2x2ZVNjb3BlUHJvdmlkZXIsXG4gIHRvU2NvcGVGYWN0b3J5LFxufSBmcm9tICcuL3Byb3ZpZGVycy9pbmRleC5qcyc7XG5cbi8vIFN0YXRlIC8gWm9kXG5leHBvcnQgdHlwZSB7IERlZmluZVNjb3BlT3B0aW9ucyB9IGZyb20gJy4vc3RhdGUvem9kL2RlZmluZVNjb3BlRnJvbVpvZC5qcyc7XG5leHBvcnQgeyBkZWZpbmVTY29wZUZyb21ab2QgfSBmcm9tICcuL3N0YXRlL3pvZC9kZWZpbmVTY29wZUZyb21ab2QuanMnO1xuZXhwb3J0IHsgWm9kU2NvcGVSZXNvbHZlciB9IGZyb20gJy4vc3RhdGUvem9kL3Jlc29sdmVyLmpzJztcbmV4cG9ydCB7IGRlZmluZVNjb3BlU2NoZW1hLCBpc1Njb3BlU2NoZW1hIH0gZnJvbSAnLi9zdGF0ZS96b2Qvc2NoZW1hL2J1aWxkZXIuanMnO1xuZXhwb3J0IHsgY3JlYXRlU2NvcGVQcm94eUZyb21ab2QgfSBmcm9tICcuL3N0YXRlL3pvZC9zY29wZUZhY3RvcnkuanMnO1xuIl19