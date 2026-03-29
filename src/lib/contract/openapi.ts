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

import type { FlowChart } from '../builder/types.js';
import type { FlowChartContract, JsonSchema, OpenAPIOperation, OpenAPIOptions, OpenAPISpec } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function slugify(name: string): string {
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
export function generateOpenAPI(contract: FlowChartContract, options?: OpenAPIOptions): OpenAPISpec {
  const { chart, inputSchema, outputSchema } = contract;
  const version = options?.version ?? '1.0.0';
  const basePath = options?.basePath ?? '/';
  const method = options?.method ?? 'post';

  const rootName = chart.root.name;
  const operationId = slugify(rootName);
  const path = `${basePath === '/' ? '' : basePath}/${operationId}`;

  // Description was built incrementally during FlowChartBuilder.build() — read it directly.
  const fullDescription = chart.description;

  // Build schemas for components
  const schemas: Record<string, JsonSchema> = {};
  const inputRef = `${rootName}Input`;
  const outputRef = `${rootName}Output`;

  if (inputSchema) schemas[inputRef] = inputSchema;
  if (outputSchema) schemas[outputRef] = outputSchema;

  // Build operation
  const operation: OpenAPIOperation = {
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

  const spec: OpenAPISpec = {
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
