# Execution Patterns

FootPrint supports four main static execution patterns, plus a dynamic pattern for runtime-determined children.

| Pattern | Children | Determined At |
|---------|----------|---------------|
| [Linear](#1-linear-pattern) | 0 | Build time |
| [Fork](#2-fork-pattern-parallel) | All | Build time |
| [Decider](#3-decider-pattern-single-choice) | 1 | Build time |
| [Selector](#4-selector-pattern-multi-choice) | 0-N | Build time |
| [Dynamic](./DYNAMIC_CHILDREN.md) | 0-N | Runtime |

## 1. Linear Pattern

Sequential execution: `A → B → C`

```typescript
const builder = new FlowChartBuilder()
  .start('ValidateInput', validateFn)
  .addFunction('ProcessData', processFn)
  .addFunction('SaveResult', saveFn);
```

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ValidateInput │────▶│ ProcessData  │────▶│  SaveResult  │
└──────────────┘     └──────────────┘     └──────────────┘
```

## 2. Fork Pattern (Parallel)

Execute multiple children in parallel, aggregate results:

```typescript
const builder = new FlowChartBuilder()
  .start('PrepareData', prepareFn)
  .addListOfFunction([
    { id: 'api1', name: 'CallAPI1', fn: api1Fn },
    { id: 'api2', name: 'CallAPI2', fn: api2Fn },
    { id: 'api3', name: 'CallAPI3', fn: api3Fn },
  ])
  .addFunction('AggregateResults', aggregateFn);
```

```
                    ┌──────────────┐
                ┌──▶│   CallAPI1   │──┐
┌─────────────┐ │   └──────────────┘  │   ┌─────────────────┐
│ PrepareData │─┼──▶│   CallAPI2   │──┼──▶│AggregateResults │
└─────────────┘ │   └──────────────┘  │   └─────────────────┘
                └──▶│   CallAPI3   │──┘
                    └──────────────┘
```

### Fork Results

Children return a bundle object:

```typescript
{
  api1: { result: { data: '...' }, isError: false },
  api2: { result: { data: '...' }, isError: false },
  api3: { result: Error('timeout'), isError: true }
}
```

## 3. Decider Pattern (Single-Choice)

Route to exactly ONE child based on a decision function:

```typescript
const routeDecider = (output: any) => {
  if (output?.type === 'tool_call') return 'tool';
  if (output?.type === 'response') return 'response';
  return 'error';
};

const builder = new FlowChartBuilder()
  .start('CallLLM', callLLMFn)
  .addDecider(routeDecider)
    .addFunctionBranch('tool', 'ExecuteTool', executeToolFn)
    .addFunctionBranch('response', 'FormatResponse', formatFn)
    .addFunctionBranch('error', 'HandleError', errorFn)
    .setDefault('error')
    .end();
```

```
                    ┌──────────────┐
                ┌──▶│ ExecuteTool  │
┌──────────────┐│   └──────────────┘
│   CallLLM    │┼──▶│FormatResponse│  (only ONE executes)
└──────────────┘│   └──────────────┘
                └──▶│ HandleError  │
                    └──────────────┘
```

## 4. Selector Pattern (Multi-Choice)

Route to ONE OR MORE children based on a selector function:

```typescript
const toolSelector = (output: any) => {
  // Return array of child IDs to execute in parallel
  return output.toolCalls.map(t => t.id);
};

const builder = new FlowChartBuilder()
  .start('AnalyzeRequest', analyzeFn)
  .addSelector(toolSelector)
    .addFunctionBranch('search', 'SearchTool', searchFn)
    .addFunctionBranch('calculator', 'CalculatorTool', calcFn)
    .addFunctionBranch('weather', 'WeatherTool', weatherFn)
    .end()
  .addFunction('CombineResults', combineFn);
```

```
                    ┌──────────────┐
                ┌──▶│  SearchTool  │──┐
┌───────────────┐│  └──────────────┘  │  ┌───────────────┐
│AnalyzeRequest │┼─▶│CalculatorTool│──┼─▶│CombineResults │
└───────────────┘│  └──────────────┘  │  └───────────────┘
                └──▶│  WeatherTool │──┘
                    └──────────────┘
                    (selected ones execute)
```

### Selector vs Decider

| Feature | Decider | Selector |
|---------|---------|----------|
| Children executed | Exactly 1 | 0 to N |
| Return type | Single ID | Single ID or Array |
| Use case | Routing | Parallel tool execution |

## Combining Patterns

Patterns can be nested:

```typescript
const builder = new FlowChartBuilder()
  .start('Entry', entryFn)
  .addDecider(routeDecider)
    .addFunctionBranch('path_a', 'PathA', pathAFn, (b) => {
      // Nested fork inside decider branch
      b.addListOfFunction([
        { id: 'a1', name: 'SubA1', fn: subA1Fn },
        { id: 'a2', name: 'SubA2', fn: subA2Fn },
      ]);
    })
    .addFunctionBranch('path_b', 'PathB', pathBFn)
    .end();
```


## 5. Dynamic Pattern (Runtime Children)

Create children at runtime by returning a `StageNode` from your handler:

```typescript
async function toolBranchHandler(scope: Scope) {
  const toolCalls = scope.getValue([], 'toolCalls');
  
  // Return StageNode with dynamic children
  return {
    name: 'dynamicTools',
    children: toolCalls.map(call => ({
      id: `tool_${call.id}`,
      name: call.name,
      fn: async () => executeTool(call),
    })),
  };
}
```

```
┌───────────────┐
│  toolBranch   │
└───────┬───────┘
        │ (returns StageNode)
        ▼
┌───┬───┬───┬───┐
│ ? │ ? │ ? │...│  (created at runtime)
└───┴───┴───┴───┘
```

📖 **[Full Dynamic Children Guide](./DYNAMIC_CHILDREN.md)** - Complete documentation with examples
