# Native producer ownership evidence

This producer-only slice prepares independently collected namespace and invocation
bindings for saved exact-source readers. It does not change AgentFootprint's
admission: saved version-2 evidence remains unknown there until a separately
reviewed adoption. No model, remote service or business rerun is involved.

## Facts and owners

The engine already knows an execution's native identity and frame address before
observers run. `StageContext.bindFailureIdentity` registers that pair in the
current native source collector. It includes executions that read nothing. The
namespace comes from the engine's existing `runAddress(namespaceId)` owner,
never source rows, filenames, display names or an execution-tree guess.

Immediately before calling a stage function, `StageRunner` records that actual
invocation. A retry uses its real `AttemptContext.attempt`; the direct one-call
path records the single invocation it actually makes. Both use Foottrace's
public official ID codec. This does not fabricate an `AttemptRecord`, timestamps,
durations, outcome or provider attempt. Scope construction that fails before the
function call records no invocation. Per-stage `readSourceInvocations` is counted
independently of the bounded ownership list and retained read rows.

After the native record frame commits, the collector records its first actual
commit offset. Continuations never replace it. Do not substitute the log length
at stage entry: parallel work may commit while an already-started stage waits.
The existing stored-source reader keeps its canonical first-reader-commit check
and Foottrace remains the owner of source selection and value replay.

## Wire contract

Default-off observations and ordinary capture notes do not change. An owned
source book produces `EngineReadSources.version: 2`, adding `ownership`:

```ts
import type { SourceOwnershipWitness } from 'footprintjs';

function isOwned(witness: SourceOwnershipWitness): boolean {
  return witness.version === 1 && witness.status === 'captured';
}
```

The witness contains the run ID, exact log address, native segment, half-open
commit range and execution entries. Each entry carries `runtimeStageId`, the
frame's `stateAddress`, ordered actual `attemptIds` and, once committed, its
`firstCommit`. These are identity/coverage facts, not values or value hashes.
The native capture note remains version 2 because its channel vocabulary is
unchanged. Source-envelope version 1 is still read without ownership proof;
version 1 carrying a new ownership claim is refused. Older strict readers refuse
the new source envelope instead of accepting unfamiliar completeness claims.

Format-v1 limits have one owner in `sourceOwnershipFormat`: at most 4,096 native
executions, 16,384 invocation IDs, 524,288 encoded witness bytes, 64 namespace
segments and 2,048 characters per identifier/segment. They are immutable format
ceilings, not settings or model-controlled budgets. Increasing them needs a new
wire version. Exact JSON UTF-8 charging reserves header, delimiters, escape
expansion and first-commit space before accepting entries.

Reaching a limit keeps a bounded `unknown` witness and its named limitations;
it neither aborts business work nor upgrades omitted entries to captured-empty.
Source rows have their own independent limits. A source channel may therefore
be `captured` while its ownership is `unknown`. Consumers must require both
appropriate source coverage and captured, verified ownership before trusting
bindings, and must still honor all usual source/capture gaps.

## Native fallback and lifecycle limits

A frame at `['runs', branchId]` may read the global root through the native
fallback. The selected read address is then different from the frame's address.
The witness does not learn an authorization address from that row; it discloses
`source-address-unproven` and stays unknown. Foottrace's current consumer contract
accepts one address per execution, so mixed/fallback namespaces need a later
contract. Namespace moves also remain unknown. No second fallback algorithm is
implemented here.

Each child book retains its own identity, without borrowing the parent's storage
receipt. Root saved-history admission does not attest child histories. A fresh
executor's resumed book describes its new segment and still names omitted prior
history. Same-executor source reuse remains unknown. Lean checkpoints carry no
ownership/history table and cannot restore it. Staged-generation-to-commit joins
and wider lifecycle coverage remain separate.

Redacted exports withhold the source book and all ownership entries, returning
an explicit unknown witness. A retirement/seal prevents later native callbacks
from adding ownership to the finished observation.

## Stored boundary and threat model

Input entries are untrusted. The existing inert, byte-bounded history copier
rejects accessors, custom prototypes and executable serialization before metadata
admission. Shared note/history validators and Foottrace's public source codec
remain authoritative. The stored ownership check then validates the exact
versioned shape, run/address/segment/range, native execution membership, first
commit, contiguous stage invocation IDs, independent invocation counts and
selected row bindings. Captured witnesses include zero-read owners too. Invalid
or rehashed structurally contradictory evidence returns a fixed unknown reason.
Checks use indexed sets, not a scan of every invocation for every read.

The existing history fingerprint and explicit adapter receipt cover the new
metadata. They detect corruption and mismatches, not deliberate producer forgery:
someone controlling all stored evidence can rewrite a self-consistent history
and recompute an unkeyed digest. Hosts still authorize/trust their storage and
producer; this is no signature, identity attestation or physical-cause proof.

## Offline acceptance

Tests precede implementation. Real-engine tests include ordinary and zero-read
stages, retries/discarded reads, real file acknowledgement, legacy envelopes,
default-off byte equality, read-retention independence, fallback parallel scopes,
child identity isolation and fresh/reused resume limits. Hostile edits change
namespaces, attempts, counts, commit bounds, run IDs, versions and entries under
recomputed fingerprints. Accessor input cannot run. Collector tests cover fixed
entry/invocation/encoded-byte ceilings, escaped namespace data, frozen snapshots
and first-commit preservation. Independent security then code review is required
before the PR, and no merge or publication is performed by this slice.
