"use strict";
/**
 * contract/openapi.ts — OpenAPI 3.1 spec generator.
 *
 * Generates an OpenAPI spec from a FlowChartContract by combining:
 * - chart.description → operation description (built incrementally during FlowChartBuilder.build())
 * - inputSchema → requestBody
 * - outputSchema → response
 *
 * chart.description is assembled by FlowChartBuilder as each stage is added —
 * no post-processing walk of buildTimeStructure is needed or performed here.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateOpenAPI = void 0;
// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────
function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}
// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Generates an OpenAPI 3.1 spec from a FlowChartContract.
 * Uses `chart.description` which FlowChartBuilder assembles at build time —
 * no post-processing walk of buildTimeStructure is performed here.
 */
function generateOpenAPI(contract, options) {
    var _a, _b, _c;
    const { chart, inputSchema, outputSchema } = contract;
    const version = (_a = options === null || options === void 0 ? void 0 : options.version) !== null && _a !== void 0 ? _a : '1.0.0';
    const basePath = (_b = options === null || options === void 0 ? void 0 : options.basePath) !== null && _b !== void 0 ? _b : '/';
    const method = (_c = options === null || options === void 0 ? void 0 : options.method) !== null && _c !== void 0 ? _c : 'post';
    const rootName = chart.root.name;
    const operationId = slugify(rootName);
    const path = `${basePath === '/' ? '' : basePath}/${operationId}`;
    // Description was built incrementally during FlowChartBuilder.build() — read it directly.
    const fullDescription = chart.description;
    // Build schemas for components
    const schemas = {};
    const inputRef = `${rootName}Input`;
    const outputRef = `${rootName}Output`;
    if (inputSchema)
        schemas[inputRef] = inputSchema;
    if (outputSchema)
        schemas[outputRef] = outputSchema;
    // Build operation
    const operation = {
        operationId,
        summary: rootName,
        description: fullDescription,
        ...(inputSchema
            ? {
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { $ref: `#/components/schemas/${inputRef}` },
                        },
                    },
                },
            }
            : {}),
        responses: {
            '200': {
                description: 'Successful execution',
                ...(outputSchema
                    ? {
                        content: {
                            'application/json': {
                                schema: { $ref: `#/components/schemas/${outputRef}` },
                            },
                        },
                    }
                    : {}),
            },
            '500': {
                description: 'Pipeline execution error',
            },
        },
    };
    const spec = {
        openapi: '3.1.0',
        info: {
            title: rootName,
            description: fullDescription,
            version,
        },
        paths: {
            [path]: {
                [method]: operation,
            },
        },
        ...(Object.keys(schemas).length > 0 ? { components: { schemas } } : {}),
    };
    return spec;
}
exports.generateOpenAPI = generateOpenAPI;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoib3BlbmFwaS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9saWIvY29udHJhY3Qvb3BlbmFwaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7Ozs7R0FVRzs7O0FBS0gsZ0ZBQWdGO0FBQ2hGLG1CQUFtQjtBQUNuQixnRkFBZ0Y7QUFFaEYsU0FBUyxPQUFPLENBQUMsSUFBWTtJQUMzQixPQUFPLElBQUk7U0FDUixXQUFXLEVBQUU7U0FDYixPQUFPLENBQUMsYUFBYSxFQUFFLEdBQUcsQ0FBQztTQUMzQixPQUFPLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBQzNCLENBQUM7QUFFRCxnRkFBZ0Y7QUFDaEYsYUFBYTtBQUNiLGdGQUFnRjtBQUVoRjs7OztHQUlHO0FBQ0gsU0FBZ0IsZUFBZSxDQUFDLFFBQTJCLEVBQUUsT0FBd0I7O0lBQ25GLE1BQU0sRUFBRSxLQUFLLEVBQUUsV0FBVyxFQUFFLFlBQVksRUFBRSxHQUFHLFFBQVEsQ0FBQztJQUN0RCxNQUFNLE9BQU8sR0FBRyxNQUFBLE9BQU8sYUFBUCxPQUFPLHVCQUFQLE9BQU8sQ0FBRSxPQUFPLG1DQUFJLE9BQU8sQ0FBQztJQUM1QyxNQUFNLFFBQVEsR0FBRyxNQUFBLE9BQU8sYUFBUCxPQUFPLHVCQUFQLE9BQU8sQ0FBRSxRQUFRLG1DQUFJLEdBQUcsQ0FBQztJQUMxQyxNQUFNLE1BQU0sR0FBRyxNQUFBLE9BQU8sYUFBUCxPQUFPLHVCQUFQLE9BQU8sQ0FBRSxNQUFNLG1DQUFJLE1BQU0sQ0FBQztJQUV6QyxNQUFNLFFBQVEsR0FBRyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQztJQUNqQyxNQUFNLFdBQVcsR0FBRyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7SUFDdEMsTUFBTSxJQUFJLEdBQUcsR0FBRyxRQUFRLEtBQUssR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLFFBQVEsSUFBSSxXQUFXLEVBQUUsQ0FBQztJQUVsRSwwRkFBMEY7SUFDMUYsTUFBTSxlQUFlLEdBQUcsS0FBSyxDQUFDLFdBQVcsQ0FBQztJQUUxQywrQkFBK0I7SUFDL0IsTUFBTSxPQUFPLEdBQStCLEVBQUUsQ0FBQztJQUMvQyxNQUFNLFFBQVEsR0FBRyxHQUFHLFFBQVEsT0FBTyxDQUFDO0lBQ3BDLE1BQU0sU0FBUyxHQUFHLEdBQUcsUUFBUSxRQUFRLENBQUM7SUFFdEMsSUFBSSxXQUFXO1FBQUUsT0FBTyxDQUFDLFFBQVEsQ0FBQyxHQUFHLFdBQVcsQ0FBQztJQUNqRCxJQUFJLFlBQVk7UUFBRSxPQUFPLENBQUMsU0FBUyxDQUFDLEdBQUcsWUFBWSxDQUFDO0lBRXBELGtCQUFrQjtJQUNsQixNQUFNLFNBQVMsR0FBcUI7UUFDbEMsV0FBVztRQUNYLE9BQU8sRUFBRSxRQUFRO1FBQ2pCLFdBQVcsRUFBRSxlQUFlO1FBQzVCLEdBQUcsQ0FBQyxXQUFXO1lBQ2IsQ0FBQyxDQUFDO2dCQUNFLFdBQVcsRUFBRTtvQkFDWCxRQUFRLEVBQUUsSUFBSTtvQkFDZCxPQUFPLEVBQUU7d0JBQ1Asa0JBQWtCLEVBQUU7NEJBQ2xCLE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSx3QkFBd0IsUUFBUSxFQUFFLEVBQUU7eUJBQ3JEO3FCQUNGO2lCQUNGO2FBQ0Y7WUFDSCxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ1AsU0FBUyxFQUFFO1lBQ1QsS0FBSyxFQUFFO2dCQUNMLFdBQVcsRUFBRSxzQkFBc0I7Z0JBQ25DLEdBQUcsQ0FBQyxZQUFZO29CQUNkLENBQUMsQ0FBQzt3QkFDRSxPQUFPLEVBQUU7NEJBQ1Asa0JBQWtCLEVBQUU7Z0NBQ2xCLE1BQU0sRUFBRSxFQUFFLElBQUksRUFBRSx3QkFBd0IsU0FBUyxFQUFFLEVBQUU7NkJBQ3REO3lCQUNGO3FCQUNGO29CQUNILENBQUMsQ0FBQyxFQUFFLENBQUM7YUFDUjtZQUNELEtBQUssRUFBRTtnQkFDTCxXQUFXLEVBQUUsMEJBQTBCO2FBQ3hDO1NBQ0Y7S0FDRixDQUFDO0lBRUYsTUFBTSxJQUFJLEdBQWdCO1FBQ3hCLE9BQU8sRUFBRSxPQUFPO1FBQ2hCLElBQUksRUFBRTtZQUNKLEtBQUssRUFBRSxRQUFRO1lBQ2YsV0FBVyxFQUFFLGVBQWU7WUFDNUIsT0FBTztTQUNSO1FBQ0QsS0FBSyxFQUFFO1lBQ0wsQ0FBQyxJQUFJLENBQUMsRUFBRTtnQkFDTixDQUFDLE1BQU0sQ0FBQyxFQUFFLFNBQVM7YUFDcEI7U0FDRjtRQUNELEdBQUcsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsVUFBVSxFQUFFLEVBQUUsT0FBTyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0tBQ3hFLENBQUM7SUFFRixPQUFPLElBQUksQ0FBQztBQUNkLENBQUM7QUF6RUQsMENBeUVDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBjb250cmFjdC9vcGVuYXBpLnRzIOKAlCBPcGVuQVBJIDMuMSBzcGVjIGdlbmVyYXRvci5cbiAqXG4gKiBHZW5lcmF0ZXMgYW4gT3BlbkFQSSBzcGVjIGZyb20gYSBGbG93Q2hhcnRDb250cmFjdCBieSBjb21iaW5pbmc6XG4gKiAtIGNoYXJ0LmRlc2NyaXB0aW9uIOKGkiBvcGVyYXRpb24gZGVzY3JpcHRpb24gKGJ1aWx0IGluY3JlbWVudGFsbHkgZHVyaW5nIEZsb3dDaGFydEJ1aWxkZXIuYnVpbGQoKSlcbiAqIC0gaW5wdXRTY2hlbWEg4oaSIHJlcXVlc3RCb2R5XG4gKiAtIG91dHB1dFNjaGVtYSDihpIgcmVzcG9uc2VcbiAqXG4gKiBjaGFydC5kZXNjcmlwdGlvbiBpcyBhc3NlbWJsZWQgYnkgRmxvd0NoYXJ0QnVpbGRlciBhcyBlYWNoIHN0YWdlIGlzIGFkZGVkIOKAlFxuICogbm8gcG9zdC1wcm9jZXNzaW5nIHdhbGsgb2YgYnVpbGRUaW1lU3RydWN0dXJlIGlzIG5lZWRlZCBvciBwZXJmb3JtZWQgaGVyZS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEZsb3dDaGFydCB9IGZyb20gJy4uL2J1aWxkZXIvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBGbG93Q2hhcnRDb250cmFjdCwgSnNvblNjaGVtYSwgT3BlbkFQSU9wZXJhdGlvbiwgT3BlbkFQSU9wdGlvbnMsIE9wZW5BUElTcGVjIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gSW50ZXJuYWwgaGVscGVyc1xuLy8g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG5cbmZ1bmN0aW9uIHNsdWdpZnkobmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIG5hbWVcbiAgICAudG9Mb3dlckNhc2UoKVxuICAgIC5yZXBsYWNlKC9bXmEtejAtOV0rL2csICctJylcbiAgICAucmVwbGFjZSgvXi18LSQvZywgJycpO1xufVxuXG4vLyDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIBcbi8vIFB1YmxpYyBBUElcbi8vIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuXG4vKipcbiAqIEdlbmVyYXRlcyBhbiBPcGVuQVBJIDMuMSBzcGVjIGZyb20gYSBGbG93Q2hhcnRDb250cmFjdC5cbiAqIFVzZXMgYGNoYXJ0LmRlc2NyaXB0aW9uYCB3aGljaCBGbG93Q2hhcnRCdWlsZGVyIGFzc2VtYmxlcyBhdCBidWlsZCB0aW1lIOKAlFxuICogbm8gcG9zdC1wcm9jZXNzaW5nIHdhbGsgb2YgYnVpbGRUaW1lU3RydWN0dXJlIGlzIHBlcmZvcm1lZCBoZXJlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2VuZXJhdGVPcGVuQVBJKGNvbnRyYWN0OiBGbG93Q2hhcnRDb250cmFjdCwgb3B0aW9ucz86IE9wZW5BUElPcHRpb25zKTogT3BlbkFQSVNwZWMge1xuICBjb25zdCB7IGNoYXJ0LCBpbnB1dFNjaGVtYSwgb3V0cHV0U2NoZW1hIH0gPSBjb250cmFjdDtcbiAgY29uc3QgdmVyc2lvbiA9IG9wdGlvbnM/LnZlcnNpb24gPz8gJzEuMC4wJztcbiAgY29uc3QgYmFzZVBhdGggPSBvcHRpb25zPy5iYXNlUGF0aCA/PyAnLyc7XG4gIGNvbnN0IG1ldGhvZCA9IG9wdGlvbnM/Lm1ldGhvZCA/PyAncG9zdCc7XG5cbiAgY29uc3Qgcm9vdE5hbWUgPSBjaGFydC5yb290Lm5hbWU7XG4gIGNvbnN0IG9wZXJhdGlvbklkID0gc2x1Z2lmeShyb290TmFtZSk7XG4gIGNvbnN0IHBhdGggPSBgJHtiYXNlUGF0aCA9PT0gJy8nID8gJycgOiBiYXNlUGF0aH0vJHtvcGVyYXRpb25JZH1gO1xuXG4gIC8vIERlc2NyaXB0aW9uIHdhcyBidWlsdCBpbmNyZW1lbnRhbGx5IGR1cmluZyBGbG93Q2hhcnRCdWlsZGVyLmJ1aWxkKCkg4oCUIHJlYWQgaXQgZGlyZWN0bHkuXG4gIGNvbnN0IGZ1bGxEZXNjcmlwdGlvbiA9IGNoYXJ0LmRlc2NyaXB0aW9uO1xuXG4gIC8vIEJ1aWxkIHNjaGVtYXMgZm9yIGNvbXBvbmVudHNcbiAgY29uc3Qgc2NoZW1hczogUmVjb3JkPHN0cmluZywgSnNvblNjaGVtYT4gPSB7fTtcbiAgY29uc3QgaW5wdXRSZWYgPSBgJHtyb290TmFtZX1JbnB1dGA7XG4gIGNvbnN0IG91dHB1dFJlZiA9IGAke3Jvb3ROYW1lfU91dHB1dGA7XG5cbiAgaWYgKGlucHV0U2NoZW1hKSBzY2hlbWFzW2lucHV0UmVmXSA9IGlucHV0U2NoZW1hO1xuICBpZiAob3V0cHV0U2NoZW1hKSBzY2hlbWFzW291dHB1dFJlZl0gPSBvdXRwdXRTY2hlbWE7XG5cbiAgLy8gQnVpbGQgb3BlcmF0aW9uXG4gIGNvbnN0IG9wZXJhdGlvbjogT3BlbkFQSU9wZXJhdGlvbiA9IHtcbiAgICBvcGVyYXRpb25JZCxcbiAgICBzdW1tYXJ5OiByb290TmFtZSxcbiAgICBkZXNjcmlwdGlvbjogZnVsbERlc2NyaXB0aW9uLFxuICAgIC4uLihpbnB1dFNjaGVtYVxuICAgICAgPyB7XG4gICAgICAgICAgcmVxdWVzdEJvZHk6IHtcbiAgICAgICAgICAgIHJlcXVpcmVkOiB0cnVlLFxuICAgICAgICAgICAgY29udGVudDoge1xuICAgICAgICAgICAgICAnYXBwbGljYXRpb24vanNvbic6IHtcbiAgICAgICAgICAgICAgICBzY2hlbWE6IHsgJHJlZjogYCMvY29tcG9uZW50cy9zY2hlbWFzLyR7aW5wdXRSZWZ9YCB9LFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9XG4gICAgICA6IHt9KSxcbiAgICByZXNwb25zZXM6IHtcbiAgICAgICcyMDAnOiB7XG4gICAgICAgIGRlc2NyaXB0aW9uOiAnU3VjY2Vzc2Z1bCBleGVjdXRpb24nLFxuICAgICAgICAuLi4ob3V0cHV0U2NoZW1hXG4gICAgICAgICAgPyB7XG4gICAgICAgICAgICAgIGNvbnRlbnQ6IHtcbiAgICAgICAgICAgICAgICAnYXBwbGljYXRpb24vanNvbic6IHtcbiAgICAgICAgICAgICAgICAgIHNjaGVtYTogeyAkcmVmOiBgIy9jb21wb25lbnRzL3NjaGVtYXMvJHtvdXRwdXRSZWZ9YCB9LFxuICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICB9XG4gICAgICAgICAgOiB7fSksXG4gICAgICB9LFxuICAgICAgJzUwMCc6IHtcbiAgICAgICAgZGVzY3JpcHRpb246ICdQaXBlbGluZSBleGVjdXRpb24gZXJyb3InLFxuICAgICAgfSxcbiAgICB9LFxuICB9O1xuXG4gIGNvbnN0IHNwZWM6IE9wZW5BUElTcGVjID0ge1xuICAgIG9wZW5hcGk6ICczLjEuMCcsXG4gICAgaW5mbzoge1xuICAgICAgdGl0bGU6IHJvb3ROYW1lLFxuICAgICAgZGVzY3JpcHRpb246IGZ1bGxEZXNjcmlwdGlvbixcbiAgICAgIHZlcnNpb24sXG4gICAgfSxcbiAgICBwYXRoczoge1xuICAgICAgW3BhdGhdOiB7XG4gICAgICAgIFttZXRob2RdOiBvcGVyYXRpb24sXG4gICAgICB9LFxuICAgIH0sXG4gICAgLi4uKE9iamVjdC5rZXlzKHNjaGVtYXMpLmxlbmd0aCA+IDAgPyB7IGNvbXBvbmVudHM6IHsgc2NoZW1hcyB9IH0gOiB7fSksXG4gIH07XG5cbiAgcmV0dXJuIHNwZWM7XG59XG4iXX0=