# contract/ — a chart's I/O boundary, as JSON Schema and OpenAPI

What a chart takes in and gives out, written down so a person, an OpenAPI client or an LLM tool-caller can read it. `normalizeSchema` / `zodToJsonSchema` turn a Zod schema or a raw JSON Schema into one `JsonSchema` shape; `defineContract` binds schemas and an output mapper to a built chart, and `generateOpenAPI` writes an OpenAPI 3.1 document from that. Only the first pair is used outside this folder (`runner/RunnableChart.ts` calls `normalizeSchema`; `footprintjs/advanced` re-exports both): **no file outside this folder calls `defineContract` or `generateOpenAPI`** (the first calls the second) — tests reach them, nothing else does. The public route is the builder's `.contract()` plus the `toOpenAPI()` / `toMCPTool()` methods a built chart carries; those live in `runner/RunnableChart.ts`, which has its own, separate OpenAPI generator. This folder never validates data — that is `schema/`.

**The laws.**

- *Zod is detected, never imported.* `schema.ts` asks `schema/detect.ts` and converts at contract-creation time, so a consumer without zod loads this folder fine.
- *`defineContract` never edits the chart it is given.* It returns a `FlowChartContract` — `{ chart, inputSchema, outputSchema, outputMapper, toOpenAPI }`, the two schemas already normalized to JSON Schema — and only `contract.chart` is the prototype-linked view (`Object.create(chart)`) that shadows `inputSchema`, `outputSchema` and `outputMapper`. Two contracts over one chart each see their own and the chart stays untouched (`test/lib/contract/unit/defineContract.test.ts`); do not spread, `Object.keys` or `JSON.stringify` that `chart` view — it holds only the shadowed fields — read it by name.
- *`generateOpenAPI` reads the description; it does not re-derive it.* It uses `chart.description`, which the builder assembles stage by stage, and never walks `buildTimeStructure`, so a deep or cyclic structure cannot overflow the stack (`test/lib/contract/security/openapi-walk-depth.test.ts`, which drives `generateOpenAPI` directly). The public `chart.toOpenAPI()` also reads `chart.description`, but it is separate code in `runner/RunnableChart.ts` that this test does not cover.

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

That `.contract()` + `chart.toOpenAPI()` pair is the public door. No entry point exports `defineContract` or `generateOpenAPI` today; `test/api-conformance/v2-api-contract.test.ts` pins that for the root barrel `footprintjs` only. `footprintjs/advanced` exports `normalizeSchema` and `zodToJsonSchema`, and the contract types (`FlowChartContract`, `JsonSchema`, `OpenAPISpec`, …) are on `footprintjs`.

Layer L7 (`scripts/layering.config.cjs`): imports `builder/types` as types only and `schema/detect` (L0); `runner/` imports it. See also [`../README.md`](../README.md) and the contracts guide, [`docs/guides/contracts.md`](../../../docs/guides/contracts.md).
