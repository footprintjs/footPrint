"use strict";
/**
 * RunnableChart -- Adds .recorder(), .redact(), .run(), .toOpenAPI(), .toMCPTool()
 * to a FlowChart object.
 *
 * Called by FlowChartBuilder.build() to enrich the compiled chart with
 * d3-style chainable run methods and self-describing outputs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeRunnable = void 0;
const schema_js_1 = require("../contract/schema.js");
const RunContext_js_1 = require("./RunContext.js");
// Cache for no-options toOpenAPI() calls only — parameterized calls are not cached
// because different options produce different output.
const openAPICache = new WeakMap();
const mcpCache = new WeakMap();
/**
 * Enrich a FlowChart with run + describe methods.
 * Called by FlowChartBuilder.build().
 */
function makeRunnable(chart) {
    const runnable = chart;
    runnable.recorder = function (r) {
        return new RunContext_js_1.RunContext(chart).recorder(r);
    };
    runnable.redact = function (policy) {
        return new RunContext_js_1.RunContext(chart).redact(policy);
    };
    runnable.run = function (options) {
        return new RunContext_js_1.RunContext(chart).run(options);
    };
    runnable.toOpenAPI = function (options) {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        // Only cache no-options calls — parameterized calls vary by options
        if (!options) {
            const cached = openAPICache.get(chart);
            if (cached)
                return cached;
        }
        const builderChart = chart;
        const title = (_c = (_a = options === null || options === void 0 ? void 0 : options.title) !== null && _a !== void 0 ? _a : (_b = builderChart.description) === null || _b === void 0 ? void 0 : _b.split('\n')[0]) !== null && _c !== void 0 ? _c : 'API';
        const version = (_d = options === null || options === void 0 ? void 0 : options.version) !== null && _d !== void 0 ? _d : '1.0.0';
        // Use root.id (the explicit machine-readable id) as the path segment, sanitized
        const rawId = (_f = (_e = builderChart.root) === null || _e === void 0 ? void 0 : _e.id) !== null && _f !== void 0 ? _f : 'execute';
        const path = (_g = options === null || options === void 0 ? void 0 : options.path) !== null && _g !== void 0 ? _g : `/${slugify(rawId)}`;
        const spec = {
            openapi: '3.1.0',
            info: { title, version, description: (_h = options === null || options === void 0 ? void 0 : options.description) !== null && _h !== void 0 ? _h : builderChart.description },
            paths: {
                [path]: {
                    post: {
                        summary: title,
                        description: builderChart.description,
                        ...(builderChart.inputSchema
                            ? {
                                requestBody: {
                                    content: { 'application/json': { schema: (0, schema_js_1.normalizeSchema)(builderChart.inputSchema) } },
                                },
                            }
                            : {}),
                        responses: {
                            '200': {
                                description: 'Success',
                                ...(builderChart.outputSchema
                                    ? { content: { 'application/json': { schema: (0, schema_js_1.normalizeSchema)(builderChart.outputSchema) } } }
                                    : {}),
                            },
                        },
                    },
                },
            },
        };
        if (!options)
            openAPICache.set(chart, spec);
        return spec;
    };
    runnable.toMermaid = function () {
        const lines = ['flowchart TD'];
        const idOf = (k) => (k || '').replace(/[^a-zA-Z0-9_]/g, '_') || '_';
        const visited = new Set();
        const walk = (n) => {
            const nid = idOf(n.id);
            if (visited.has(nid))
                return;
            visited.add(nid);
            lines.push(`${nid}["${n.name}"]`);
            for (const c of n.children || []) {
                const cid = idOf(c.id);
                lines.push(`${nid} --> ${cid}`);
                walk(c);
            }
            if (n.next) {
                const mid = idOf(n.next.id);
                lines.push(`${nid} --> ${mid}`);
                walk(n.next);
            }
        };
        walk(chart.root);
        return lines.join('\n');
    };
    runnable.toMCPTool = function () {
        var _a, _b;
        const cached = mcpCache.get(chart);
        if (cached)
            return cached;
        const builderChart = chart;
        // Use root.id (explicit machine-readable id), sanitized to MCP name character allowlist
        const name = sanitizeMCPName((_b = (_a = builderChart.root) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : 'execute');
        const description = builderChart.description || `Execute the ${name} flowchart`;
        // MCP spec requires inputSchema to always be present.
        // When no contract is defined, use the recommended no-parameter form.
        const inputSchema = builderChart.inputSchema
            ? (0, schema_js_1.normalizeSchema)(builderChart.inputSchema)
            : { type: 'object', properties: {}, additionalProperties: false };
        const tool = { name, description, inputSchema };
        mcpCache.set(chart, tool);
        return tool;
    };
    return runnable;
}
exports.makeRunnable = makeRunnable;
/**
 * Sanitize a string to conform to the MCP tool name character allowlist:
 * [A-Za-z0-9_\-.] — any other character is replaced with underscore.
 * Trims leading/trailing underscores introduced by replacement.
 */
function sanitizeMCPName(id) {
    return id.replace(/[^A-Za-z0-9_\-.]/g, '_').replace(/^_+|_+$/g, '') || 'execute';
}
/**
 * Slugify a string for use as an OpenAPI path segment.
 * Lowercases and replaces non-alphanumeric runs with hyphens.
 */
function slugify(id) {
    return (id
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'execute');
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUnVubmFibGVDaGFydC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9saWIvcnVubmVyL1J1bm5hYmxlQ2hhcnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7Ozs7R0FNRzs7O0FBR0gscURBQXdEO0FBS3hELG1EQUE2RDtBQTRDN0QsbUZBQW1GO0FBQ25GLHNEQUFzRDtBQUN0RCxNQUFNLFlBQVksR0FBRyxJQUFJLE9BQU8sRUFBcUIsQ0FBQztBQUN0RCxNQUFNLFFBQVEsR0FBRyxJQUFJLE9BQU8sRUFBaUMsQ0FBQztBQUU5RDs7O0dBR0c7QUFDSCxTQUFnQixZQUFZLENBQWUsS0FBOEI7SUFDdkUsTUFBTSxRQUFRLEdBQUcsS0FBd0MsQ0FBQztJQUUxRCxRQUFRLENBQUMsUUFBUSxHQUFHLFVBQVUsQ0FBMEI7UUFDdEQsT0FBTyxJQUFJLDBCQUFVLENBQUMsS0FBSyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO0lBQzNDLENBQUMsQ0FBQztJQUVGLFFBQVEsQ0FBQyxNQUFNLEdBQUcsVUFBVSxNQUF1QjtRQUNqRCxPQUFPLElBQUksMEJBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDOUMsQ0FBQyxDQUFDO0lBRUYsUUFBUSxDQUFDLEdBQUcsR0FBRyxVQUFVLE9BQW9CO1FBQzNDLE9BQU8sSUFBSSwwQkFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUM1QyxDQUFDLENBQUM7SUFFRixRQUFRLENBQUMsU0FBUyxHQUFHLFVBQVUsT0FBNkI7O1FBQzFELG9FQUFvRTtRQUNwRSxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7WUFDYixNQUFNLE1BQU0sR0FBRyxZQUFZLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDO1lBQ3ZDLElBQUksTUFBTTtnQkFBRSxPQUFPLE1BQU0sQ0FBQztRQUM1QixDQUFDO1FBRUQsTUFBTSxZQUFZLEdBQUcsS0FBWSxDQUFDO1FBQ2xDLE1BQU0sS0FBSyxHQUFHLE1BQUEsTUFBQSxPQUFPLGFBQVAsT0FBTyx1QkFBUCxPQUFPLENBQUUsS0FBSyxtQ0FBSSxNQUFBLFlBQVksQ0FBQyxXQUFXLDBDQUFFLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLG1DQUFJLEtBQUssQ0FBQztRQUNsRixNQUFNLE9BQU8sR0FBRyxNQUFBLE9BQU8sYUFBUCxPQUFPLHVCQUFQLE9BQU8sQ0FBRSxPQUFPLG1DQUFJLE9BQU8sQ0FBQztRQUM1QyxnRkFBZ0Y7UUFDaEYsTUFBTSxLQUFLLEdBQUcsTUFBQSxNQUFBLFlBQVksQ0FBQyxJQUFJLDBDQUFFLEVBQUUsbUNBQUksU0FBUyxDQUFDO1FBQ2pELE1BQU0sSUFBSSxHQUFHLE1BQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLElBQUksbUNBQUksSUFBSSxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztRQUVuRCxNQUFNLElBQUksR0FBNEI7WUFDcEMsT0FBTyxFQUFFLE9BQU87WUFDaEIsSUFBSSxFQUFFLEVBQUUsS0FBSyxFQUFFLE9BQU8sRUFBRSxXQUFXLEVBQUUsTUFBQSxPQUFPLGFBQVAsT0FBTyx1QkFBUCxPQUFPLENBQUUsV0FBVyxtQ0FBSSxZQUFZLENBQUMsV0FBVyxFQUFFO1lBQ3ZGLEtBQUssRUFBRTtnQkFDTCxDQUFDLElBQUksQ0FBQyxFQUFFO29CQUNOLElBQUksRUFBRTt3QkFDSixPQUFPLEVBQUUsS0FBSzt3QkFDZCxXQUFXLEVBQUUsWUFBWSxDQUFDLFdBQVc7d0JBQ3JDLEdBQUcsQ0FBQyxZQUFZLENBQUMsV0FBVzs0QkFDMUIsQ0FBQyxDQUFDO2dDQUNFLFdBQVcsRUFBRTtvQ0FDWCxPQUFPLEVBQUUsRUFBRSxrQkFBa0IsRUFBRSxFQUFFLE1BQU0sRUFBRSxJQUFBLDJCQUFlLEVBQUMsWUFBWSxDQUFDLFdBQVcsQ0FBQyxFQUFFLEVBQUU7aUNBQ3ZGOzZCQUNGOzRCQUNILENBQUMsQ0FBQyxFQUFFLENBQUM7d0JBQ1AsU0FBUyxFQUFFOzRCQUNULEtBQUssRUFBRTtnQ0FDTCxXQUFXLEVBQUUsU0FBUztnQ0FDdEIsR0FBRyxDQUFDLFlBQVksQ0FBQyxZQUFZO29DQUMzQixDQUFDLENBQUMsRUFBRSxPQUFPLEVBQUUsRUFBRSxrQkFBa0IsRUFBRSxFQUFFLE1BQU0sRUFBRSxJQUFBLDJCQUFlLEVBQUMsWUFBWSxDQUFDLFlBQVksQ0FBQyxFQUFFLEVBQUUsRUFBRTtvQ0FDN0YsQ0FBQyxDQUFDLEVBQUUsQ0FBQzs2QkFDUjt5QkFDRjtxQkFDRjtpQkFDRjthQUNGO1NBQ0YsQ0FBQztRQUVGLElBQUksQ0FBQyxPQUFPO1lBQUUsWUFBWSxDQUFDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDNUMsT0FBTyxJQUFJLENBQUM7SUFDZCxDQUFDLENBQUM7SUFFRixRQUFRLENBQUMsU0FBUyxHQUFHO1FBQ25CLE1BQU0sS0FBSyxHQUFhLENBQUMsY0FBYyxDQUFDLENBQUM7UUFDekMsTUFBTSxJQUFJLEdBQUcsQ0FBQyxDQUFTLEVBQUUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxnQkFBZ0IsRUFBRSxHQUFHLENBQUMsSUFBSSxHQUFHLENBQUM7UUFDNUUsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLEVBQVUsQ0FBQztRQUNsQyxNQUFNLElBQUksR0FBRyxDQUFDLENBQVksRUFBRSxFQUFFO1lBQzVCLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7WUFDdkIsSUFBSSxPQUFPLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQztnQkFBRSxPQUFPO1lBQzdCLE9BQU8sQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUM7WUFDakIsS0FBSyxDQUFDLElBQUksQ0FBQyxHQUFHLEdBQUcsS0FBSyxDQUFDLENBQUMsSUFBSSxJQUFJLENBQUMsQ0FBQztZQUNsQyxLQUFLLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQyxRQUFRLElBQUksRUFBRSxFQUFFLENBQUM7Z0JBQ2pDLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUM7Z0JBQ3ZCLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxHQUFHLFFBQVEsR0FBRyxFQUFFLENBQUMsQ0FBQztnQkFDaEMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO1lBQ1YsQ0FBQztZQUNELElBQUksQ0FBQyxDQUFDLElBQUksRUFBRSxDQUFDO2dCQUNYLE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDO2dCQUM1QixLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsR0FBRyxRQUFRLEdBQUcsRUFBRSxDQUFDLENBQUM7Z0JBQ2hDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDZixDQUFDO1FBQ0gsQ0FBQyxDQUFDO1FBQ0YsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUNqQixPQUFPLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUM7SUFDMUIsQ0FBQyxDQUFDO0lBRUYsUUFBUSxDQUFDLFNBQVMsR0FBRzs7UUFDbkIsTUFBTSxNQUFNLEdBQUcsUUFBUSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQztRQUNuQyxJQUFJLE1BQU07WUFBRSxPQUFPLE1BQU0sQ0FBQztRQUUxQixNQUFNLFlBQVksR0FBRyxLQUFZLENBQUM7UUFDbEMsd0ZBQXdGO1FBQ3hGLE1BQU0sSUFBSSxHQUFHLGVBQWUsQ0FBQyxNQUFBLE1BQUEsWUFBWSxDQUFDLElBQUksMENBQUUsRUFBRSxtQ0FBSSxTQUFTLENBQUMsQ0FBQztRQUNqRSxNQUFNLFdBQVcsR0FBRyxZQUFZLENBQUMsV0FBVyxJQUFJLGVBQWUsSUFBSSxZQUFZLENBQUM7UUFFaEYsc0RBQXNEO1FBQ3RELHNFQUFzRTtRQUN0RSxNQUFNLFdBQVcsR0FBZSxZQUFZLENBQUMsV0FBVztZQUN0RCxDQUFDLENBQUMsSUFBQSwyQkFBZSxFQUFDLFlBQVksQ0FBQyxXQUFXLENBQUM7WUFDM0MsQ0FBQyxDQUFDLEVBQUUsSUFBSSxFQUFFLFFBQVEsRUFBRSxVQUFVLEVBQUUsRUFBRSxFQUFFLG9CQUFvQixFQUFFLEtBQUssRUFBRSxDQUFDO1FBRXBFLE1BQU0sSUFBSSxHQUF1QixFQUFFLElBQUksRUFBRSxXQUFXLEVBQUUsV0FBVyxFQUFFLENBQUM7UUFFcEUsUUFBUSxDQUFDLEdBQUcsQ0FBQyxLQUFLLEVBQUUsSUFBSSxDQUFDLENBQUM7UUFDMUIsT0FBTyxJQUFJLENBQUM7SUFDZCxDQUFDLENBQUM7SUFFRixPQUFPLFFBQVEsQ0FBQztBQUNsQixDQUFDO0FBM0dELG9DQTJHQztBQUVEOzs7O0dBSUc7QUFDSCxTQUFTLGVBQWUsQ0FBQyxFQUFVO0lBQ2pDLE9BQU8sRUFBRSxDQUFDLE9BQU8sQ0FBQyxtQkFBbUIsRUFBRSxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsVUFBVSxFQUFFLEVBQUUsQ0FBQyxJQUFJLFNBQVMsQ0FBQztBQUNuRixDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsU0FBUyxPQUFPLENBQUMsRUFBVTtJQUN6QixPQUFPLENBQ0wsRUFBRTtTQUNDLFdBQVcsRUFBRTtTQUNiLE9BQU8sQ0FBQyxhQUFhLEVBQUUsR0FBRyxDQUFDO1NBQzNCLE9BQU8sQ0FBQyxRQUFRLEVBQUUsRUFBRSxDQUFDLElBQUksU0FBUyxDQUN0QyxDQUFDO0FBQ0osQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogUnVubmFibGVDaGFydCAtLSBBZGRzIC5yZWNvcmRlcigpLCAucmVkYWN0KCksIC5ydW4oKSwgLnRvT3BlbkFQSSgpLCAudG9NQ1BUb29sKClcbiAqIHRvIGEgRmxvd0NoYXJ0IG9iamVjdC5cbiAqXG4gKiBDYWxsZWQgYnkgRmxvd0NoYXJ0QnVpbGRlci5idWlsZCgpIHRvIGVucmljaCB0aGUgY29tcGlsZWQgY2hhcnQgd2l0aFxuICogZDMtc3R5bGUgY2hhaW5hYmxlIHJ1biBtZXRob2RzIGFuZCBzZWxmLWRlc2NyaWJpbmcgb3V0cHV0cy5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEZsb3dDaGFydCB9IGZyb20gJy4uL2J1aWxkZXIvdHlwZXMuanMnO1xuaW1wb3J0IHsgbm9ybWFsaXplU2NoZW1hIH0gZnJvbSAnLi4vY29udHJhY3Qvc2NoZW1hLmpzJztcbmltcG9ydCB0eXBlIHsgSnNvblNjaGVtYSB9IGZyb20gJy4uL2NvbnRyYWN0L3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgRmxvd1JlY29yZGVyIH0gZnJvbSAnLi4vZW5naW5lL25hcnJhdGl2ZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IFJ1bk9wdGlvbnMsIFN0YWdlTm9kZSB9IGZyb20gJy4uL2VuZ2luZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IFJlY29yZGVyLCBSZWRhY3Rpb25Qb2xpY3kgfSBmcm9tICcuLi9zY29wZS90eXBlcy5qcyc7XG5pbXBvcnQgeyB0eXBlIFJ1blJlc3VsdCwgUnVuQ29udGV4dCB9IGZyb20gJy4vUnVuQ29udGV4dC5qcyc7XG5cbi8qKiBPcGVuQVBJIGdlbmVyYXRpb24gb3B0aW9ucy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgQ2hhcnRPcGVuQVBJT3B0aW9ucyB7XG4gIHRpdGxlPzogc3RyaW5nO1xuICB2ZXJzaW9uPzogc3RyaW5nO1xuICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgcGF0aD86IHN0cmluZztcbn1cblxuLyoqIE1DUCB0b29sIGRlc2NyaXB0aW9uIOKAlCBzaGFwZSByZXF1aXJlZCBieSB0aGUgTW9kZWwgQ29udGV4dCBQcm90b2NvbCBzcGVjLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNQ1BUb29sRGVzY3JpcHRpb24ge1xuICBuYW1lOiBzdHJpbmc7XG4gIGRlc2NyaXB0aW9uOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBKU09OIFNjaGVtYSBvYmplY3QgZGVzY3JpYmluZyB0aGUgdG9vbCdzIGlucHV0LlxuICAgKiBBbHdheXMgcHJlc2VudCDigJQgdGhlIE1DUCBzcGVjIHJlcXVpcmVzIGlucHV0U2NoZW1hIGV2ZW4gZm9yIHRvb2xzIHdpdGggbm8gcGFyYW1ldGVycy5cbiAgICogRGVmYXVsdHMgdG8gYHsgdHlwZTogJ29iamVjdCcsIHByb3BlcnRpZXM6IHt9LCBhZGRpdGlvbmFsUHJvcGVydGllczogZmFsc2UgfWAuXG4gICAqL1xuICBpbnB1dFNjaGVtYTogSnNvblNjaGVtYTtcbn1cblxuLyoqXG4gKiBGbG93Q2hhcnQgZW5yaWNoZWQgd2l0aCBkMy1zdHlsZSBydW4gbWV0aG9kcyBhbmQgc2VsZi1kZXNjcmliaW5nIG91dHB1dHMuXG4gKlxuICogRXh0ZW5kcyBidWlsZGVyLkZsb3dDaGFydCAod2hpY2ggYWxyZWFkeSBjYXJyaWVzIGJ1aWxkVGltZVN0cnVjdHVyZSwgZGVzY3JpcHRpb24sXG4gKiBzdGFnZURlc2NyaXB0aW9ucywgaW5wdXRTY2hlbWEsIG91dHB1dFNjaGVtYSwgb3V0cHV0TWFwcGVyKSBhbmQgYWRkcyB0aGUgcnVudGltZVxuICogbWV0aG9kcyBhdHRhY2hlZCBieSBtYWtlUnVubmFibGUoKS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBSdW5uYWJsZUZsb3dDaGFydDxUT3V0ID0gYW55LCBUU2NvcGUgPSBhbnk+IGV4dGVuZHMgRmxvd0NoYXJ0PFRPdXQsIFRTY29wZT4ge1xuICAvKiogQXR0YWNoIGEgcmVjb3JkZXIgZm9yIHRoZSBuZXh0IHJ1bi4gUmV0dXJucyBhIGNoYWluYWJsZSBSdW5Db250ZXh0LiAqL1xuICByZWNvcmRlcihyOiBSZWNvcmRlciB8IEZsb3dSZWNvcmRlcik6IFJ1bkNvbnRleHQ8VE91dCwgVFNjb3BlPjtcbiAgLyoqIFNldCByZWRhY3Rpb24gcG9saWN5IGZvciB0aGUgbmV4dCBydW4uIFJldHVybnMgYSBjaGFpbmFibGUgUnVuQ29udGV4dC4gKi9cbiAgcmVkYWN0KHBvbGljeTogUmVkYWN0aW9uUG9saWN5KTogUnVuQ29udGV4dDxUT3V0LCBUU2NvcGU+O1xuICAvKiogRXhlY3V0ZSB0aGUgY2hhcnQgZGlyZWN0bHkgKGJhcmUgcnVuLCBubyByZWNvcmRlcnMpLiAqL1xuICBydW4ob3B0aW9ucz86IFJ1bk9wdGlvbnMpOiBQcm9taXNlPFJ1blJlc3VsdD47XG4gIC8qKiBHZW5lcmF0ZSBPcGVuQVBJIDMuMSBzcGVjIGZyb20gY2hhcnQgbWV0YWRhdGEgKyBjb250cmFjdC4gQ2FjaGVkIGZvciBuby1vcHRpb25zIGNhbGxzLiAqL1xuICB0b09wZW5BUEkob3B0aW9ucz86IENoYXJ0T3BlbkFQSU9wdGlvbnMpOiBvYmplY3Q7XG4gIC8qKiBHZW5lcmF0ZSBNQ1AgdG9vbCBkZXNjcmlwdGlvbiBmcm9tIGNoYXJ0IG1ldGFkYXRhLiBDYWNoZWQuICovXG4gIHRvTUNQVG9vbCgpOiBNQ1BUb29sRGVzY3JpcHRpb247XG4gIC8qKiBHZW5lcmF0ZSBhIE1lcm1haWQgZmxvd2NoYXJ0IGRpYWdyYW0gc3RyaW5nIGZyb20gdGhlIGNoYXJ0J3Mgbm9kZSBncmFwaC4gKi9cbiAgdG9NZXJtYWlkKCk6IHN0cmluZztcbn1cblxuLy8gQ2FjaGUgZm9yIG5vLW9wdGlvbnMgdG9PcGVuQVBJKCkgY2FsbHMgb25seSDigJQgcGFyYW1ldGVyaXplZCBjYWxscyBhcmUgbm90IGNhY2hlZFxuLy8gYmVjYXVzZSBkaWZmZXJlbnQgb3B0aW9ucyBwcm9kdWNlIGRpZmZlcmVudCBvdXRwdXQuXG5jb25zdCBvcGVuQVBJQ2FjaGUgPSBuZXcgV2Vha01hcDxGbG93Q2hhcnQsIG9iamVjdD4oKTtcbmNvbnN0IG1jcENhY2hlID0gbmV3IFdlYWtNYXA8Rmxvd0NoYXJ0LCBNQ1BUb29sRGVzY3JpcHRpb24+KCk7XG5cbi8qKlxuICogRW5yaWNoIGEgRmxvd0NoYXJ0IHdpdGggcnVuICsgZGVzY3JpYmUgbWV0aG9kcy5cbiAqIENhbGxlZCBieSBGbG93Q2hhcnRCdWlsZGVyLmJ1aWxkKCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYWtlUnVubmFibGU8VE91dCwgVFNjb3BlPihjaGFydDogRmxvd0NoYXJ0PFRPdXQsIFRTY29wZT4pOiBSdW5uYWJsZUZsb3dDaGFydDxUT3V0LCBUU2NvcGU+IHtcbiAgY29uc3QgcnVubmFibGUgPSBjaGFydCBhcyBSdW5uYWJsZUZsb3dDaGFydDxUT3V0LCBUU2NvcGU+O1xuXG4gIHJ1bm5hYmxlLnJlY29yZGVyID0gZnVuY3Rpb24gKHI6IFJlY29yZGVyIHwgRmxvd1JlY29yZGVyKTogUnVuQ29udGV4dDxUT3V0LCBUU2NvcGU+IHtcbiAgICByZXR1cm4gbmV3IFJ1bkNvbnRleHQoY2hhcnQpLnJlY29yZGVyKHIpO1xuICB9O1xuXG4gIHJ1bm5hYmxlLnJlZGFjdCA9IGZ1bmN0aW9uIChwb2xpY3k6IFJlZGFjdGlvblBvbGljeSk6IFJ1bkNvbnRleHQ8VE91dCwgVFNjb3BlPiB7XG4gICAgcmV0dXJuIG5ldyBSdW5Db250ZXh0KGNoYXJ0KS5yZWRhY3QocG9saWN5KTtcbiAgfTtcblxuICBydW5uYWJsZS5ydW4gPSBmdW5jdGlvbiAob3B0aW9ucz86IFJ1bk9wdGlvbnMpOiBQcm9taXNlPFJ1blJlc3VsdD4ge1xuICAgIHJldHVybiBuZXcgUnVuQ29udGV4dChjaGFydCkucnVuKG9wdGlvbnMpO1xuICB9O1xuXG4gIHJ1bm5hYmxlLnRvT3BlbkFQSSA9IGZ1bmN0aW9uIChvcHRpb25zPzogQ2hhcnRPcGVuQVBJT3B0aW9ucyk6IG9iamVjdCB7XG4gICAgLy8gT25seSBjYWNoZSBuby1vcHRpb25zIGNhbGxzIOKAlCBwYXJhbWV0ZXJpemVkIGNhbGxzIHZhcnkgYnkgb3B0aW9uc1xuICAgIGlmICghb3B0aW9ucykge1xuICAgICAgY29uc3QgY2FjaGVkID0gb3BlbkFQSUNhY2hlLmdldChjaGFydCk7XG4gICAgICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuICAgIH1cblxuICAgIGNvbnN0IGJ1aWxkZXJDaGFydCA9IGNoYXJ0IGFzIGFueTtcbiAgICBjb25zdCB0aXRsZSA9IG9wdGlvbnM/LnRpdGxlID8/IGJ1aWxkZXJDaGFydC5kZXNjcmlwdGlvbj8uc3BsaXQoJ1xcbicpWzBdID8/ICdBUEknO1xuICAgIGNvbnN0IHZlcnNpb24gPSBvcHRpb25zPy52ZXJzaW9uID8/ICcxLjAuMCc7XG4gICAgLy8gVXNlIHJvb3QuaWQgKHRoZSBleHBsaWNpdCBtYWNoaW5lLXJlYWRhYmxlIGlkKSBhcyB0aGUgcGF0aCBzZWdtZW50LCBzYW5pdGl6ZWRcbiAgICBjb25zdCByYXdJZCA9IGJ1aWxkZXJDaGFydC5yb290Py5pZCA/PyAnZXhlY3V0ZSc7XG4gICAgY29uc3QgcGF0aCA9IG9wdGlvbnM/LnBhdGggPz8gYC8ke3NsdWdpZnkocmF3SWQpfWA7XG5cbiAgICBjb25zdCBzcGVjOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHtcbiAgICAgIG9wZW5hcGk6ICczLjEuMCcsXG4gICAgICBpbmZvOiB7IHRpdGxlLCB2ZXJzaW9uLCBkZXNjcmlwdGlvbjogb3B0aW9ucz8uZGVzY3JpcHRpb24gPz8gYnVpbGRlckNoYXJ0LmRlc2NyaXB0aW9uIH0sXG4gICAgICBwYXRoczoge1xuICAgICAgICBbcGF0aF06IHtcbiAgICAgICAgICBwb3N0OiB7XG4gICAgICAgICAgICBzdW1tYXJ5OiB0aXRsZSxcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uOiBidWlsZGVyQ2hhcnQuZGVzY3JpcHRpb24sXG4gICAgICAgICAgICAuLi4oYnVpbGRlckNoYXJ0LmlucHV0U2NoZW1hXG4gICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgcmVxdWVzdEJvZHk6IHtcbiAgICAgICAgICAgICAgICAgICAgY29udGVudDogeyAnYXBwbGljYXRpb24vanNvbic6IHsgc2NoZW1hOiBub3JtYWxpemVTY2hlbWEoYnVpbGRlckNoYXJ0LmlucHV0U2NoZW1hKSB9IH0sXG4gICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgOiB7fSksXG4gICAgICAgICAgICByZXNwb25zZXM6IHtcbiAgICAgICAgICAgICAgJzIwMCc6IHtcbiAgICAgICAgICAgICAgICBkZXNjcmlwdGlvbjogJ1N1Y2Nlc3MnLFxuICAgICAgICAgICAgICAgIC4uLihidWlsZGVyQ2hhcnQub3V0cHV0U2NoZW1hXG4gICAgICAgICAgICAgICAgICA/IHsgY29udGVudDogeyAnYXBwbGljYXRpb24vanNvbic6IHsgc2NoZW1hOiBub3JtYWxpemVTY2hlbWEoYnVpbGRlckNoYXJ0Lm91dHB1dFNjaGVtYSkgfSB9IH1cbiAgICAgICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgfSxcbiAgICB9O1xuXG4gICAgaWYgKCFvcHRpb25zKSBvcGVuQVBJQ2FjaGUuc2V0KGNoYXJ0LCBzcGVjKTtcbiAgICByZXR1cm4gc3BlYztcbiAgfTtcblxuICBydW5uYWJsZS50b01lcm1haWQgPSBmdW5jdGlvbiAoKTogc3RyaW5nIHtcbiAgICBjb25zdCBsaW5lczogc3RyaW5nW10gPSBbJ2Zsb3djaGFydCBURCddO1xuICAgIGNvbnN0IGlkT2YgPSAoazogc3RyaW5nKSA9PiAoayB8fCAnJykucmVwbGFjZSgvW15hLXpBLVowLTlfXS9nLCAnXycpIHx8ICdfJztcbiAgICBjb25zdCB2aXNpdGVkID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gICAgY29uc3Qgd2FsayA9IChuOiBTdGFnZU5vZGUpID0+IHtcbiAgICAgIGNvbnN0IG5pZCA9IGlkT2Yobi5pZCk7XG4gICAgICBpZiAodmlzaXRlZC5oYXMobmlkKSkgcmV0dXJuO1xuICAgICAgdmlzaXRlZC5hZGQobmlkKTtcbiAgICAgIGxpbmVzLnB1c2goYCR7bmlkfVtcIiR7bi5uYW1lfVwiXWApO1xuICAgICAgZm9yIChjb25zdCBjIG9mIG4uY2hpbGRyZW4gfHwgW10pIHtcbiAgICAgICAgY29uc3QgY2lkID0gaWRPZihjLmlkKTtcbiAgICAgICAgbGluZXMucHVzaChgJHtuaWR9IC0tPiAke2NpZH1gKTtcbiAgICAgICAgd2FsayhjKTtcbiAgICAgIH1cbiAgICAgIGlmIChuLm5leHQpIHtcbiAgICAgICAgY29uc3QgbWlkID0gaWRPZihuLm5leHQuaWQpO1xuICAgICAgICBsaW5lcy5wdXNoKGAke25pZH0gLS0+ICR7bWlkfWApO1xuICAgICAgICB3YWxrKG4ubmV4dCk7XG4gICAgICB9XG4gICAgfTtcbiAgICB3YWxrKGNoYXJ0LnJvb3QpO1xuICAgIHJldHVybiBsaW5lcy5qb2luKCdcXG4nKTtcbiAgfTtcblxuICBydW5uYWJsZS50b01DUFRvb2wgPSBmdW5jdGlvbiAoKTogTUNQVG9vbERlc2NyaXB0aW9uIHtcbiAgICBjb25zdCBjYWNoZWQgPSBtY3BDYWNoZS5nZXQoY2hhcnQpO1xuICAgIGlmIChjYWNoZWQpIHJldHVybiBjYWNoZWQ7XG5cbiAgICBjb25zdCBidWlsZGVyQ2hhcnQgPSBjaGFydCBhcyBhbnk7XG4gICAgLy8gVXNlIHJvb3QuaWQgKGV4cGxpY2l0IG1hY2hpbmUtcmVhZGFibGUgaWQpLCBzYW5pdGl6ZWQgdG8gTUNQIG5hbWUgY2hhcmFjdGVyIGFsbG93bGlzdFxuICAgIGNvbnN0IG5hbWUgPSBzYW5pdGl6ZU1DUE5hbWUoYnVpbGRlckNoYXJ0LnJvb3Q/LmlkID8/ICdleGVjdXRlJyk7XG4gICAgY29uc3QgZGVzY3JpcHRpb24gPSBidWlsZGVyQ2hhcnQuZGVzY3JpcHRpb24gfHwgYEV4ZWN1dGUgdGhlICR7bmFtZX0gZmxvd2NoYXJ0YDtcblxuICAgIC8vIE1DUCBzcGVjIHJlcXVpcmVzIGlucHV0U2NoZW1hIHRvIGFsd2F5cyBiZSBwcmVzZW50LlxuICAgIC8vIFdoZW4gbm8gY29udHJhY3QgaXMgZGVmaW5lZCwgdXNlIHRoZSByZWNvbW1lbmRlZCBuby1wYXJhbWV0ZXIgZm9ybS5cbiAgICBjb25zdCBpbnB1dFNjaGVtYTogSnNvblNjaGVtYSA9IGJ1aWxkZXJDaGFydC5pbnB1dFNjaGVtYVxuICAgICAgPyBub3JtYWxpemVTY2hlbWEoYnVpbGRlckNoYXJ0LmlucHV0U2NoZW1hKVxuICAgICAgOiB7IHR5cGU6ICdvYmplY3QnLCBwcm9wZXJ0aWVzOiB7fSwgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlIH07XG5cbiAgICBjb25zdCB0b29sOiBNQ1BUb29sRGVzY3JpcHRpb24gPSB7IG5hbWUsIGRlc2NyaXB0aW9uLCBpbnB1dFNjaGVtYSB9O1xuXG4gICAgbWNwQ2FjaGUuc2V0KGNoYXJ0LCB0b29sKTtcbiAgICByZXR1cm4gdG9vbDtcbiAgfTtcblxuICByZXR1cm4gcnVubmFibGU7XG59XG5cbi8qKlxuICogU2FuaXRpemUgYSBzdHJpbmcgdG8gY29uZm9ybSB0byB0aGUgTUNQIHRvb2wgbmFtZSBjaGFyYWN0ZXIgYWxsb3dsaXN0OlxuICogW0EtWmEtejAtOV9cXC0uXSDigJQgYW55IG90aGVyIGNoYXJhY3RlciBpcyByZXBsYWNlZCB3aXRoIHVuZGVyc2NvcmUuXG4gKiBUcmltcyBsZWFkaW5nL3RyYWlsaW5nIHVuZGVyc2NvcmVzIGludHJvZHVjZWQgYnkgcmVwbGFjZW1lbnQuXG4gKi9cbmZ1bmN0aW9uIHNhbml0aXplTUNQTmFtZShpZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGlkLnJlcGxhY2UoL1teQS1aYS16MC05X1xcLS5dL2csICdfJykucmVwbGFjZSgvXl8rfF8rJC9nLCAnJykgfHwgJ2V4ZWN1dGUnO1xufVxuXG4vKipcbiAqIFNsdWdpZnkgYSBzdHJpbmcgZm9yIHVzZSBhcyBhbiBPcGVuQVBJIHBhdGggc2VnbWVudC5cbiAqIExvd2VyY2FzZXMgYW5kIHJlcGxhY2VzIG5vbi1hbHBoYW51bWVyaWMgcnVucyB3aXRoIGh5cGhlbnMuXG4gKi9cbmZ1bmN0aW9uIHNsdWdpZnkoaWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiAoXG4gICAgaWRcbiAgICAgIC50b0xvd2VyQ2FzZSgpXG4gICAgICAucmVwbGFjZSgvW15hLXowLTldKy9nLCAnLScpXG4gICAgICAucmVwbGFjZSgvXi18LSQvZywgJycpIHx8ICdleGVjdXRlJ1xuICApO1xufVxuIl19