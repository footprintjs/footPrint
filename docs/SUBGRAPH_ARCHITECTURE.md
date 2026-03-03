# Subgraph Architecture in FootPrint

## Overview

This document explains how subgraphs (subflows) work in FootPrint. A subgraph is a reusable, composable pipeline that can be mounted into a parent pipeline.

## Key Concepts

### What is a Subgraph?

A subgraph is a pre-built flowchart (`BuiltFlow`) that can be mounted into another flowchart. When mounted:
- It gets its own **isolated `TreePipelineContext`** (scope, history, metadata)
- It executes **independently** from the parent pipeline
- Its execution data is stored in the parent stage's `debugInfo` for drill-down
- The frontend can display it as a separate flowchart with breadcrumb navigation

### Subgraph vs Inline Stages

| Aspect | Subgraph | Inline Stages |
|--------|----------|---------------|
| Context | Own isolated `TreePipelineContext` | Shares parent's context |
| Scope | Independent scope | Same scope as parent |
| History | Own execution history | Part of parent's history |
| FE Display | Separate flowchart (drill-down) | Same flowchart as parent |
| Reusability | Highly reusable across flows | Tied to specific flow |

## Mounting Methods

### 1. `addSubFlowChart(id, subflow, mountName?)` - Fork Pattern

Mounts a subflow as a **parallel child** (fork). The subflow becomes one of the children that execute in parallel.

```typescript
const faqFlow = new FlowChartBuilder().start('FAQ').addFunction('FAQ_Answer').build();
const ragFlow = new FlowChartBuilder().start('RAG').addFunction('RAG_Answer').build();

new FlowChartBuilder()
  .start('entry')
  .addSubFlowChart('faq', faqFlow, 'FAQ')  // child id 'faq'
  .addSubFlowChart('rag', ragFlow, 'RAG')  // child id 'rag'
  .addFunction('aggregate')  // runs after all children complete
  .build();
```

**Structure:**
```
entry
├── faq (subflow) ──► [FAQ flowchart with own context]
├── rag (subflow) ──► [RAG flowchart with own context]
└── aggregate
```

### 2. `addSubFlowChartNext(id, subflow, mountName?)` - Linear Pattern

Mounts a subflow as a **linear continuation** (next). The subflow executes in sequence, then continues to the next stage.

```typescript
const smartContextFinder = createSmartContextFinderSubGraph();

new FlowChartBuilder()
  .start('prepareInput')
  .addSubFlowChartNext('smart-context-finder', smartContextFinder, 'Smart Context Finder')
  .addFunction('handleResult')  // runs AFTER subflow completes
  .build();
```

**Structure:**
```
prepareInput → [SmartContextFinder subflow] → handleResult
```

### 3. `addSubFlowChartBranch(id, subflow, mountName?)` - Decider Branch

Mounts a subflow as a **branch** of a decider. Used when one of the decider's choices is a complete subflow.

```typescript
const llmFlow = createLLMCoreSubGraph();

new FlowChartBuilder()
  .start('entry')
  .addDecider(decideRoute)
    .addFunctionBranch('simple', 'simpleHandler', simpleFn)
    .addSubFlowChartBranch('complex', llmFlow, 'LLM Core')  // subflow as branch
  .end()
  .build();
```

## Execution Model

### Isolated Context Creation

When Pipeline encounters a node with `isSubflowRoot: true`:

1. **Creates nested `TreePipelineContext`** for the subflow
2. **Executes subflow stages** using the nested context
3. **Stores `SubflowResult`** in parent stage's `debugInfo`
4. **Adds to `SubflowResultsMap`** for API response
5. **Continues parent pipeline** with `node.next` (if present)

```typescript
// In Pipeline.executeNode()
if (node.isSubflowRoot && node.subflowId) {
  return await this.executeSubflow(node, context, breakFlag, branchPath);
}
```

### SubflowResult Structure

```typescript
interface SubflowResult {
  subflowId: string;           // e.g., "smart-context-finder"
  subflowName: string;         // e.g., "Smart Context Finder"
  treeContext: {               // Subflow's execution data
    globalContext: {...},
    stageContexts: {...},
    history: [...]
  };
  pipelineStructure: {...};    // Subflow's StageNode tree
  parentStageId: string;       // Parent stage that triggered this
}
```

### Break Isolation

Subflow breaks are **isolated** - they don't propagate to the parent:

```typescript
// Subflow calls breakFn() → stops subflow execution only
// Parent pipeline continues after subflow completes
```

## CRITICAL: Subflows Must End with Linear Stages

