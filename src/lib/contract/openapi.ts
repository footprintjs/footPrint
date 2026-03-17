/**
 * contract/openapi.ts — OpenAPI 3.1 spec generator.
 *
 * Generates an OpenAPI spec from a FlowChartContract by combining:
 * - chart.description → operation description
 * - chart.stageDescriptions → step-by-step detail
 * - inputSchema → requestBody
 * - outputSchema → response
 * - chart.buildTimeStructure → operation metadata (branches, forks, etc.)
 */

import type { FlowChart, SerializedPipelineStructure } from '../builder/types.js';
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

function buildDescription(chart: FlowChart): string {
  // Walk buildTimeStructure to produce a detailed step-by-step description
  // that includes decider branches, parallel forks, etc.
  const lines: string[] = [];
  let step = 0;

  const walk = (node: SerializedPipelineStructure) => {
    step++;
    const desc = node.description ? ` — ${node.description}` : '';

    if (node.hasDecider && node.branchIds) {
      lines.push(`${step}. ${node.name}${desc} — Decides between: ${node.branchIds.join(', ')}`);
    } else if (node.children && node.children.length > 0 && !node.hasDecider) {
      const childNames = node.children.map((c) => c.name).join(', ');
      lines.push(`${step}. ${node.name}${desc} (parallel: ${childNames})`);
    } else {
      lines.push(`${step}. ${node.name}${desc}`);
    }

    if (node.children) {
      for (const child of node.children) walk(child);
    }
    if (node.next) walk(node.next);
  };

  walk(chart.buildTimeStructure);
  return `FlowChart: ${chart.root.name}\nSteps:\n${lines.join('\n')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export function generateOpenAPI(contract: FlowChartContract, options?: OpenAPIOptions): OpenAPISpec {
  const { chart, inputSchema, outputSchema } = contract;
  const version = options?.version ?? '1.0.0';
  const basePath = options?.basePath ?? '/';
  const method = options?.method ?? 'post';

  const rootName = chart.root.name;
  const operationId = slugify(rootName);
  const path = `${basePath === '/' ? '' : basePath}/${operationId}`;

  const fullDescription = buildDescription(chart);

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
