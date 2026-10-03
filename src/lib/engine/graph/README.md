# engine/graph/ — the one node type the traverser walks

`StageNode` is the shape of every node in a built chart: a name and an id, an optional function, and the pointers that make it a chain (`next`), a fork (`children`), a decider or selector (`deciderFn` / `selectorFn`, `nextNodeSelector`), a subflow root (`isSubflowRoot`, `subflowId`, `subflowMountOptions`), a loop edge (`isLoopRef`) or a lazy or dynamic attachment (`subflowResolver`, resolved on first use; `subflowDef`, an inline definition). The folder also holds the `Decider`, `Selector` and `ResumeFn` types and `isStageNodeReturn`, the duck-typed test for "did this stage return a node to continue into". It owns the *type*; it builds no node (that is `builder/`) and walks none (`engine/traversal/`). One transform lives here too: `prefixNodeTree.ts`, the ONE subflow-id prefixer the builder (at mount) and the traverser (at run time) both call (F7 — they were byte-twin copies until 9.36.0).

**The laws.**

- *Kinds are flags, not an enum.* A new kind is a boolean on this one type plus a handler phase — and a variant of an existing shape (`isDynamicParallel`, serialized as `'fork'`) is cheaper still. `retry` and `tags` are *policies* on a stage, not kinds, which is why neither touched a node-type union or `computeNodeType`.
- *`branchId` survives prefixing.* When a mounted subflow's tree is id-prefixed, `branchId` keeps the id the user's decider returns, and handlers match on `child.branchId ?? child.id`.
- *A loop-ref stub repeats a real node's id on purpose*, so a search by id must either skip `isLoopRef` (`runner/resume.ts · dfsFind`, `ResumeEntry`) or reach the real node first in pre-order (`FlowchartTraverser · buildNodeIdMap` and `NodeResolver`'s search keep the first match) — which is why a loop target has to be declared before the loop.
- *`isStageNodeReturn` is a shape test.* It needs a `name` plus a real continuation (a non-empty `children`, a `next`, a `nextNodeSelector` or `isSubflowRoot`) and answers `false` rather than throw on a hostile Proxy (`test/lib/engine/unit/StageNode.test.ts`).

```typescript
import { flowChart } from 'footprintjs';
import { isStageNodeReturn } from 'footprintjs/advanced';

const chart = flowChart('Start', () => {}, 'start').addFunction('Next', () => {}, 'next').build();

chart.root.id;                              // 'start' — the root StageNode
chart.root.next?.id;                        // 'next'  — the linear chain is `next` pointers
isStageNodeReturn(chart.root);              // true    — it has a continuation pointer
isStageNodeReturn({ name: 'just-a-name' }); // false   — a name alone is not a node to continue into
```

Layer L6 (`scripts/layering.config.cjs`): the `engine/**` layer; it imports `engine/types` as a type only, and the builder (types), the handlers and the traverser import it. `StageNode` and `isStageNodeReturn` are on `footprintjs/advanced`. See also [`../README.md`](../README.md).
