# Demo 2: LLM Tool Loop

**Pattern:** Decider  
**Complexity:** ⭐⭐  
**Time:** 10 minutes

## What You'll Learn

- Conditional branching with `addDecider()`
- Decider functions that route to one branch
- The classic LLM agent loop pattern

## The Flow

```
┌─────────┐     ┌──────────────────┐
│ CallLLM │────▶│     Decider      │
└─────────┘     │                  │
                │  type === 'tool' │──▶ ExecuteToolCall
                │  type === 'resp' │──▶ FormatResponse
                │  else            │──▶ HandleError
                └──────────────────┘
```

## Key Concepts

### 1. Decider Function

A decider returns a single branch ID based on the previous stage's output:

```typescript
const routeDecider = (output: any) => {
  if (output?.type === 'tool_call') return 'tool';
  if (output?.type === 'response') return 'response';
  return 'error';  // Default fallback
};
```

### 2. Building with Decider

```typescript
new FlowChartBuilder()
  .start('CallLLM', callLLMFn)
  .addDecider(routeDecider)
    .addFunctionBranch('tool', 'ExecuteToolCall', executeToolFn)
    .addFunctionBranch('response', 'FormatResponse', formatFn)
    .addFunctionBranch('error', 'HandleError', errorFn)
    .setDefault('error')  // Fallback if decider returns unknown ID
    .end();
```

### 3. Only ONE Branch Executes

Unlike Fork (parallel), Decider picks exactly one branch:

```
Iteration 1: CallLLM → tool_call → ExecuteToolCall
Iteration 2: CallLLM → tool_call → ExecuteToolCall
Iteration 3: CallLLM → response  → FormatResponse
```

## Run It

```bash
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/2-llm-tool-loop/index.ts
```

## Expected Output

```
=== LLM Tool Loop Demo (Decider Pattern) ===

--- Iteration 1 ---
  [LLM] Calling LLM...
        Response type: tool_call
  [Tool] Executing tool: search
  Result: { "tool": "search", "result": "Sunny, 72°F" }

--- Iteration 2 ---
  [LLM] Calling LLM...
        Response type: tool_call
  [Tool] Executing tool: calculator
  Result: { "tool": "calculator", "result": "4" }

--- Iteration 3 ---
  [LLM] Calling LLM...
        Response type: response
  [Response] Formatting final response...
  Result: { "finalAnswer": "The weather is sunny and 2+2=4!" }

✓ LLM Tool Loop demo complete!
```

## Real-World Use Cases

- **LLM Agents**: Route between tool execution and final response
- **API Gateways**: Route requests based on content type
- **Workflow Engines**: Branch based on approval status

## Next Steps

→ [Demo 3: Parallel](../3-parallel/) - Learn parallel execution with Fork
