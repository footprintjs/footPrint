# Demo 6: Subflow with TraversalExtractor

This demo shows how `TraversalExtractor` works with subflows.

## Key Concepts

### Structure vs Execution

- **Structure** = Build-time concern (static, from `addSubFlowChart`)
- **Execution** = Runtime concern (dynamic, from `TraversalExtractor`)

### stepNumber Generation

The `stepNumber` in `StageSnapshot` increments for each stage execution, including subflow stages:

```
prepareRequest (step 1)
  └─ llm-core.callLLM (step 2)
  └─ llm-core.processResponse (step 3)
aggregateResults (step 4)
```

### Accessing Subflow Data

After execution:
- `pipeline.getExtractedResults()` - Contains all stage metadata (including subflow stages)
- `pipeline.getSubflowResults()` - Contains subflow execution context

## Running the Demo

```bash
npx ts-node demo/src/6-subflow-extractor/index.ts
```

## Output

```
=== Subflow with TraversalExtractor Demo ===

Executing pipeline...

  [Main] Preparing request...
  [Subflow] Calling LLM...
  [Subflow] Processing response...
  [Main] Aggregating results...

--- Extracted Results ---
  Step 1: prepareRequest
    - isSubflow: false
  Step 2: llm-core.callLLM
    - isSubflow: true
  Step 3: llm-core.processResponse
    - isSubflow: false
  Step 4: aggregateResults
    - isSubflow: false

--- Key Insight ---
  Structure = Build time (from toSpec() or subflows dictionary)
  Execution = Runtime (from TraversalExtractor with stepNumber)

✓ Subflow with extractor demo complete!
```
