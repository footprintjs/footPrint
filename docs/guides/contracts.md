# Contract & OpenAPI

Define I/O schemas on your flowchart and auto-generate OpenAPI 3.1 specs. Schemas can be Zod objects or raw JSON Schema — Zod is an optional peer dependency with zero bundle impact if not used.

---

## Defining a Contract

```typescript
import { flowChart, defineContract } from 'footprintjs';
import { z } from 'zod';

const chart = flowChart('ProcessLoan', receiveFn)
  .addFunction('Assess', assessFn)
  .addDeciderFunction('Decide', deciderFn)
    .addFunctionBranch('approved', 'Approve', approveFn)
    .addFunctionBranch('rejected', 'Reject', rejectFn)
    .end()
  .build();

const contract = defineContract(chart, {
  inputSchema: z.object({
    applicantName: z.string(),
    creditScore: z.number(),
  }),
  outputSchema: z.object({
    decision: z.enum(['approved', 'rejected']),
    reason: z.string(),
  }),
  outputMapper: (scope) => ({
    decision: scope.decision as string,
    reason: scope.reason as string,
  }),
});
```

### What `defineContract` gives you

- **`contract.chart`** — The original FlowChart
- **`contract.inputSchema`** — Normalized JSON Schema (Zod auto-converted)
- **`contract.outputSchema`** — Normalized JSON Schema
- **`contract.outputMapper`** — Function to extract output from scope
- **`contract.toOpenAPI(options?)`** — Generate OpenAPI 3.1 spec

---

## OpenAPI Generation

```typescript
const spec = contract.toOpenAPI({ version: '1.0.0', basePath: '/api' });
```

Produces a complete OpenAPI 3.1 spec:

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "ProcessLoan",
    "version": "1.0.0",
    "description": "FlowChart: ProcessLoan\nSteps:\n1. ProcessLoan\n2. Assess\n3. Decide — Decides between: approved, rejected"
  },
  "paths": {
    "/api/processloan": {
      "post": {
        "operationId": "processloan",
        "summary": "ProcessLoan",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": { "$ref": "#/components/schemas/ProcessLoanInput" }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Successful execution",
            "content": {
              "application/json": {
                "schema": { "$ref": "#/components/schemas/ProcessLoanOutput" }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "ProcessLoanInput": { "type": "object", "properties": { ... } },
      "ProcessLoanOutput": { "type": "object", "properties": { ... } }
    }
  }
}
```

The description auto-walks the flowchart's `buildTimeStructure` to include:
- Sequential step numbering
- Per-stage descriptions (if provided)
- Decider branch IDs (`"Decides between: approved, rejected"`)
- Parallel fork children (`"(parallel: ParseHTML, ParseCSS)"`)

---

## Builder-Level Schemas

Schemas can also be set at build time instead of via `defineContract`:

```typescript
const chart = flowChart('Greet', greetFn)
  .setInputSchema(z.object({ name: z.string() }))
  .setOutputSchema(z.object({ greeting: z.string() }))
  .setOutputMapper((scope) => ({ greeting: scope.message as string }))
  .build();

// chart.inputSchema, chart.outputSchema, chart.outputMapper are set
const contract = defineContract(chart, {});  // picks up from chart
```

---

## Zod vs JSON Schema

### Zod (optional peer dependency)

```typescript
const contract = defineContract(chart, {
  inputSchema: z.object({
    applicantName: z.string(),
    creditScore: z.number().describe('FICO score'),
    email: z.string().optional(),
  }),
});
```

Supported Zod types: `string`, `number`, `boolean`, `literal`, `enum`, `array`, `object` (with required/optional fields), `nullable`, `union`, `record`, `any`, `default`, `describe`, `transform` (unwraps to input schema).

### Raw JSON Schema

```typescript
const contract = defineContract(chart, {
  inputSchema: {
    type: 'object',
    properties: {
      applicantName: { type: 'string' },
      creditScore: { type: 'number', description: 'FICO score' },
    },
    required: ['applicantName', 'creditScore'],
  },
});
```

### Detection

FootPrint duck-types Zod schemas by checking for `.def.type` (Zod v4) or `._def.typeName` (Zod v3). If detected, auto-converts to JSON Schema via `zodToJsonSchema()`. Otherwise, passes through as raw JSON Schema.

You can also convert manually:

```typescript
import { zodToJsonSchema, normalizeSchema } from 'footprintjs';

const jsonSchema = zodToJsonSchema(z.object({ name: z.string() }));
// { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }

const normalized = normalizeSchema(anySchema);
// Detects Zod → converts; JSON Schema → passes through
```

---

For architecture details, see [src/lib/contract/](../../src/lib/contract/).
