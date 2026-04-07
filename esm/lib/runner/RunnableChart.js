/**
 * RunnableChart -- Adds .recorder(), .redact(), .run(), .toOpenAPI(), .toMCPTool()
 * to a FlowChart object.
 *
 * Called by FlowChartBuilder.build() to enrich the compiled chart with
 * d3-style chainable run methods and self-describing outputs.
 */
import { normalizeSchema } from '../contract/schema.js';
import { RunContext } from './RunContext.js';
// Cache for no-options toOpenAPI() calls only — parameterized calls are not cached
// because different options produce different output.
const openAPICache = new WeakMap();
const mcpCache = new WeakMap();
/**
 * Enrich a FlowChart with run + describe methods.
 * Called by FlowChartBuilder.build().
 */
export function makeRunnable(chart) {
    const runnable = chart;
    runnable.recorder = function (r) {
        return new RunContext(chart).recorder(r);
    };
    runnable.redact = function (policy) {
        return new RunContext(chart).redact(policy);
    };
    runnable.run = function (options) {
        return new RunContext(chart).run(options);
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
                                    content: { 'application/json': { schema: normalizeSchema(builderChart.inputSchema) } },
                                },
                            }
                            : {}),
                        responses: {
                            '200': {
                                description: 'Success',
                                ...(builderChart.outputSchema
                                    ? { content: { 'application/json': { schema: normalizeSchema(builderChart.outputSchema) } } }
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
            ? normalizeSchema(builderChart.inputSchema)
            : { type: 'object', properties: {}, additionalProperties: false };
        const tool = { name, description, inputSchema };
        mcpCache.set(chart, tool);
        return tool;
    };
    return runnable;
}
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiUnVubmFibGVDaGFydC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9saWIvcnVubmVyL1J1bm5hYmxlQ2hhcnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7OztHQU1HO0FBR0gsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLHVCQUF1QixDQUFDO0FBS3hELE9BQU8sRUFBa0IsVUFBVSxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUE0QzdELG1GQUFtRjtBQUNuRixzREFBc0Q7QUFDdEQsTUFBTSxZQUFZLEdBQUcsSUFBSSxPQUFPLEVBQXFCLENBQUM7QUFDdEQsTUFBTSxRQUFRLEdBQUcsSUFBSSxPQUFPLEVBQWlDLENBQUM7QUFFOUQ7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLFlBQVksQ0FBZSxLQUE4QjtJQUN2RSxNQUFNLFFBQVEsR0FBRyxLQUF3QyxDQUFDO0lBRTFELFFBQVEsQ0FBQyxRQUFRLEdBQUcsVUFBVSxDQUEwQjtRQUN0RCxPQUFPLElBQUksVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUMzQyxDQUFDLENBQUM7SUFFRixRQUFRLENBQUMsTUFBTSxHQUFHLFVBQVUsTUFBdUI7UUFDakQsT0FBTyxJQUFJLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUM7SUFDOUMsQ0FBQyxDQUFDO0lBRUYsUUFBUSxDQUFDLEdBQUcsR0FBRyxVQUFVLE9BQW9CO1FBQzNDLE9BQU8sSUFBSSxVQUFVLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0lBQzVDLENBQUMsQ0FBQztJQUVGLFFBQVEsQ0FBQyxTQUFTLEdBQUcsVUFBVSxPQUE2Qjs7UUFDMUQsb0VBQW9FO1FBQ3BFLElBQUksQ0FBQyxPQUFPLEVBQUUsQ0FBQztZQUNiLE1BQU0sTUFBTSxHQUFHLFlBQVksQ0FBQyxHQUFHLENBQUMs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c0Q7UUFDdEQsc0VBQXNFO1FBQ3RFLE1BQU0sV0FBVyxHQUFlLFlBQVksQ0FBQyxXQUFXO1lBQ3RELENBQUMsQ0FBQyxlQUFlLENBQUMsWUFBWSxDQUFDLFdBQVcsQ0FBQztZQUMzQyxDQUFDLENBQUMsRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLFVBQVUsRUFBRSxFQUFFLEVBQUUsb0JBQW9CLEVBQUUsS0FBSyxFQUFFLENBQUM7UUFFcEUsTUFBTSxJQUFJLEdBQXVCLEVBQUUsSUFBSSxFQUFFLFdBQVcsRUFBRSxXQUFXLEVBQUUsQ0FBQztRQUVwRSxRQUFRLENBQUMsR0FBRyxDQUFDLEtBQUssRUFBRSxJQUFJLENBQUMsQ0FBQztRQUMxQixPQUFPLElBQUksQ0FBQztJQUNkLENBQUMsQ0FBQztJQUVGLE9BQU8sUUFBUSxDQUFDO0FBQ2xCLENBQUM7QUFFRDs7OztHQUlHO0FBQ0gsU0FBUyxlQUFlLENBQUMsRUFBVTtJQUNqQyxPQUFPLEVBQUUsQ0FBQyxPQUFPLENBQUMsbUJBQW1CLEVBQUUsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLFVBQVUsRUFBRSxFQUFFLENBQUMsSUFBSSxTQUFTLENBQUM7QUFDbkYsQ0FBQztBQUVEOzs7R0FHRztBQUNILFNBQVMsT0FBTyxDQUFDLEVBQVU7SUFDekIsT0FBTyxDQUNMLEVBQUU7U0FDQyxXQUFXLEVBQUU7U0FDYixPQUFPLENBQUMsYUFBYSxFQUFFLEdBQUcsQ0FBQztTQUMzQixPQUFPLENBQUMsUUFBUSxFQUFFLEVBQUUsQ0FBQyxJQUFJLFNBQVMsQ0FDdEMsQ0FBQztBQUNKLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFJ1bm5hYmxlQ2hhcnQgLS0gQWRkcyAucmVjb3JkZXIoKSwgLnJlZGFjdCgpLCAucnVuKCksIC50b09wZW5BUEkoKSwgLnRvTUNQVG9vbCgpXG4gKiB0byBhIEZsb3dDaGFydCBvYmplY3QuXG4gKlxuICogQ2FsbGVkIGJ5IEZsb3dDaGFydEJ1aWxkZXIuYnVpbGQoKSB0byBlbnJpY2ggdGhlIGNvbXBpbGVkIGNoYXJ0IHdpdGhcbiAqIGQzLXN0eWxlIGNoYWluYWJsZSBydW4gbWV0aG9kcyBhbmQgc2VsZi1kZXNjcmliaW5nIG91dHB1dHMuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBGbG93Q2hhcnQgfSBmcm9tICcuLi9idWlsZGVyL3R5cGVzLmpzJztcbmltcG9ydCB7IG5vcm1hbGl6ZVNjaGVtYSB9IGZyb20gJy4uL2NvbnRyYWN0L3NjaGVtYS5qcyc7XG5pbXBvcnQgdHlwZSB7IEpzb25TY2hlbWEgfSBmcm9tICcuLi9jb250cmFjdC90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IEZsb3dSZWNvcmRlciB9IGZyb20gJy4uL2VuZ2luZS9uYXJyYXRpdmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBSdW5PcHRpb25zLCBTdGFnZU5vZGUgfSBmcm9tICcuLi9lbmdpbmUvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBSZWNvcmRlciwgUmVkYWN0aW9uUG9saWN5IH0gZnJvbSAnLi4vc2NvcGUvdHlwZXMuanMnO1xuaW1wb3J0IHsgdHlwZSBSdW5SZXN1bHQsIFJ1bkNvbnRleHQgfSBmcm9tICcuL1J1bkNvbnRleHQuanMnO1xuXG4vKiogT3BlbkFQSSBnZW5lcmF0aW9uIG9wdGlvbnMuICovXG5leHBvcnQgaW50ZXJmYWNlIENoYXJ0T3BlbkFQSU9wdGlvbnMge1xuICB0aXRsZT86IHN0cmluZztcbiAgdmVyc2lvbj86IHN0cmluZztcbiAgZGVzY3JpcHRpb24/OiBzdHJpbmc7XG4gIHBhdGg/OiBzdHJpbmc7XG59XG5cbi8qKiBNQ1AgdG9vbCBkZXNjcmlwdGlvbiDigJQgc2hhcGUgcmVxdWlyZWQgYnkgdGhlIE1vZGVsIENvbnRleHQgUHJvdG9jb2wgc3BlYy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTUNQVG9vbERlc2NyaXB0aW9uIHtcbiAgbmFtZTogc3RyaW5nO1xuICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICAvKipcbiAgICogSlNPTiBTY2hlbWEgb2JqZWN0IGRlc2NyaWJpbmcgdGhlIHRvb2wncyBpbnB1dC5cbiAgICogQWx3YXlzIHByZXNlbnQg4oCUIHRoZSBNQ1Agc3BlYyByZXF1aXJlcyBpbnB1dFNjaGVtYSBldmVuIGZvciB0b29scyB3aXRoIG5vIHBhcmFtZXRlcnMuXG4gICAqIERlZmF1bHRzIHRvIGB7IHR5cGU6ICdvYmplY3QnLCBwcm9wZXJ0aWVzOiB7fSwgYWRkaXRpb25hbFByb3BlcnRpZXM6IGZhbHNlIH1gLlxuICAgKi9cbiAgaW5wdXRTY2hlbWE6IEpzb25TY2hlbWE7XG59XG5cbi8qKlxuICogRmxvd0NoYXJ0IGVucmljaGVkIHdpdGggZDMtc3R5bGUgcnVuIG1ldGhvZHMgYW5kIHNlbGYtZGVzY3JpYmluZyBvdXRwdXRzLlxuICpcbiAqIEV4dGVuZHMgYnVpbGRlci5GbG93Q2hhcnQgKHdoaWNoIGFscmVhZHkgY2FycmllcyBidWlsZFRpbWVTdHJ1Y3R1cmUsIGRlc2NyaXB0aW9uLFxuICogc3RhZ2VEZXNjcmlwdGlvbnMsIGlucHV0U2NoZW1hLCBvdXRwdXRTY2hlbWEsIG91dHB1dE1hcHBlcikgYW5kIGFkZHMgdGhlIHJ1bnRpbWVcbiAqIG1ldGhvZHMgYXR0YWNoZWQgYnkgbWFrZVJ1bm5hYmxlKCkuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVubmFibGVGbG93Q2hhcnQ8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiBleHRlbmRzIEZsb3dDaGFydDxUT3V0LCBUU2NvcGU+IHtcbiAgLyoqIEF0dGFjaCBhIHJlY29yZGVyIGZvciB0aGUgbmV4dCBydW4uIFJldHVybnMgYSBjaGFpbmFibGUgUnVuQ29udGV4dC4gKi9cbiAgcmVjb3JkZXIocjogUmVjb3JkZXIgfCBGbG93UmVjb3JkZXIpOiBSdW5Db250ZXh0PFRPdXQsIFRTY29wZT47XG4gIC8qKiBTZXQgcmVkYWN0aW9uIHBvbGljeSBmb3IgdGhlIG5leHQgcnVuLiBSZXR1cm5zIGEgY2hhaW5hYmxlIFJ1bkNvbnRleHQuICovXG4gIHJlZGFjdChwb2xpY3k6IFJlZGFjdGlvblBvbGljeSk6IFJ1bkNvbnRleHQ8VE91dCwgVFNjb3BlPjtcbiAgLyoqIEV4ZWN1dGUgdGhlIGNoYXJ0IGRpcmVjdGx5IChiYXJlIHJ1biwgbm8gcmVjb3JkZXJzKS4gKi9cbiAgcnVuKG9wdGlvbnM/OiBSdW5PcHRpb25zKTogUHJvbWlzZTxSdW5SZXN1bHQ+O1xuICAvKiogR2VuZXJhdGUgT3BlbkFQSSAzLjEgc3BlYyBmcm9tIGNoYXJ0IG1ldGFkYXRhICsgY29udHJhY3QuIENhY2hlZCBmb3Igbm8tb3B0aW9ucyBjYWxscy4gKi9cbiAgdG9PcGVuQVBJKG9wdGlvbnM/OiBDaGFydE9wZW5BUElPcHRpb25zKTogb2JqZWN0O1xuICAvKiogR2VuZXJhdGUgTUNQIHRvb2wgZGVzY3JpcHRpb24gZnJvbSBjaGFydCBtZXRhZGF0YS4gQ2FjaGVkLiAqL1xuICB0b01DUFRvb2woKTogTUNQVG9vbERlc2NyaXB0aW9uO1xuICAvKiogR2VuZXJhdGUgYSBNZXJtYWlkIGZsb3djaGFydCBkaWFncmFtIHN0cmluZyBmcm9tIHRoZSBjaGFydCdzIG5vZGUgZ3JhcGguICovXG4gIHRvTWVybWFpZCgpOiBzdHJpbmc7XG59XG5cbi8vIENhY2hlIGZvciBuby1vcHRpb25zIHRvT3BlbkFQSSgpIGNhbGxzIG9ubHkg4oCUIHBhcmFtZXRlcml6ZWQgY2FsbHMgYXJlIG5vdCBjYWNoZWRcbi8vIGJlY2F1c2UgZGlmZmVyZW50IG9wdGlvbnMgcHJvZHVjZSBkaWZmZXJlbnQgb3V0cHV0LlxuY29uc3Qgb3BlbkFQSUNhY2hlID0gbmV3IFdlYWtNYXA8Rmxvd0NoYXJ0LCBvYmplY3Q+KCk7XG5jb25zdCBtY3BDYWNoZSA9IG5ldyBXZWFrTWFwPEZsb3dDaGFydCwgTUNQVG9vbERlc2NyaXB0aW9uPigpO1xuXG4vKipcbiAqIEVucmljaCBhIEZsb3dDaGFydCB3aXRoIHJ1biArIGRlc2NyaWJlIG1ldGhvZHMuXG4gKiBDYWxsZWQgYnkgRmxvd0NoYXJ0QnVpbGRlci5idWlsZCgpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbWFrZVJ1bm5hYmxlPFRPdXQsIFRTY29wZT4oY2hhcnQ6IEZsb3dDaGFydDxUT3V0LCBUU2NvcGU+KTogUnVubmFibGVGbG93Q2hhcnQ8VE91dCwgVFNjb3BlPiB7XG4gIGNvbnN0IHJ1bm5hYmxlID0gY2hhcnQgYXMgUnVubmFibGVGbG93Q2hhcnQ8VE91dCwgVFNjb3BlPjtcblxuICBydW5uYWJsZS5yZWNvcmRlciA9IGZ1bmN0aW9uIChyOiBSZWNvcmRlciB8IEZsb3dSZWNvcmRlcik6IFJ1bkNvbnRleHQ8VE91dCwgVFNjb3BlPiB7XG4gICAgcmV0dXJuIG5ldyBSdW5Db250ZXh0KGNoYXJ0KS5yZWNvcmRlcihyKTtcbiAgfTtcblxuICBydW5uYWJsZS5yZWRhY3QgPSBmdW5jdGlvbiAocG9saWN5OiBSZWRhY3Rpb25Qb2xpY3kpOiBSdW5Db250ZXh0PFRPdXQsIFRTY29wZT4ge1xuICAgIHJldHVybiBuZXcgUnVuQ29udGV4dChjaGFydCkucmVkYWN0KHBvbGljeSk7XG4gIH07XG5cbiAgcnVubmFibGUucnVuID0gZnVuY3Rpb24gKG9wdGlvbnM/OiBSdW5PcHRpb25zKTogUHJvbWlzZTxSdW5SZXN1bHQ+IHtcbiAgICByZXR1cm4gbmV3IFJ1bkNvbnRleHQoY2hhcnQpLnJ1bihvcHRpb25zKTtcbiAgfTtcblxuICBydW5uYWJsZS50b09wZW5BUEkgPSBmdW5jdGlvbiAob3B0aW9ucz86IENoYXJ0T3BlbkFQSU9wdGlvbnMpOiBvYmplY3Qge1xuICAgIC8vIE9ubHkgY2FjaGUgbm8tb3B0aW9ucyBjYWxscyDigJQgcGFyYW1ldGVyaXplZCBjYWxscyB2YXJ5IGJ5IG9wdGlvbnNcbiAgICBpZiAoIW9wdGlvbnMpIHtcbiAgICAgIGNvbnN0IGNhY2hlZCA9IG9wZW5BUElDYWNoZS5nZXQoY2hhcnQpO1xuICAgICAgaWYgKGNhY2hlZCkgcmV0dXJuIGNhY2hlZDtcbiAgICB9XG5cbiAgICBjb25zdCBidWlsZGVyQ2hhcnQgPSBjaGFydCBhcyBhbnk7XG4gICAgY29uc3QgdGl0bGUgPSBvcHRpb25zPy50aXRsZSA/PyBidWlsZGVyQ2hhcnQuZGVzY3JpcHRpb24/LnNwbGl0KCdcXG4nKVswXSA/PyAnQVBJJztcbiAgICBjb25zdCB2ZXJzaW9uID0gb3B0aW9ucz8udmVyc2lvbiA/PyAnMS4wLjAnO1xuICAgIC8vIFVzZSByb290LmlkICh0aGUgZXhwbGljaXQgbWFjaGluZS1yZWFkYWJsZSBpZCkgYXMgdGhlIHBhdGggc2VnbWVudCwgc2FuaXRpemVkXG4gICAgY29uc3QgcmF3SWQgPSBidWlsZGVyQ2hhcnQucm9vdD8uaWQgPz8gJ2V4ZWN1dGUnO1xuICAgIGNvbnN0IHBhdGggPSBvcHRpb25zPy5wYXRoID8/IGAvJHtzbHVnaWZ5KHJhd0lkKX1gO1xuXG4gICAgY29uc3Qgc3BlYzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7XG4gICAgICBvcGVuYXBpOiAnMy4xLjAnLFxuICAgICAgaW5mbzogeyB0aXRsZSwgdmVyc2lvbiwgZGVzY3JpcHRpb246IG9wdGlvbnM/LmRlc2NyaXB0aW9uID8/IGJ1aWxkZXJDaGFydC5kZXNjcmlwdGlvbiB9LFxuICAgICAgcGF0aHM6IHtcbiAgICAgICAgW3BhdGhdOiB7XG4gICAgICAgICAgcG9zdDoge1xuICAgICAgICAgICAgc3VtbWFyeTogdGl0bGUsXG4gICAgICAgICAgICBkZXNjcmlwdGlvbjogYnVpbGRlckNoYXJ0LmRlc2NyaXB0aW9uLFxuICAgICAgICAgICAgLi4uKGJ1aWxkZXJDaGFydC5pbnB1dFNjaGVtYVxuICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgIHJlcXVlc3RCb2R5OiB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRlbnQ6IHsgJ2FwcGxpY2F0aW9uL2pzb24nOiB7IHNjaGVtYTogbm9ybWFsaXplU2NoZW1hKGJ1aWxkZXJDaGFydC5pbnB1dFNjaGVtYSkgfSB9LFxuICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIDoge30pLFxuICAgICAgICAgICAgcmVzcG9uc2VzOiB7XG4gICAgICAgICAgICAgICcyMDAnOiB7XG4gICAgICAgICAgICAgICAgZGVzY3JpcHRpb246ICdTdWNjZXNzJyxcbiAgICAgICAgICAgICAgICAuLi4oYnVpbGRlckNoYXJ0Lm91dHB1dFNjaGVtYVxuICAgICAgICAgICAgICAgICAgPyB7IGNvbnRlbnQ6IHsgJ2FwcGxpY2F0aW9uL2pzb24nOiB7IHNjaGVtYTogbm9ybWFsaXplU2NoZW1hKGJ1aWxkZXJDaGFydC5vdXRwdXRTY2hlbWEpIH0gfSB9XG4gICAgICAgICAgICAgICAgICA6IHt9KSxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgfTtcblxuICAgIGlmICghb3B0aW9ucykgb3BlbkFQSUNhY2hlLnNldChjaGFydCwgc3BlYyk7XG4gICAgcmV0dXJuIHNwZWM7XG4gIH07XG5cbiAgcnVubmFibGUudG9NZXJtYWlkID0gZnVuY3Rpb24gKCk6IHN0cmluZyB7XG4gICAgY29uc3QgbGluZXM6IHN0cmluZ1tdID0gWydmbG93Y2hhcnQgVEQnXTtcbiAgICBjb25zdCBpZE9mID0gKGs6IHN0cmluZykgPT4gKGsgfHwgJycpLnJlcGxhY2UoL1teYS16QS1aMC05X10vZywgJ18nKSB8fCAnXyc7XG4gICAgY29uc3QgdmlzaXRlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGNvbnN0IHdhbGsgPSAobjogU3RhZ2VOb2RlKSA9PiB7XG4gICAgICBjb25zdCBuaWQgPSBpZE9mKG4uaWQpO1xuICAgICAgaWYgKHZpc2l0ZWQuaGFzKG5pZCkpIHJldHVybjtcbiAgICAgIHZpc2l0ZWQuYWRkKG5pZCk7XG4gICAgICBsaW5lcy5wdXNoKGAke25pZH1bXCIke24ubmFtZX1cIl1gKTtcbiAgICAgIGZvciAoY29uc3QgYyBvZiBuLmNoaWxkcmVuIHx8IFtdKSB7XG4gICAgICAgIGNvbnN0IGNpZCA9IGlkT2YoYy5pZCk7XG4gICAgICAgIGxpbmVzLnB1c2goYCR7bmlkfSAtLT4gJHtjaWR9YCk7XG4gICAgICAgIHdhbGsoYyk7XG4gICAgICB9XG4gICAgICBpZiAobi5uZXh0KSB7XG4gICAgICAgIGNvbnN0IG1pZCA9IGlkT2Yobi5uZXh0LmlkKTtcbiAgICAgICAgbGluZXMucHVzaChgJHtuaWR9IC0tPiAke21pZH1gKTtcbiAgICAgICAgd2FsayhuLm5leHQpO1xuICAgICAgfVxuICAgIH07XG4gICAgd2FsayhjaGFydC5yb290KTtcbiAgICByZXR1cm4gbGluZXMuam9pbignXFxuJyk7XG4gIH07XG5cbiAgcnVubmFibGUudG9NQ1BUb29sID0gZnVuY3Rpb24gKCk6IE1DUFRvb2xEZXNjcmlwdGlvbiB7XG4gICAgY29uc3QgY2FjaGVkID0gbWNwQ2FjaGUuZ2V0KGNoYXJ0KTtcbiAgICBpZiAoY2FjaGVkKSByZXR1cm4gY2FjaGVkO1xuXG4gICAgY29uc3QgYnVpbGRlckNoYXJ0ID0gY2hhcnQgYXMgYW55O1xuICAgIC8vIFVzZSByb290LmlkIChleHBsaWNpdCBtYWNoaW5lLXJlYWRhYmxlIGlkKSwgc2FuaXRpemVkIHRvIE1DUCBuYW1lIGNoYXJhY3RlciBhbGxvd2xpc3RcbiAgICBjb25zdCBuYW1lID0gc2FuaXRpemVNQ1BOYW1lKGJ1aWxkZXJDaGFydC5yb290Py5pZCA/PyAnZXhlY3V0ZScpO1xuICAgIGNvbnN0IGRlc2NyaXB0aW9uID0gYnVpbGRlckNoYXJ0LmRlc2NyaXB0aW9uIHx8IGBFeGVjdXRlIHRoZSAke25hbWV9IGZsb3djaGFydGA7XG5cbiAgICAvLyBNQ1Agc3BlYyByZXF1aXJlcyBpbnB1dFNjaGVtYSB0byBhbHdheXMgYmUgcHJlc2VudC5cbiAgICAvLyBXaGVuIG5vIGNvbnRyYWN0IGlzIGRlZmluZWQsIHVzZSB0aGUgcmVjb21tZW5kZWQgbm8tcGFyYW1ldGVyIGZvcm0uXG4gICAgY29uc3QgaW5wdXRTY2hlbWE6IEpzb25TY2hlbWEgPSBidWlsZGVyQ2hhcnQuaW5wdXRTY2hlbWFcbiAgICAgID8gbm9ybWFsaXplU2NoZW1hKGJ1aWxkZXJDaGFydC5pbnB1dFNjaGVtYSlcbiAgICAgIDogeyB0eXBlOiAnb2JqZWN0JywgcHJvcGVydGllczoge30sIGFkZGl0aW9uYWxQcm9wZXJ0aWVzOiBmYWxzZSB9O1xuXG4gICAgY29uc3QgdG9vbDogTUNQVG9vbERlc2NyaXB0aW9uID0geyBuYW1lLCBkZXNjcmlwdGlvbiwgaW5wdXRTY2hlbWEgfTtcblxuICAgIG1jcENhY2hlLnNldChjaGFydCwgdG9vbCk7XG4gICAgcmV0dXJuIHRvb2w7XG4gIH07XG5cbiAgcmV0dXJuIHJ1bm5hYmxlO1xufVxuXG4vKipcbiAqIFNhbml0aXplIGEgc3RyaW5nIHRvIGNvbmZvcm0gdG8gdGhlIE1DUCB0b29sIG5hbWUgY2hhcmFjdGVyIGFsbG93bGlzdDpcbiAqIFtBLVphLXowLTlfXFwtLl0g4oCUIGFueSBvdGhlciBjaGFyYWN0ZXIgaXMgcmVwbGFjZWQgd2l0aCB1bmRlcnNjb3JlLlxuICogVHJpbXMgbGVhZGluZy90cmFpbGluZyB1bmRlcnNjb3JlcyBpbnRyb2R1Y2VkIGJ5IHJlcGxhY2VtZW50LlxuICovXG5mdW5jdGlvbiBzYW5pdGl6ZU1DUE5hbWUoaWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBpZC5yZXBsYWNlKC9bXkEtWmEtejAtOV9cXC0uXS9nLCAnXycpLnJlcGxhY2UoL15fK3xfKyQvZywgJycpIHx8ICdleGVjdXRlJztcbn1cblxuLyoqXG4gKiBTbHVnaWZ5IGEgc3RyaW5nIGZvciB1c2UgYXMgYW4gT3BlbkFQSSBwYXRoIHNlZ21lbnQuXG4gKiBMb3dlcmNhc2VzIGFuZCByZXBsYWNlcyBub24tYWxwaGFudW1lcmljIHJ1bnMgd2l0aCBoeXBoZW5zLlxuICovXG5mdW5jdGlvbiBzbHVnaWZ5KGlkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gKFxuICAgIGlkXG4gICAgICAudG9Mb3dlckNhc2UoKVxuICAgICAgLnJlcGxhY2UoL1teYS16MC05XSsvZywgJy0nKVxuICAgICAgLnJlcGxhY2UoL14tfC0kL2csICcnKSB8fCAnZXhlY3V0ZSdcbiAgKTtcbn1cbiJdfQ==