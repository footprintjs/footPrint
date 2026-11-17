# Observing subflow boundaries

Enable the channels you need before the run:

```typescript
import {subflowCapture} from 'footprintjs/subflow-capture';

const executor = new FlowChartExecutor(chart, {
  ...subflowCapture({input:true,fanout:true}),
  captureOutputHandoff: true,
});
await executor.run();
const snapshot = executor.getSnapshot();
```

Input and fanout are independently off by default and load only through this optional public module. Its factory accepts own plain Boolean data only and returns opaque same-loaded-module-instance authority. The new input/fanout options are unreleased: bare flags, forged or serialized tokens, and CJS/ESM instance mixes refuse before executor setup effects. Use matching CJS or ESM imports. This changes the unreleased activation API; released output capture still works without the factory.

No capability crosses detach/worker/beacon transport. Offered new capture configuration at their configuration doors refuses before scheduling or transport effects; arbitrary business input stays opaque. An independent in-process child executor or consumer worker may configure its own fresh factory inside that instance. There is no implicit inheritance or new transport protocol.

Each option is independently off by default. Ordinary mapped seeds use `captureInputHandoff`; generated fanout seeds and their parent collection use `captureFanoutHandoff`. Enabling both captures a generated seed once. Input-only capture of a generated seed reports `selector-reads-unavailable`. The existing output channel keeps its previous behavior.

A retained subflow result's `inputHandoff` names the actual child seed commit, its admitted write paths and literal parent root reads observed before mapping finished. The saved parent cutoff is exclusive. A changed parent log, restored seed, active privacy rule, missing selector observation, uncommitted selector writes or exhausted budget stays partial. No parent key is inserted into the child log's local `readKeys`. An empty observed prefix does not prove that a closure or outside value had no source.

`fanoutCollections` belongs to the parent scope, once: at the root snapshot, or at a nested result's `treeContext.fanoutCollections`. It names the actual parent collection write and retained child log cutoffs in item order. Unknown children omit their whole slot; known failed slots and explicit outputs remain distinct partial observations. A scope snapshot is not a key read: readers must retain a conservative, nontraversable boundary rather than invent element-index, all-key or empty-root derivations.

The collection store holds at most128 observations within4096 items and64KiB of UTF-8 name/reference bytes. Overflow makes its view partial. New runs and resumed legs start fresh collection views; held snapshots do not change. Input writes retain the existing256-write producer ceiling. Readers may admit a smaller native trace ceiling and must disclose that limit. Existing output-v1 accounting is unchanged.

Explicit redacted snapshots withhold input source names and collection child references at root and nested scopes. An active privacy rule also withholds them during capture. Redacted runtime/static twins still refer to the same served object within one snapshot call.

Use actual execution entries, with a whole native log address and matching mount runtime ID, when adapting snapshots for a reader. A static path is only the latest alias. Every native snapshot/map-derived invocation inventory must remain `partial`: pauses, early failures, limited capture, resume and checkpoints can omit entries. Even a complete-looking map or a captured individual handoff cannot certify the invocation inventory. A separately host-owned finite inventory may assert coverage of its own supplied scope; that is not library verification of the whole run.

These observations describe accesses during execution. They are neither semantic-causation proof nor crash-safe storage receipts.