**A subflow should NEVER end with a decider.**

### Why?

When you use `addSubFlowChartNext`, the builder:
1. Finds the **last node** of the subflow (via `_findLastNode`)
2. Sets the cursor to that last node
3. Allows you to chain `.addFunction()` after the subflow

If the subflow ends with a **decider** (which has `children` but no `next`):
- `_findLastNode` stops at the decider
- Adding a function after creates `decider.next = newFunction`
- This creates **invalid structure**: decider has both `children` AND `next`

### Correct Pattern

```typescript
// ✅ CORRECT: Subflow ends with linear stage
const smartContextFinder = new FlowChartBuilder()
  .start('analyze')
  .addDecider(decideType)
    .addFunctionBranch('typeA', 'handleA', handleAFn)
    .addFunctionBranch('typeB', 'handleB', handleBFn)
  .end()
  .addFunction('finalizeResult', finalizeFn)  // ← Linear ending
  .build();

// Can safely use addSubFlowChartNext
builder.addSubFlowChartNext('scf', smartContextFinder, 'Smart Context Finder')
       .addFunction('afterSubflow', afterFn);  // ✅ Works correctly
```

### Incorrect Pattern

```typescript
// ❌ WRONG: Subflow ends with decider
const llmCore = new FlowChartBuilder()
  .start('prepareHistory')
  .addFunction('askLLM', askLLMFn)
  .addDecider(decideRoute)
    .addFunctionBranch('tool_branch', 'toolBranch', toolBranchFn)
    .addFunctionBranch('response_branch', 'finalAnswer', finalAnswerFn)
  .end()  // ← Ends with decider!
  .build();

// DON'T DO THIS - creates invalid structure
builder.addSubFlowChartNext('llm-core', llmCore, 'LLM Core')
       .addFunction('prepareResponse', prepareFn);  // ❌ Breaks flowchart
```

### Solution: Inline Decider-Ending Logic

If your logic ends with a decider, **inline it** instead of using a subflow:

```typescript
// ✅ CORRECT: Inline the decider-ending logic
builder
  .addFunction('contextAggregator', contextAggregatorFn, 'contextAggregator', 'Aggregate Context')
  .addFunction('prepareHistory', prepareHistoryFn)
  .addFunction('askLLM', askLLMFn)
  .addDecider(decideRoute)
    .addFunctionBranch('tool_branch', 'toolBranch', toolBranchFn)
    .addFunctionBranch('response_branch', 'prepareResponse', prepareResponseFn)  // ← In branch
  .end();
```

## API Reference

### FlowChartBuilder Methods

| Method | Description | Use Case |
|--------|-------------|----------|
| `addSubFlowChart(id, subflow, name?)` | Mount as parallel child | Multiple subflows in parallel |
| `addSubFlowChartNext(id, subflow, name?)` | Mount as linear continuation | Sequential subflow execution |
| `addSubFlowChartBranch(id, subflow, name?)` | Mount as decider branch | Subflow as one decision path |

### Pipeline Methods

| Method | Description |
|--------|-------------|
| `getSubflowResults()` | Returns `Map<string, SubflowResult>` of all executed subflows |
| `getContextTree()` | Legacy: walks StageContext linked list after execution. For new integrations, prefer `getEnrichedResults()` with `enrichSnapshots: true`. |
| `getEnrichedResults()` | Returns enriched extractor results with scope state, debug info, stage output, and history index per stage (requires `enrichSnapshots: true`) |

### StageNode Properties

| Property | Type | Description |
|----------|------|-------------|
| `isSubflowRoot` | `boolean` | Marks node as subflow entry point |
| `subflowId` | `string` | Unique identifier for the subflow |
| `subflowName` | `string` | Display name for UI |

## Frontend Integration

### Drill-Down Navigation

When FE detects a stage with `hasSubflowData: true`:
1. Show a "drill-down" button/indicator
2. On click, load the `subflowResult` from `debugInfo`
3. Render the subflow's `pipelineStructure` as a new flowchart
4. Use the subflow's `treeContext` for time-travel/debug controls
5. Show breadcrumb: `Parent Flow > Subflow Name`

### Breadcrumb Example

```
Chat Flow > Smart Context Finder > analyzeQuery
```

## Summary

1. **Subgraphs get isolated contexts** - own scope, history, metadata
2. **Three mounting methods** - fork, linear, branch
3. **Never end subflows with deciders** - use linear stages
4. **SubflowResult stored in parent** - enables FE drill-down
5. **Break isolation** - subflow breaks don't affect parent
