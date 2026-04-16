---
name: Contract & OpenAPI
group: Features
guide: https://footprintjs.github.io/footPrint/guides/features/contract/
---

# Contract & OpenAPI — Self-Describing API

Declare a `.contract({ input, output })` on any flowchart. You get:

- **Runtime input validation** — malformed calls rejected before execution.
- **Compile-time type inference** — `scope.$getArgs()` is typed from the schema.
- **OpenAPI 3.1 spec** via `chart.toOpenAPI()` — copy/paste into your API gateway.
- **MCP tool description** via `chart.toMCPTool()` — LLMs know how to call it.

**One declaration, three artifacts.** No sync drift.

## The pattern

```typescript
import { z } from 'zod';

const chart = flowChart('ReceiveOrder', async (scope) => {
  const { quantity, unitPrice } = scope.$getArgs<{ quantity: number; unitPrice: number }>();
  // ...
}, 'receive-order')
  .addFunction(...)
  .contract({
    input: z.object({
      quantity: z.number().int().positive(),
      unitPrice: z.number().positive(),
    }),
    output: z.object({
      orderId: z.string(),
      total: z.number(),
      status: z.enum(['confirmed', 'pending-review', 'rejected']),
    }),
  })
  .build();

// Now:
chart.toOpenAPI();  // OpenAPI 3.1 spec
chart.toMCPTool();  // MCP tool description for Claude / Cursor / etc.
```

## Zod or JSON Schema — both work

Prefer Zod for new code (type inference). Use JSON Schema when the source lives elsewhere (database, config file):

```typescript
.contract({
  input: { type: 'object', properties: { userId: { type: 'string' } } },
  output: { type: 'object', properties: { ok: { type: 'boolean' } } },
})
```

## What `toOpenAPI()` produces

```json
{
  "openapi": "3.1.0",
  "info": { "title": "FlowChart: ReceiveOrder", "version": "1.0.0" },
  "paths": {
    "/receive-order": {
      "post": {
        "summary": "FlowChart: ReceiveOrder",
        "requestBody": { ... },      // from input contract
        "responses": { "200": { ... } }  // from output contract
      }
    }
  }
}
```

Drop this into Swagger UI, Stoplight, any API gateway — you have docs for free.

## What `toMCPTool()` produces

```json
{
  "name": "receive-order",
  "description": "FlowChart: ReceiveOrder...",
  "inputSchema": { ... }
}
```

This is the **Model Context Protocol** tool descriptor. An LLM with tool-calling support (Claude, GPT, etc.) can:
1. Read this description.
2. Decide when to call the flow.
3. Provide valid arguments (schema-validated).

Your flowchart is now an LLM tool — automatically.

## Runtime validation

Inputs are validated before the first stage runs:

```typescript
await executor.run({ input: { quantity: -5, unitPrice: 100 } });
// Throws: InputValidationError — quantity must be positive
```

No need to write validation inside stages. The contract is the guard.

## Key API

- `.contract({ input, output })` — declare I/O schemas on the builder.
- `chart.toOpenAPI(options?)` — REST contract.
- `chart.toMCPTool()` — LLM tool descriptor.
- `scope.$getArgs<T>()` — typed accessor for input inside stages.

## Related

- **[MCP Tool view](https://footprintjs.github.io/footprint-playground/samples/contract-openapi)** — see the live OpenAPI and MCP output.
- **[Redaction](./12-redaction.md)** — scrub sensitive fields before OpenAPI generation.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/features/contract/)** — all contract options, Zod patterns, and multi-endpoint charts.
