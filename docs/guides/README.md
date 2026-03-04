# User Guides

This section contains practical guides for using FootPrint in your applications.

## Quick Navigation

| Guide | Description | Time |
|-------|-------------|------|
| [Getting Started](./GETTING_STARTED.md) | Installation and your first pipeline | 10 min |
| [Core Concepts](./CORE_CONCEPTS.md) | Architecture, stages, and memory model | 20 min |
| [Patterns](./PATTERNS.md) | Linear, Fork, Decider, Selector patterns | 30 min |
| [FlowChartBuilder API](./FLOWCHART_BUILDER.md) | Complete API reference | Reference |
| [Scope Communication](./SCOPE_COMMUNICATION.md) | Cross-stage data sharing (CRITICAL) | 15 min |

## Learning Path

### Beginner (30 minutes)

1. **[Getting Started](./GETTING_STARTED.md)** - Install and run your first pipeline
2. **[Core Concepts](./CORE_CONCEPTS.md)** - Understand stages, scope, and execution order

### Intermediate (1 hour)

3. **[Patterns](./PATTERNS.md)** - Master the four execution patterns
4. **[Scope Communication](./SCOPE_COMMUNICATION.md)** - Learn proper state management

### Advanced (Reference)

5. **[FlowChartBuilder API](./FLOWCHART_BUILDER.md)** - Deep dive into all methods

## Key Concepts at a Glance

### The Four Patterns

```
Linear:    A → B → C
Fork:      A → [B1, B2, B3] → C
Decider:   A → ? → (B1 OR B2)
Selector:  A → ? → [selected subset] → C
```

### Scope Methods

```typescript
// Write data (overwrites)
scope.setValue('key', value);

// Write data (deep merge)
scope.updateValue('key', value);

// Read data
const value = scope.getValue('key');
```

### Builder Pattern

```typescript
new FlowChartBuilder()
  .start('Entry', entryFn)           // Root node
  .addFunction('Next', nextFn)       // Linear chain
  .addListOfFunction([...])          // Parallel fork
  .addDecider(deciderFn)             // Single-choice
  .addSelector(selectorFn)           // Multi-choice
  .execute(scopeFactory);            // Run it
```

## Related Documentation

- [Technical Internals](../internals/README.md) - Implementation details
- [Demo Examples](../../demo/README.md) - Working code examples
