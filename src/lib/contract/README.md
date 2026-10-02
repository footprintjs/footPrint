# contract/ — a chart's I/O boundary, as JSON Schema and OpenAPI

What a chart takes in and gives out, written down so a person, an OpenAPI client or an LLM tool-caller can read it: `normalizeSchema` / `zodToJsonSchema` turn a Zod schema or a raw JSON Schema into one `JsonSchema` shape, `generateOpenAPI` writes the OpenAPI 3.1 document, and `defineContract` binds schemas and an output mapper to a built chart. It does not own the builder's `.contract()` call (`builder/`) or the `toOpenAPI()` / `toMCPTool()` methods a built chart carries (`runner/RunnableChart.ts`, which only borrows `normalizeSchema`), and it never validates data — that is `schema/`.

**The laws.**

- *Zod is detected, never imported.* `schema.ts` asks `schema/detect.ts` and converts at contract-creation time, so a consumer without zod loads this folder fine.
- *A compiled chart is shared, so a contract never edits it.* `defineContract` returns a prototype-linked view (`Object.create(chart)`) that shadows only `inputSchema`, `outputSchema` and `outputMapper` — two contracts over one chart each see their own, and the chart stays untouched (`test/lib/contract/unit/defineContract.test.ts`). Do not spread, `Object.keys` or `JSON.stringify` that view — it only holds the shadowed fields — read it by name.
- *The OpenAPI description is read, not re-derived.* `generateOpenAPI` uses `chart.description`, which the builder assembles stage by stage, and never walks `buildTimeStructure`, so a deep or cyclic structure cannot overflow the stack (`test/lib/contract/security/openapi-walk-depth.test.ts`).

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

That `.contract()` + `chart.toOpenAPI()` pair is the public door. `defineContract` and `generateOpenAPI` are deliberately exported from no entry point (`test/api-conformance/v2-api-contract.test.ts`); `normalizeSchema` and `zodToJsonSchema` are on `footprintjs/advanced`, the contract types on `footprintjs`.

Layer L7 (`scripts/layering.config.cjs`): imports `builder/types` as types only and `schema/detect` (L0); `runner/` imports it. See also [`../README.md`](../README.md) and the contracts guide, [`docs/guides/contracts.md`](../../../docs/guides/contracts.md).
