# Internal History Module

## Purpose

The internal history module provides **immutable history tracking** for committed state changes. This enables time-travel debugging, state replay, and audit trails.

## Key Concepts

- **ExecutionHistory**: Maintains an ordered list of commit bundles, each representing a stage's committed changes.

- **CommitBundle**: A snapshot of a stage's committed patches, including metadata like stage name, timestamp, and step number.

- **TraceItem**: Individual trace entries for debugging, including reads, writes, and errors.

## Design Decisions

1. **Immutable History**: Once committed, history entries cannot be modified. This ensures reliable time-travel.

2. **Step Numbers**: Each commit has a monotonically increasing step number, enabling precise time-travel navigation.

3. **Lazy Snapshots**: Full state snapshots are computed on-demand rather than stored, saving memory.

## Files Overview

| File | Purpose |
|------|---------|
| `ExecutionHistory.ts` | Immutable history of committed state changes |
| `index.ts` | Barrel export |

## Usage Example

```typescript
import { ExecutionHistory } from './ExecutionHistory';

const history = new ExecutionHistory();

// Record a commit
history.recordCommit({
  stageName: 'processUser',
  stepNumber: 1,
  patches: [...],
  timestamp: Date.now(),
});

// Time-travel to a specific step
const stateAtStep = history.getStateAtStep(1);

// Get all commits
const commits = history.getCommits();
```

## Related Modules

- `../memory/WriteBuffer.ts` - Produces patches that become history entries
- `../../core/memory/PipelineRuntime.ts` - Manages history during execution
- `../../core/memory/StageContext.ts` - Records commits to history
