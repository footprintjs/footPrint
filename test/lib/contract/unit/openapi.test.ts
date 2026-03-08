import { flowChart } from '../../../../src/lib/builder/FlowChartBuilder';
import { defineContract } from '../../../../src/lib/contract/defineContract';

describe('OpenAPI generation', () => {
  it('generates spec with descriptions from chart.description', () => {
    const chart = flowChart('ProcessLoan', () => {}, undefined, 'Receive application')
      .addFunction('Assess', () => {}, undefined, 'Assess risk')
      .addDeciderFunction('Decide', () => 'approved')
      .addFunctionBranch('approved', 'Approve', () => {})
      .addFunctionBranch('rejected', 'Reject', () => {})
      .end()
      .build();

    const contract = defineContract(chart, {
      inputSchema: {
        type: 'object',
        properties: {
          applicantName: { type: 'string' },
          creditScore: { type: 'number' },
        },
        required: ['applicantName', 'creditScore'],
      },
      outputSchema: {
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['approved', 'rejected'] },
        },
      },
    });

    const spec = contract.toOpenAPI();

    // Structure
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('ProcessLoan');
    expect(spec.info.description).toContain('ProcessLoan');

    // Paths
    const op = spec.paths['/processloan']?.post;
    expect(op).toBeDefined();
    expect(op.operationId).toBe('processloan');
    expect(op.summary).toBe('ProcessLoan');

    // Request body references component schema
    expect(op.requestBody?.content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ProcessLoanInput',
    });

    // Response references component schema
    const resp200 = op.responses['200'];
    expect(resp200.content?.['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ProcessLoanOutput',
    });

    // Component schemas present
    expect(spec.components?.schemas?.ProcessLoanInput).toEqual({
      type: 'object',
      properties: {
        applicantName: { type: 'string' },
        creditScore: { type: 'number' },
      },
      required: ['applicantName', 'creditScore'],
    });
  });

  it('generates spec without schemas', () => {
    const chart = flowChart('Simple', () => {}).build();
    const contract = defineContract(chart, {});
    const spec = contract.toOpenAPI();

    expect(spec.paths['/simple']?.post).toBeDefined();
    expect(spec.paths['/simple']?.post.requestBody).toBeUndefined();
    expect(spec.components).toBeUndefined();
  });

  it('includes decider branches in description', () => {
    const chart = flowChart('Router', () => {})
      .addDeciderFunction('Route', () => 'a', undefined, 'Route the request')
      .addFunctionBranch('a', 'HandleA', () => {})
      .addFunctionBranch('b', 'HandleB', () => {})
      .end()
      .build();

    const contract = defineContract(chart, {});
    const spec = contract.toOpenAPI();

    expect(spec.info.description).toContain('Decides between');
  });

  it('includes parallel children in description', () => {
    const chart = flowChart('Fetch', () => {})
      .addListOfFunction([
        { id: 'a', name: 'ParseHTML', fn: () => {} },
        { id: 'b', name: 'ParseCSS', fn: () => {} },
      ])
      .addFunction('Merge', () => {})
      .build();

    const contract = defineContract(chart, {});
    const spec = contract.toOpenAPI();

    expect(spec.info.description).toContain('parallel');
    expect(spec.info.description).toContain('ParseHTML');
    expect(spec.info.description).toContain('ParseCSS');
  });
});
