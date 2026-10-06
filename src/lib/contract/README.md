# contract/ — schema normalization for self-describing charts

`normalizeSchema` / `zodToJsonSchema` turn a Zod schema or raw JSON Schema into one `JsonSchema` shape. The builder's `.contract()` attaches input/output schemas and an output mapper; `runner/RunnableChart.ts` owns the built chart's `toOpenAPI()` and `toMCPTool()` methods and calls this folder to normalize their schemas. There is one OpenAPI generator, on that public chart route. This folder neither generates documents nor validates data — validation belongs to `schema/`.

**The laws.**

- *Zod is detected, never imported.* `schema.ts` asks `schema/detect.ts`; a consumer without Zod can load this folder. Normalization happens when the chart is described, not when `.contract()` attaches its schemas.
- *Schema attachment has one owner.* `builder/FlowChartBuilder.ts · contract` stores the original schemas and mapper. There is no second factory wrapping an already-built chart.
- *OpenAPI reads the prepared description, never a graph.* `runner/RunnableChart.ts · makeRunnable` reads `chart.description`, assembled by the builder. Its description/deep-structure checks live under `test/lib/runner/security/` and call the public chart method.

```typescript
import { flowChart } from 'footprintjs';

const chart = flowChart<{ greeting: string }>('Greet', (scope) => { scope.greeting = 'Hello'; }, 'greet', {
  description: 'Say hello to a caller',
})
  .contract({
    input: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    output: { type: 'object', properties: { greeting: { type: 'string' } } },
    mapper: (scope) => ({ greeting: scope.greeting }),
  })
  .build();

chart.toOpenAPI({ title: 'Greeter', path: '/greet' }); // OpenAPI 3.1, schemas inlined
chart.toMCPTool(); // { name: 'greet', description, inputSchema } — the shape an MCP client expects
```

That `.contract()` + `chart.toOpenAPI()` pair is the public door. `footprintjs/advanced` exports `normalizeSchema` and `zodToJsonSchema`; `JsonSchema` is exported from `footprintjs`. The chart's OpenAPI options type is `ChartOpenAPIOptions`.

Layer L7 (`scripts/layering.config.cjs`): imports `schema/detect` (L0); the retained legacy declarations import `builder/types` as types only. `runner/` imports schema normalization. See also [`../README.md`](../README.md) and the [contracts guide](../../../docs/guides/contracts.md).
