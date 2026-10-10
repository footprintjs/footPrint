# ids/ — engine IDs and the shared record grammar

Every execution step has an address, `[subflowPath/]stageId#executionIndex`
(`sf-tools/execute-tool-calls#8`). The runtime-ID grammar and its brands now
belong to `foottrace`; this folder keeps only the engine's rules:

- `branchSegment.ts` owns the generated `<stageId>~<index>` segment used by
  `parallelForEach`.
- `reservedIds.ts` owns `refuseReservedId`, the builder and dynamic-node
  doors' one refusal. It reads the public foottrace delimiters and the engine's
  `~` rule; the record grammar never imports the engine refusal.

The builder refuses `#` and `/` in user-authored IDs and `~` in subflow and
`parallelForEach` IDs. The prefixer writes `/` on purpose, and stores accept
runtime IDs containing both delimiters. A generated segment is opaque to the
record reader: `review~2/score#14` reads like any other subflow path.

```typescript
import { buildRuntimeStageId, parseRuntimeStageId } from 'foottrace';

const rid = buildRuntimeStageId('score', 14, 'review~2');
parseRuntimeStageId(rid); // { stageId: 'score', executionIndex: 14, subflowPath: 'review~2' }
```

```typescript
import { flowChart } from 'footprintjs';

flowChart('Seed', () => undefined, 'ns/seed');
// throws: [FlowChartBuilder] stage id 'ns/seed' contains the reserved character '/'. …
```

These engine leaves sit at L0. Engine recorders, scopes and subtree lookups
import the grammar directly from `foottrace`, never a local parsing copy.
`RuntimeStageId`, `ExecutionIndex` and `CommitIdx` are type-only brands on
that root door. The generated-segment helpers remain on `footprintjs/trace`;
`refuseReservedId` is internal and has no public door.
