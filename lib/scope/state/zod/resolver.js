"use strict";
/**
 * ZodScopeResolver — ProviderResolver for Zod-branded scope schemas
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ZodScopeResolver = void 0;
const baseStateCompatible_js_1 = require("../../providers/baseStateCompatible.js");
const builder_js_1 = require("./schema/builder.js");
const scopeFactory_js_1 = require("./scopeFactory.js");
function makeZodProvider(schema, strict = 'warn') {
    return {
        kind: 'zod',
        create: (ctx, stageName, ro) => {
            const proxy = (0, scopeFactory_js_1.createScopeProxyFromZod)(ctx, schema, strict, ro);
            return (0, baseStateCompatible_js_1.attachScopeMethods)(proxy, ctx, stageName, ro);
        },
    };
}
exports.ZodScopeResolver = {
    name: 'zod',
    canHandle(input) {
        return (0, builder_js_1.isScopeSchema)(input);
    },
    makeProvider(input, options) {
        var _a, _b;
        const schema = input;
        const strict = (_b = (_a = options === null || options === void 0 ? void 0 : options.zod) === null || _a === void 0 ? void 0 : _a.strict) !== null && _b !== void 0 ? _b : 'warn';
        return makeZodProvider(schema, strict);
    },
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVzb2x2ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL3N0YXRlL3pvZC9yZXNvbHZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7O0dBRUc7OztBQUlILG1GQUE0RTtBQUU1RSxvREFBb0Q7QUFDcEQsdURBQTREO0FBRTVELFNBQVMsZUFBZSxDQUFDLE1BQXdCLEVBQUUsU0FBcUIsTUFBTTtJQUM1RSxPQUFPO1FBQ0wsSUFBSSxFQUFFLEtBQUs7UUFDWCxNQUFNLEVBQUUsQ0FBQyxHQUFxQixFQUFFLFNBQWlCLEVBQUUsRUFBWSxFQUFFLEVBQUU7WUFDakUsTUFBTSxLQUFLLEdBQUcsSUFBQSx5Q0FBdUIsRUFBQyxHQUFHLEVBQUUsTUFBTSxFQUFFLE1BQU0sRUFBRSxFQUFFLENBQUMsQ0FBQztZQUMvRCxPQUFPLElBQUEsMkNBQWtCLEVBQUMsS0FBSyxFQUFFLEdBQUcsRUFBRSxTQUFTLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDdkQsQ0FBQztLQUNGLENBQUM7QUFDSixDQUFDO0FBRVksUUFBQSxnQkFBZ0IsR0FBcUI7SUFDaEQsSUFBSSxFQUFFLEtBQUs7SUFDWCxTQUFTLENBQUMsS0FBYztRQUN0QixPQUFPLElBQUEsMEJBQWEsRUFBQyxLQUFLLENBQUMsQ0FBQztJQUM5QixDQUFDO0lBQ0QsWUFBWSxDQUFDLEtBQWMsRUFBRSxPQUEyQzs7UUFDdEUsTUFBTSxNQUFNLEdBQUcsS0FBb0MsQ0FBQztRQUNwRCxNQUFNLE1BQU0sR0FBRyxNQUFBLE1BQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLEdBQUcsMENBQUUsTUFBTSxtQ0FBSSxNQUFNLENBQUM7UUFDOUMsT0FBTyxlQUFlLENBQUMsTUFBTSxFQUFFLE1BQU0sQ0FBQyxDQUFDO0lBQ3pDLENBQUM7Q0FDRixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBab2RTY29wZVJlc29sdmVyIOKAlCBQcm92aWRlclJlc29sdmVyIGZvciBab2QtYnJhbmRlZCBzY29wZSBzY2hlbWFzXG4gKi9cblxuaW1wb3J0IHsgeiB9IGZyb20gJ3pvZCc7XG5cbmltcG9ydCB7IGF0dGFjaFNjb3BlTWV0aG9kcyB9IGZyb20gJy4uLy4uL3Byb3ZpZGVycy9iYXNlU3RhdGVDb21wYXRpYmxlLmpzJztcbmltcG9ydCB0eXBlIHsgUHJvdmlkZXJSZXNvbHZlciwgU2NvcGVQcm92aWRlciwgU3RhZ2VDb250ZXh0TGlrZSwgU3RyaWN0TW9kZSB9IGZyb20gJy4uLy4uL3Byb3ZpZGVycy90eXBlcy5qcyc7XG5pbXBvcnQgeyBpc1Njb3BlU2NoZW1hIH0gZnJvbSAnLi9zY2hlbWEvYnVpbGRlci5qcyc7XG5pbXBvcnQgeyBjcmVhdGVTY29wZVByb3h5RnJvbVpvZCB9IGZyb20gJy4vc2NvcGVGYWN0b3J5LmpzJztcblxuZnVuY3Rpb24gbWFrZVpvZFByb3ZpZGVyKHNjaGVtYTogei5ab2RPYmplY3Q8YW55Piwgc3RyaWN0OiBTdHJpY3RNb2RlID0gJ3dhcm4nKTogU2NvcGVQcm92aWRlcjxhbnk+IHtcbiAgcmV0dXJuIHtcbiAgICBraW5kOiAnem9kJyxcbiAgICBjcmVhdGU6IChjdHg6IFN0YWdlQ29udGV4dExpa2UsIHN0YWdlTmFtZTogc3RyaW5nLCBybz86IHVua25vd24pID0+IHtcbiAgICAgIGNvbnN0IHByb3h5ID0gY3JlYXRlU2NvcGVQcm94eUZyb21ab2QoY3R4LCBzY2hlbWEsIHN0cmljdCwgcm8pO1xuICAgICAgcmV0dXJuIGF0dGFjaFNjb3BlTWV0aG9kcyhwcm94eSwgY3R4LCBzdGFnZU5hbWUsIHJvKTtcbiAgICB9LFxuICB9O1xufVxuXG5leHBvcnQgY29uc3QgWm9kU2NvcGVSZXNvbHZlcjogUHJvdmlkZXJSZXNvbHZlciA9IHtcbiAgbmFtZTogJ3pvZCcsXG4gIGNhbkhhbmRsZShpbnB1dDogdW5rbm93bik6IGJvb2xlYW4ge1xuICAgIHJldHVybiBpc1Njb3BlU2NoZW1hKGlucHV0KTtcbiAgfSxcbiAgbWFrZVByb3ZpZGVyKGlucHV0OiB1bmtub3duLCBvcHRpb25zPzogeyB6b2Q/OiB7IHN0cmljdD86IFN0cmljdE1vZGUgfSB9KTogU2NvcGVQcm92aWRlcjxhbnk+IHtcbiAgICBjb25zdCBzY2hlbWEgPSBpbnB1dCBhcyB1bmtub3duIGFzIHouWm9kT2JqZWN0PGFueT47XG4gICAgY29uc3Qgc3RyaWN0ID0gb3B0aW9ucz8uem9kPy5zdHJpY3QgPz8gJ3dhcm4nO1xuICAgIHJldHVybiBtYWtlWm9kUHJvdmlkZXIoc2NoZW1hLCBzdHJpY3QpO1xuICB9LFxufTtcbiJdfQ==