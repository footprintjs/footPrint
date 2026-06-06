# Contract & OpenAPI

Define I/O schemas on your flowchart and auto-generate OpenAPI 3.1 specs. Schemas can be Zod objects or raw JSON Schema — Zod is an optional peer dependency with zero bundle impact if not used.

---

## Defining a Contract

```typescript
import { flowChart } from 'footprintjs';
import { z } from 'zod';

const chart = flowChart('ProcessLoan', receiveFn, 'receive')
  .addFunction('Assess', assessFn, 'assess')
  .addDeciderFunction('Decide', deciderFn, 'decide')
    .addFunctionBranch('approved', 'Approve', approveFn)
    .addFunctionBranch('rejected', 'Reject', rejectFn)
    .end()
  .contract({
    input: z.object({
      applicantName: z.string(),
      creditScore: z.number(),
    }),
    output: z.object({
      decision: z.enum(['approved', 'rejected']),
      reason: z.string(),
    }),
    mapper: (scope) => ({
      decision: scope.decision as string,
      reason: scope.reason as string,
    }),
  })
  .build();
```

### What `.contract()` gives you

- **`chart.inputSchema`** — The input schema you passed (raw Zod or JSON Schema; normalized to JSON Schema when consumed)
- **`chart.outputSchema`** — The output schema you passed
- **`chart.outputMapper`** — Function to extract output from scope
- **`chart.toOpenAPI(options?)`** — Generate OpenAPI 3.1 spec
- **`chart.toMCPTool()`** — Generate a Model Context Protocol tool description (`{ name, description, inputSchema }`)

---

## OpenAPI Generation

`chart.toOpenAPI(options?)` is attached to the compiled chart by `.build()`. Options are `ChartOpenAPIOptions`:

```typescript
const spec = chart.toOpenAPI({
  title: 'Loan API',   // defaults to the first line of chart.description
  version: '1.0.0',    // defaults to '1.0.0'
  description: '...',  // defaults to chart.description
  path: '/process',    // defaults to `/${slug(root.id)}`
});
```

Produces an OpenAPI 3.1 spec with the input/output schemas **inlined** under each operation:

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "FlowChart: ProcessLoan",
    "version": "1.0.0",
    "description": "FlowChart: ProcessLoan\nSteps:\n1. ProcessLoan\n2. Assess\n3. Decide — Decides between: approved, rejected"
  },
  "paths": {
    "/receive": {
      "post": {
        "summary": "FlowChart: ProcessLoan",
        "description": "FlowChart: ProcessLoan\nSteps:\n...",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": { "type": "object", "properties": { ... } }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Success",
            "content": {
              "application/json": {
                "schema": { "type": "object", "properties": { ... } }
              }
            }
          }
        }
      }
    }
  }
}
```

The `description` is assembled incrementally by the builder as each stage is added (no
post-execution walk) and includes:
- Sequential step numbering (`Steps:` block)
- Per-stage descriptions (if provided)
- Decider branch IDs (`"Decides between: approved, rejected"`)
- Parallel fan-out children (`"Runs in parallel: ParseHTML, ParseCSS"`)

---

## Builder-Level Contract

Set all I/O schemas in a single `.contract()` call on the builder:

```typescript
const chart = flowChart('Greet', greetFn, 'greet')
  .contract({
    input: z.object({ name: z.string() }),
    output: z.object({ greeting: z.string() }),
    mapper: (scope) => ({ greeting: scope.message as string }),
  })
  .build();

// chart.inputSchema, chart.outputSchema, chart.outputMapper are set
// chart.toOpenAPI({ version: '1.0.0' }) generates OpenAPI spec
```

---

## Zod vs JSON Schema

### Zod (optional peer dependency)

```typescript
const chart = flowChart('Process', processFn, 'process')
  .contract({
    input: z.object({
      applicantName: z.string(),
      creditScore: z.number().describe('FICO score'),
      email: z.string().optional(),
    }),
  })
  .build();
```

Supported Zod types: `string`, `number`, `boolean`, `literal`, `enum`, `array`, `object` (with required/optional fields), `nullable`, `union`, `record`, `any`, `default`, `describe`, `transform` (unwraps to input schema).

### Raw JSON Schema

```typescript
const chart = flowChart('Process', processFn, 'process')
  .contract({
    input: {
      type: 'object',
      properties: {
        applicantName: { type: 'string' },
        creditScore: { type: 'number', description: 'FICO score' },
      },
      required: ['applicantName', 'creditScore'],
    },
  })
  .build();
```

### Detection

FootPrint duck-types Zod schemas by checking for `.def` (Zod v4) or `._def` (Zod v3). If detected, the schema is auto-converted to JSON Schema. Otherwise, it passes through as raw JSON Schema.

Conversion happens automatically inside `.contract()` (and when `chart.toOpenAPI()` / `chart.toMCPTool()` read the schemas), so you never have to convert by hand — `chart.inputSchema` / `chart.outputSchema` always normalize to JSON Schema at the point they're consumed.

---

For architecture details, see [src/lib/contract/](../../src/lib/contract/).
