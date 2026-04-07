"use strict";
/**
 * contract/defineContract.ts — Factory for creating a FlowChartContract.
 *
 * Wraps a compiled FlowChart with I/O schemas and an output mapper,
 * using the same pattern as SubflowMountOptions (inputMapper/outputMapper).
 *
 * Usage:
 *   const contract = defineContract(chart, {
 *     inputSchema: z.object({ name: z.string() }),
 *     outputSchema: z.object({ greeting: z.string() }),
 *     outputMapper: (scope) => ({ greeting: scope.message as string }),
 *   });
 *
 *   const openapi = contract.toOpenAPI();
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineContract = void 0;
const openapi_js_1 = require("./openapi.js");
const schema_js_1 = require("./schema.js");
function defineContract(chart, options) {
    const inputSchema = options.inputSchema ? (0, schema_js_1.normalizeSchema)(options.inputSchema) : undefined;
    const outputSchema = options.outputSchema ? (0, schema_js_1.normalizeSchema)(options.outputSchema) : undefined;
    // Build a lightweight chart view for the contract.
    //
    // We must NOT mutate the original `chart` object because charts are compiled
    // artifacts meant to be shared across multiple concurrent executors. Mutating
    // any schema field after build would be visible to all holders of that chart
    // reference, causing cross-contract contamination.
    //
    // Instead, use Object.create(chart) to create a prototype-linked view:
    //   - All properties (root, stageMap, subflows, methods…) are inherited via
    //     the prototype chain — zero extra copying.
    //   - Setting schema fields on the view creates OWN properties that shadow
    //     the prototype's value, leaving the original chart untouched.
    //   - FlowChartExecutor reads chartView.inputSchema which resolves to the
    //     own-property (contract schema) before the prototype (builder schema).
    //   - RunContext reads chartView.outputMapper to apply the output transform —
    //     that must also be shadowed here so the contract's mapper wins.
    //
    // Limitation: Object.keys(chartView) returns only own properties (the schema
    // fields that were shadowed). Do NOT use Object.keys(), spread ({...chartView}),
    // or JSON.stringify(chartView) on this view — use named property access or
    // chart.toSpec() instead.
    const chartView = Object.create(chart);
    const view = chartView;
    if (options.inputSchema) {
        view.inputSchema = options.inputSchema;
    }
    if (options.outputSchema) {
        view.outputSchema = options.outputSchema;
    }
    if (options.outputMapper) {
        view.outputMapper = options.outputMapper;
    }
    const contract = {
        chart: chartView,
        inputSchema,
        outputSchema,
        outputMapper: options.outputMapper,
        toOpenAPI(apiOptions) {
            return (0, openapi_js_1.generateOpenAPI)(contract, apiOptions);
        },
    };
    return contract;
}
exports.defineContract = defineContract;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZGVmaW5lQ29udHJhY3QuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL2NvbnRyYWN0L2RlZmluZUNvbnRyYWN0LnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7R0FjRzs7O0FBR0gsNkNBQStDO0FBQy9DLDJDQUE4QztBQUc5QyxTQUFnQixjQUFjLENBQzVCLEtBQWdCLEVBQ2hCLE9BQWtEO0lBRWxELE1BQU0sV0FBVyxHQUFHLE9BQU8sQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLElBQUEsMkJBQWUsRUFBQyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztJQUMzRixNQUFNLFlBQVksR0FBRyxPQUFPLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxJQUFBLDJCQUFlLEVBQUMsT0FBTyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7SUFFOUYsbURBQW1EO0lBQ25ELEVBQUU7SUFDRiw2RUFBNkU7SUFDN0UsOEVBQThFO0lBQzlFLDZFQUE2RTtJQUM3RSxtREFBbUQ7SUFDbkQsRUFBRTtJQUNGLHVFQUF1RTtJQUN2RSw0RUFBNEU7SUFDNUUsZ0RBQWdEO0lBQ2hELDJFQUEyRTtJQUMzRSxtRUFBbUU7SUFDbkUsMEVBQTBFO0lBQzFFLDRFQUE0RTtJQUM1RSw4RUFBOEU7SUFDOUUscUVBQXFFO0lBQ3JFLEVBQUU7SUFDRiw2RUFBNkU7SUFDN0UsaUZBQWlGO0lBQ2pGLDJFQUEyRTtJQUMzRSwwQkFBMEI7SUFDMUIsTUFBTSxTQUFTLEdBQUcsTUFBTSxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQWMsQ0FBQztJQUNwRCxNQUFNLElBQUksR0FBRyxTQUErQixDQUFDO0lBQzdDLElBQUksT0FBTyxDQUFDLFdBQVcsRUFBRSxDQUFDO1FBQ3hCLElBQUksQ0FBQyxXQUFXLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQztJQUN6QyxDQUFDO0lBQ0QsSUFBSSxPQUFPLENBQUMsWUFBWSxFQUFFLENBQUM7UUFDekIsSUFBSSxDQUFDLFlBQVksR0FBRyxPQUFPLENBQUMsWUFBWSxDQUFDO0lBQzNDLENBQUM7SUFDRCxJQUFJLE9BQU8sQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUN6QixJQUFJLENBQUMsWUFBWSxHQUFHLE9BQU8sQ0FBQyxZQUFxRSxDQUFDO0lBQ3BHLENBQUM7SUFFRCxNQUFNLFFBQVEsR0FBdUM7UUFDbkQsS0FBSyxFQUFFLFNBQVM7UUFDaEIsV0FBVztRQUNYLFlBQVk7UUFDWixZQUFZLEVBQUUsT0FBTyxDQUFDLFlBQVk7UUFDbEMsU0FBUyxDQUFDLFVBQTJCO1lBQ25DLE9BQU8sSUFBQSw0QkFBZSxFQUFDLFFBQVEsRUFBRSxVQUFVLENBQUMsQ0FBQztRQUMvQyxDQUFDO0tBQ0YsQ0FBQztJQUVGLE9BQU8sUUFBUSxDQUFDO0FBQ2xCLENBQUM7QUFuREQsd0NBbURDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBjb250cmFjdC9kZWZpbmVDb250cmFjdC50cyDigJQgRmFjdG9yeSBmb3IgY3JlYXRpbmcgYSBGbG93Q2hhcnRDb250cmFjdC5cbiAqXG4gKiBXcmFwcyBhIGNvbXBpbGVkIEZsb3dDaGFydCB3aXRoIEkvTyBzY2hlbWFzIGFuZCBhbiBvdXRwdXQgbWFwcGVyLFxuICogdXNpbmcgdGhlIHNhbWUgcGF0dGVybiBhcyBTdWJmbG93TW91bnRPcHRpb25zIChpbnB1dE1hcHBlci9vdXRwdXRNYXBwZXIpLlxuICpcbiAqIFVzYWdlOlxuICogICBjb25zdCBjb250cmFjdCA9IGRlZmluZUNvbnRyYWN0KGNoYXJ0LCB7XG4gKiAgICAgaW5wdXRTY2hlbWE6IHoub2JqZWN0KHsgbmFtZTogei5zdHJpbmcoKSB9KSxcbiAqICAgICBvdXRwdXRTY2hlbWE6IHoub2JqZWN0KHsgZ3JlZXRpbmc6IHouc3RyaW5nKCkgfSksXG4gKiAgICAgb3V0cHV0TWFwcGVyOiAoc2NvcGUpID0+ICh7IGdyZWV0aW5nOiBzY29wZS5tZXNzYWdlIGFzIHN0cmluZyB9KSxcbiAqICAgfSk7XG4gKlxuICogICBjb25zdCBvcGVuYXBpID0gY29udHJhY3QudG9PcGVuQVBJKCk7XG4gKi9cblxuaW1wb3J0IHR5cGUgeyBGbG93Q2hhcnQgfSBmcm9tICcuLi9idWlsZGVyL3R5cGVzLmpzJztcbmltcG9ydCB7IGdlbmVyYXRlT3BlbkFQSSB9IGZyb20gJy4vb3BlbmFwaS5qcyc7XG5pbXBvcnQgeyBub3JtYWxpemVTY2hlbWEgfSBmcm9tICcuL3NjaGVtYS5qcyc7XG5pbXBvcnQgdHlwZSB7IEZsb3dDaGFydENvbnRyYWN0LCBGbG93Q2hhcnRDb250cmFjdE9wdGlvbnMsIE9wZW5BUElPcHRpb25zLCBPcGVuQVBJU3BlYyB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5leHBvcnQgZnVuY3Rpb24gZGVmaW5lQ29udHJhY3Q8VElucHV0ID0gdW5rbm93biwgVE91dHB1dCA9IHVua25vd24+KFxuICBjaGFydDogRmxvd0NoYXJ0LFxuICBvcHRpb25zOiBGbG93Q2hhcnRDb250cmFjdE9wdGlvbnM8VElucHV0LCBUT3V0cHV0Pixcbik6IEZsb3dDaGFydENvbnRyYWN0PFRJbnB1dCwgVE91dHB1dD4ge1xuICBjb25zdCBpbnB1dFNjaGVtYSA9IG9wdGlvbnMuaW5wdXRTY2hlbWEgPyBub3JtYWxpemVTY2hlbWEob3B0aW9ucy5pbnB1dFNjaGVtYSkgOiB1bmRlZmluZWQ7XG4gIGNvbnN0IG91dHB1dFNjaGVtYSA9IG9wdGlvbnMub3V0cHV0U2NoZW1hID8gbm9ybWFsaXplU2NoZW1hKG9wdGlvbnMub3V0cHV0U2NoZW1hKSA6IHVuZGVmaW5lZDtcblxuICAvLyBCdWlsZCBhIGxpZ2h0d2VpZ2h0IGNoYXJ0IHZpZXcgZm9yIHRoZSBjb250cmFjdC5cbiAgLy9cbiAgLy8gV2UgbXVzdCBOT1QgbXV0YXRlIHRoZSBvcmlnaW5hbCBgY2hhcnRgIG9iamVjdCBiZWNhdXNlIGNoYXJ0cyBhcmUgY29tcGlsZWRcbiAgLy8gYXJ0aWZhY3RzIG1lYW50IHRvIGJlIHNoYXJlZCBhY3Jvc3MgbXVsdGlwbGUgY29uY3VycmVudCBleGVjdXRvcnMuIE11dGF0aW5nXG4gIC8vIGFueSBzY2hlbWEgZmllbGQgYWZ0ZXIgYnVpbGQgd291bGQgYmUgdmlzaWJsZSB0byBhbGwgaG9sZGVycyBvZiB0aGF0IGNoYXJ0XG4gIC8vIHJlZmVyZW5jZSwgY2F1c2luZyBjcm9zcy1jb250cmFjdCBjb250YW1pbmF0aW9uLlxuICAvL1xuICAvLyBJbnN0ZWFkLCB1c2UgT2JqZWN0LmNyZWF0ZShjaGFydCkgdG8gY3JlYXRlIGEgcHJvdG90eXBlLWxpbmtlZCB2aWV3OlxuICAvLyAgIC0gQWxsIHByb3BlcnRpZXMgKHJvb3QsIHN0YWdlTWFwLCBzdWJmbG93cywgbWV0aG9kc+KApikgYXJlIGluaGVyaXRlZCB2aWFcbiAgLy8gICAgIHRoZSBwcm90b3R5cGUgY2hhaW4g4oCUIHplcm8gZXh0cmEgY29weWluZy5cbiAgLy8gICAtIFNldHRpbmcgc2NoZW1hIGZpZWxkcyBvbiB0aGUgdmlldyBjcmVhdGVzIE9XTiBwcm9wZXJ0aWVzIHRoYXQgc2hhZG93XG4gIC8vICAgICB0aGUgcHJvdG90eXBlJ3MgdmFsdWUsIGxlYXZpbmcgdGhlIG9yaWdpbmFsIGNoYXJ0IHVudG91Y2hlZC5cbiAgLy8gICAtIEZsb3dDaGFydEV4ZWN1dG9yIHJlYWRzIGNoYXJ0Vmlldy5pbnB1dFNjaGVtYSB3aGljaCByZXNvbHZlcyB0byB0aGVcbiAgLy8gICAgIG93bi1wcm9wZXJ0eSAoY29udHJhY3Qgc2NoZW1hKSBiZWZvcmUgdGhlIHByb3RvdHlwZSAoYnVpbGRlciBzY2hlbWEpLlxuICAvLyAgIC0gUnVuQ29udGV4dCByZWFkcyBjaGFydFZpZXcub3V0cHV0TWFwcGVyIHRvIGFwcGx5IHRoZSBvdXRwdXQgdHJhbnNmb3JtIOKAlFxuICAvLyAgICAgdGhhdCBtdXN0IGFsc28gYmUgc2hhZG93ZWQgaGVyZSBzbyB0aGUgY29udHJhY3QncyBtYXBwZXIgd2lucy5cbiAgLy9cbiAgLy8gTGltaXRhdGlvbjogT2JqZWN0LmtleXMoY2hhcnRWaWV3KSByZXR1cm5zIG9ubHkgb3duIHByb3BlcnRpZXMgKHRoZSBzY2hlbWFcbiAgLy8gZmllbGRzIHRoYXQgd2VyZSBzaGFkb3dlZCkuIERvIE5PVCB1c2UgT2JqZWN0LmtleXMoKSwgc3ByZWFkICh7Li4uY2hhcnRWaWV3fSksXG4gIC8vIG9yIEpTT04uc3RyaW5naWZ5KGNoYXJ0Vmlldykgb24gdGhpcyB2aWV3IOKAlCB1c2UgbmFtZWQgcHJvcGVydHkgYWNjZXNzIG9yXG4gIC8vIGNoYXJ0LnRvU3BlYygpIGluc3RlYWQuXG4gIGNvbnN0IGNoYXJ0VmlldyA9IE9iamVjdC5jcmVhdGUoY2hhcnQpIGFzIEZsb3dDaGFydDtcbiAgY29uc3QgdmlldyA9IGNoYXJ0VmlldyBhcyBQYXJ0aWFsPEZsb3dDaGFydD47XG4gIGlmIChvcHRpb25zLmlucHV0U2NoZW1hKSB7XG4gICAgdmlldy5pbnB1dFNjaGVtYSA9IG9wdGlvbnMuaW5wdXRTY2hlbWE7XG4gIH1cbiAgaWYgKG9wdGlvbnMub3V0cHV0U2NoZW1hKSB7XG4gICAgdmlldy5vdXRwdXRTY2hlbWEgPSBvcHRpb25zLm91dHB1dFNjaGVtYTtcbiAgfVxuICBpZiAob3B0aW9ucy5vdXRwdXRNYXBwZXIpIHtcbiAgICB2aWV3Lm91dHB1dE1hcHBlciA9IG9wdGlvbnMub3V0cHV0TWFwcGVyIGFzICgoczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHVua25vd24pIHwgdW5kZWZpbmVkO1xuICB9XG5cbiAgY29uc3QgY29udHJhY3Q6IEZsb3dDaGFydENvbnRyYWN0PFRJbnB1dCwgVE91dHB1dD4gPSB7XG4gICAgY2hhcnQ6IGNoYXJ0VmlldyxcbiAgICBpbnB1dFNjaGVtYSxcbiAgICBvdXRwdXRTY2hlbWEsXG4gICAgb3V0cHV0TWFwcGVyOiBvcHRpb25zLm91dHB1dE1hcHBlcixcbiAgICB0b09wZW5BUEkoYXBpT3B0aW9ucz86IE9wZW5BUElPcHRpb25zKTogT3BlbkFQSVNwZWMge1xuICAgICAgcmV0dXJuIGdlbmVyYXRlT3BlbkFQSShjb250cmFjdCwgYXBpT3B0aW9ucyk7XG4gICAgfSxcbiAgfTtcblxuICByZXR1cm4gY29udHJhY3Q7XG59XG4iXX0=