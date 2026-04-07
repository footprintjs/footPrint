"use strict";
/**
 * schema/ — Unified schema detection and validation library.
 *
 * Single source of truth for:
 * - Detecting schema kind (Zod, parseable, JSON Schema)
 * - Validating data against any schema
 * - Structured validation errors with field-level details
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateOrThrow = exports.validateAgainstSchema = exports.InputValidationError = exports.extractIssuesFromZodError = exports.isZod = exports.isValidatable = exports.detectSchema = void 0;
var detect_js_1 = require("./detect.js");
Object.defineProperty(exports, "detectSchema", { enumerable: true, get: function () { return detect_js_1.detectSchema; } });
Object.defineProperty(exports, "isValidatable", { enumerable: true, get: function () { return detect_js_1.isValidatable; } });
Object.defineProperty(exports, "isZod", { enumerable: true, get: function () { return detect_js_1.isZod; } });
var errors_js_1 = require("./errors.js");
Object.defineProperty(exports, "extractIssuesFromZodError", { enumerable: true, get: function () { return errors_js_1.extractIssuesFromZodError; } });
Object.defineProperty(exports, "InputValidationError", { enumerable: true, get: function () { return errors_js_1.InputValidationError; } });
var validate_js_1 = require("./validate.js");
Object.defineProperty(exports, "validateAgainstSchema", { enumerable: true, get: function () { return validate_js_1.validateAgainstSchema; } });
Object.defineProperty(exports, "validateOrThrow", { enumerable: true, get: function () { return validate_js_1.validateOrThrow; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL3NjaGVtYS9pbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7R0FPRzs7O0FBR0gseUNBQWlFO0FBQXhELHlHQUFBLFlBQVksT0FBQTtBQUFFLDBHQUFBLGFBQWEsT0FBQTtBQUFFLGtHQUFBLEtBQUssT0FBQTtBQUUzQyx5Q0FBOEU7QUFBckUsc0hBQUEseUJBQXlCLE9BQUE7QUFBRSxpSEFBQSxvQkFBb0IsT0FBQTtBQUV4RCw2Q0FBdUU7QUFBOUQsb0hBQUEscUJBQXFCLE9BQUE7QUFBRSw4R0FBQSxlQUFlLE9BQUEiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHNjaGVtYS8g4oCUIFVuaWZpZWQgc2NoZW1hIGRldGVjdGlvbiBhbmQgdmFsaWRhdGlvbiBsaWJyYXJ5LlxuICpcbiAqIFNpbmdsZSBzb3VyY2Ugb2YgdHJ1dGggZm9yOlxuICogLSBEZXRlY3Rpbmcgc2NoZW1hIGtpbmQgKFpvZCwgcGFyc2VhYmxlLCBKU09OIFNjaGVtYSlcbiAqIC0gVmFsaWRhdGluZyBkYXRhIGFnYWluc3QgYW55IHNjaGVtYVxuICogLSBTdHJ1Y3R1cmVkIHZhbGlkYXRpb24gZXJyb3JzIHdpdGggZmllbGQtbGV2ZWwgZGV0YWlsc1xuICovXG5cbmV4cG9ydCB0eXBlIHsgU2NoZW1hS2luZCB9IGZyb20gJy4vZGV0ZWN0LmpzJztcbmV4cG9ydCB7IGRldGVjdFNjaGVtYSwgaXNWYWxpZGF0YWJsZSwgaXNab2QgfSBmcm9tICcuL2RldGVjdC5qcyc7XG5leHBvcnQgdHlwZSB7IFZhbGlkYXRpb25Jc3N1ZSB9IGZyb20gJy4vZXJyb3JzLmpzJztcbmV4cG9ydCB7IGV4dHJhY3RJc3N1ZXNGcm9tWm9kRXJyb3IsIElucHV0VmFsaWRhdGlvbkVycm9yIH0gZnJvbSAnLi9lcnJvcnMuanMnO1xuZXhwb3J0IHR5cGUgeyBWYWxpZGF0aW9uRmFpbHVyZSwgVmFsaWRhdGlvblJlc3VsdCwgVmFsaWRhdGlvblN1Y2Nlc3MgfSBmcm9tICcuL3ZhbGlkYXRlLmpzJztcbmV4cG9ydCB7IHZhbGlkYXRlQWdhaW5zdFNjaGVtYSwgdmFsaWRhdGVPclRocm93IH0gZnJvbSAnLi92YWxpZGF0ZS5qcyc7XG4iXX0=