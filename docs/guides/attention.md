# Stage attention: engine facts before explanation

`StageSnapshot.attention?` contains bounded marks collected while the engine retains errors, attempts and summaries. Each mark has a kind, a fixed reason and retained proof. A viewer can highlight a stage before requesting evidence; no model classifies raw logs.

The shared `Attention` and `AttentionKind` contracts belong to the public `foottrace` root. FootPrint imports them without re-exporting them or loading `foottrace/cause` into the engine.

```ts
import type { Attention } from 'foottrace';
import type { StageSnapshot } from 'footprintjs/advanced';

function attentionFor(stage: StageSnapshot): readonly Attention[] {
  return stage.attention ?? [];
}
```

A healthy execution has **no own attention field**, rather than an empty array. Absence means no mark was collected; it is not a completeness or health guarantee for old records, unavailable evidence or disabled producers.

| Kind | Engine-owned recorded fact |
| --- | --- |
| `error` | The explicit stage-error path retained `errors.stageExecutionError`. A recovered failed attempt alone is not a final stage error. |
| `retried` | A native attempt records a retry decision, or an actual later ordinal establishes a retry. |
| `timeout` | A retained attempt timed out; this does not prove that the provider was down. |
| `unknown-effect` | An outside effect was explicitly recorded as unknown, not as a confirmed failed payment. |
| `gave-up` | A retry-capable native series ended with a supported recorded stop reason; pause or cancellation is not automatically exhaustion. |
| `not-collected` | Known proof or retention capacity is unavailable; evidence is incomplete. |

The engine never enumerates attached recorders or reads their stores. Quality belongs to its recorder; saved rows remain available for a read-time cause adapter. C2 does not implement that adapter or infer quality-drop from a score, factor text or arbitrary `$eval`. The shared `quality-drop` and `outlier` kinds remain available to explicit producers; C2 supplies no implicit detector.

For `observed()` SDK records, `next` and `reason` are the default retry table's interpretation, not an observed SDK policy decision. They cannot establish a retry or exhaustion; a reported ordinal above one can establish a retry. Timeout and unknown-effect outcomes remain recorded facts. A physical call inside `retryLoop` likewise does not establish whole-workflow exhaustion; use its logical decision evidence.

## One official attempt identity

Attempt proofs use Foottrace's `buildAttemptId` and `parseAttemptId` codec:

| Example | Meaning |
| --- | --- |
| `charge#4@2` | Attempt 2 of stage execution `charge#4`. |
| `charge#4@2.1@3` | Attempt 3 of call 1 made during stage attempt 2. |
| `attemptSummary` | The owning node's retained summary: a stopped backoff, an aggregate unknown effect, or unavailable canonical terminal proof. |
| `errors:stageExecutionError` | The own retained field of this node's errors bag, subject to diagnostic redaction. |
| `attemptsDropped` | This node's nonzero retention-loss count, without inventing an unretained attempt. |

Keep the owning run and runtime execution with every mark. Resolve an attempt ID against retained records for that execution; do not search another stage by display name or create an index alias. A final attempt uses its canonical ID when it proves the same fact. A summary-only stop or aggregate unknown effect can still cite `attemptSummary`: a later known outcome must not erase an earlier unresolved effect.

Marks copy no raw error text, factors, state values, inputs, outputs, idempotency keys or provider bodies. Canonical IDs carry record identity. At most 32 marks and 16 references per mark are retained. References are at most 512 characters and exclude C0/C1 controls. Invalid or oversized identity is omitted, never shortened into different proof. A not-collected signal may cover multiple omissions; it is not an exhaustive gap count.

## Collection and storage boundaries

`StageAttention` owns all attention state, retry capability, pending summary and proof admission. `StageContext` holds one optional helper and delegates at synchronous retention boundaries. Snapshot export copies bounded marks; it never scans attempt history or the execution tree to discover them. A new execution resets the helper, while retry staging discards preserve its earlier facts. The no-policy stage path remains non-async.

Attention lives in the **local served execution snapshot**. C2 does not add it to the crash-safe sink. Native attempt notes may survive a process kill; that does not mean the attention projection survived. Missing error diagnostics must not be replaced by invented error proof.

Commit failures retain and serve `errors.stageExecutionError` through the same diagnostic-redaction boundary as stage-function failures. Its error attention cites that retained field, including when its text is masked. A successful attempt summary still means the function returned: its later commit may fail, with none of that commit's writes applied and no retry-exhaustion claim. The caller still receives the original error and cause.

The runnable [01-stage-attention.ts](../../examples/runtime-features/attention/01-stage-attention.ts) executes healthy → recovered retry → healthy, checks omitted healthy fields and resolves canonical retry proof. It uses no provider, model, network or credentials:

```sh
npx tsx examples/runtime-features/attention/01-stage-attention.ts
```
