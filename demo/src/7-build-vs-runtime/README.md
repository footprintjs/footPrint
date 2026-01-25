# Demo 7: Build-Time vs Runtime Extraction

This demo shows the difference between build-time and runtime extraction.

## Two Types of Extractors

### Build-Time Extractor (`addBuildTimeExtractor`)

- Called during `toSpec()` 
- Transforms static structure
- Used for FE→BE transport, visualization
- No execution data (no stepNumber, no scope)

```typescript
const buildTimeExtractor: BuildTimeExtractor<MyNode> = (metadata) => ({
  id: metadata.id ?? metadata.name,
  name: metadata.name,
  type: computeType(metadata),
  next: metadata.next,
  children: metadata.children,
});

const spec = builder.toSpec<MyNode>();
```

### Runtime Extractor (`addTraversalExtractor`)

- Called after each stage executes
- Captures execution metadata
- Includes `stepNumber` for time traveler sync
- Has access to scope and context

```typescript
const runtimeExtractor: TraversalExtractor<MyData> = (snapshot) => ({
  stageName: snapshot.node.name,
  stepNumber: snapshot.stepNumber,
  output: snapshot.context.getScope()?.output,
});

const results = pipeline.getExtractedResults<MyData>();
```

## When to Use Each

| Use Case | Extractor |
|----------|-----------|
| Serialize structure for API | Build-time |
| Add computed properties (type) | Build-time |
| Track execution order | Runtime |
| Capture stage outputs | Runtime |
| Time traveler sync | Runtime |
| Debug panel data | Runtime |

## Running the Demo

```bash
npx ts-node demo/src/7-build-vs-runtime/index.ts
```
