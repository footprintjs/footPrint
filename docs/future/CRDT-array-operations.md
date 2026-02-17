# Future: CRDT-Based Array Operations in WriteBuffer

## Status: Planned (not yet implemented)

## Context

Currently, `appendToArray()` and `mergeObject()` on StageContext are convenience methods that do read-merge-write internally. The WriteBuffer records the FULL merged value on commit, not the individual operation (append vs replace).

This means:
- History tracking works correctly (time traveler shows correct state at each step)
- But diff/change tracking between commits shows the entire array/object as changed, not just the appended item or merged key

## Future Improvement

Add WriteBuffer-level support for array and object operations using CRDT-like semantics:

### Array Operations
```typescript
// Instead of recording: messages = [msg1, msg2, msg3, newMsg]  (full replacement)
// Record: messages.append(newMsg)  (operation)
writeBuffer.appendToArray(['agent', 'messages'], newMsg);
```

### Object Operations
```typescript
// Instead of recording: config = { ...existingConfig, newKey: value }  (full replacement)
// Record: config.merge({ newKey: value })  (operation)
writeBuffer.mergeObject(['agent', 'config'], { newKey: value });
```

### Benefits
1. **Granular history**: Time traveler can show "1 item appended" instead of "array changed"
2. **Conflict resolution**: Parallel children appending to the same array can be merged without conflicts
3. **Smaller patches**: Only the delta is stored, not the full value
4. **Better debugging**: Users can see exactly what operation was performed

### Implementation Approach
- Add operation types to WriteBuffer: `SET`, `APPEND`, `MERGE`
- ExecutionHistory records the operation type alongside the value
- GlobalStore applies operations in order during replay
- Time traveler UI shows operation-aware diffs

### Complexity
This is a significant change touching WriteBuffer, GlobalStore, ExecutionHistory, and the time traveler UI. It should be a separate feature with its own spec.

### Cross-References
- `StageContext.appendToArray()` — current convenience method (read-merge-write)
- `StageContext.mergeObject()` — current convenience method (read-merge-write)
- `SubflowInputMapper.applyOutputMapping()` — uses these methods for subflow output
- `ExecutionHistory` — would need operation-aware commit bundles
- `WriteBuffer` — would need operation types beyond SET
