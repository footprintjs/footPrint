# FlowChartBuilder API Reference

`FlowChartBuilder` is the primary API for constructing pipelines.

## Creating a Builder

```typescript
import { FlowChartBuilder } from 'footprint';

const builder = new FlowChartBuilder<TOut, TScope>();
```

## Authoring Methods

### `start(name, fn?, id?)`

Define the root stage of the flow.

```typescript
builder.start('RootStage', async (scope) => {
  return { initialized: true };
});
```

### `addFunction(name, fn?, id?)`

Append a linear "next" stage.

```typescript
builder
  .start('Step1', step1Fn)
  .addFunction('Step2', step2Fn)
  .addFunction('Step3', step3Fn);
```

### `addListOfFunction(children)`

Add parallel children (fork pattern).

```typescript
builder.addListOfFunction([
  { id: 'child1', name: 'Child1', fn: child1Fn },
  { id: 'child2', name: 'Child2', fn: child2Fn },
  { 
    id: 'child3', 
    name: 'Child3', 
    fn: child3Fn,
    build: (b) => b.addFunction('SubChild', subFn) // nested subtree
  },
]);
```

### `addDecider(deciderFn)`

Add single-choice branching. Returns a `DeciderList` for adding branches.

```typescript
builder
  .start('Router', routerFn)
  .addDecider((output) => output.route)
    .addFunctionBranch('a', 'BranchA', branchAFn)
    .addFunctionBranch('b', 'BranchB', branchBFn)
    .setDefault('a')
    .end();
```

### `addSelector(selectorFn)`

Add multi-choice branching. Returns a `SelectorList` for adding branches.

```typescript
builder
  .start('Analyzer', analyzerFn)
  .addSelector((output) => output.selectedTools)
    .addFunctionBranch('tool1', 'Tool1', tool1Fn)
    .addFunctionBranch('tool2', 'Tool2', tool2Fn)
    .end();
```

### `addSubFlowChart(id, subflow, mountName?)`

Mount a prebuilt subtree as a child.

```typescript
const subflow = new FlowChartBuilder()
  .start('SubRoot', subRootFn)
  .addFunction('SubNext', subNextFn)
  .build();

builder
  .start('Main', mainFn)
  .addSubFlowChart('sub', subflow, 'MountedSub');
```

## Navigation Methods

### `into(childId)`

Move cursor into a specific child.

### `end()`

Move cursor back to parent.

### `resetToRoot()`

Reset cursor to root node.

## Output Methods

### `build()`

Compile to engine input (contains functions).

```typescript
const { root, stageMap } = builder.build();
```

### `toSpec()`

Emit pure JSON spec for transport (no functions).

```typescript
const spec = builder.toSpec();
// Send to backend
```

### `execute(scopeFactory, opts?)`

Build and execute the pipeline.

```typescript
const result = await builder.execute(scopeFactory, {
  defaults: { showDisclaimer: true },
  initial: { userId: '123' },
  readOnly: { config: appConfig },
});
```

### `toMermaid()`

Generate Mermaid diagram.

```typescript
const diagram = builder.toMermaid();
// flowchart TD
// Step1["Step1"]
// Step1 --> Step2
// ...
```

## DeciderList Methods

Returned by `addDecider()`:

| Method | Description |
|--------|-------------|
| `addFunctionBranch(id, name, fn?, build?)` | Add a branch with function |
| `addSubFlowChartBranch(id, subflow, mountName?)` | Add a branch with subtree |
| `addBranchList(branches)` | Add multiple branches |
| `setDefault(id)` | Set fallback branch |
| `end()` | Return to parent builder |

## SelectorList Methods

Returned by `addSelector()`:

| Method | Description |
|--------|-------------|
| `addFunctionBranch(id, name, fn?, build?)` | Add a branch with function |
| `addSubFlowChartBranch(id, subflow, mountName?)` | Add a branch with subtree |
| `addBranchList(branches)` | Add multiple branches |
| `end()` | Return to parent builder |

## Helper Functions

### `specToStageNode(spec)`

Convert JSON spec back to StageNode (for backend).

```typescript
import { specToStageNode } from 'footprint';

const stageNode = specToStageNode(jsonSpec);
```
