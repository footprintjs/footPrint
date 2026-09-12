# reactive/ -- TypedScope Deep Proxy System

Internal package for footprintjs. Provides typed property access to pipeline scope state via JavaScript Proxy.

## What It Does

Wraps a ReactiveTarget (ScopeFacade) in a Proxy so stage functions get typed, natural JS access:

```typescript
// Before: untyped, cast everywhere
scope.getValue('creditTier') as string;
scope.setValue('amount', 50000);

// After: typed, natural JS
scope.creditTier; // string (typed)
scope.amount = 50000; // type-checked write
scope.customer.address.zip = '90210'; // deep write, tracked
scope.tags.push('vip'); // array mutation, tracked
```

## Read Semantics

- scope.fieldName calls getValue -- fires onRead ONCE
- scope.customer.address.zip fires onRead for 'customer' only -- nested navigates in-memory
- scope.$read('customer.address.zip') fires onRead for 'customer', then walks the nested path in-memory (lodash.get-style semantics, no lodash dependency)

## Write Semantics

- scope.fieldName = value calls setValue -- fires onWrite
- scope.customer.address.zip = '90210' calls updateValue with the deep path -- fires onWrite once, commits as `merge` of a delta under the root key
- scope.tags.push('vip') clones the array, applies the mutation, calls setValue -- copy-on-write
- scope.order.lines[0].qty = 4 -- an INDEXED element is proxied too (9.22.0). The element proxy carries the path inside the element, rebuilds the array immutably, and hands the whole new array to the same commit callback `push` uses. A HELD element proxy reads through the current value (read-your-writes): `const line = scope.order.lines[0]; line.qty = 2; line.total = line.qty * 10` gives 20, and `'x' in line` / `Object.keys(line)` / `JSON.stringify(line)` see `line.x = 1`
- The same read-your-writes law holds for a held OBJECT proxy at any depth (`const o = scope.k.o; o.x += 1; o.x += 1` gives 3; so does `const k = scope.k`) -- every nested, terminal and element proxy resolves reads through the current value (`liveView.ts`) and answers from the object it captured only when the path is gone

### The four laws

**1. A write the proxy can reach is always in the log.** Not "usually", not
"unless something else was written first". If the engine cannot see a write it
says so (law 4) — it never lets a run finish with a commit log that disagrees
with final state.

**2. A read is BORROWED; the write path never mutates it.** Before a stage's
first staged write a read is a bare reference into committed shared memory, and
committed state is immutable-after-swap. So every write builds a NEW value with
`structuralWrite.setInPath` / `deleteInPath`, copying only the containers on
the path and sharing everything else. Nothing in this folder assigns into a
value it read.

**3. An ARRAY write commits as `set` of the ROOT KEY; an OBJECT write commits
as `merge`.** `merge`'s array arm is a set union (`deepSmartMerge`), so it can
append but can never replace, reorder or shrink — which is why a nested array
write used to be silently wrong. An array mutation always hands back the
COMPLETE new array, so `set` is the only truthful verb; the root key is the
granularity `findLastWriter`, `sliceForKey` and `causalChain` index by, so one
trace path per state key still holds whatever depth the write was addressed at.

Consequence: an array ASSIGNMENT replaces at every depth. `scope.k.tags = ['b']`
used to APPEND while `scope.tags = ['b']` replaced; now both replace.
`$update(key, { tags: [...] })` remains the explicit append, and the subflow
`outputMapper` array-concat law is untouched.

**4. What cannot be intercepted is REFUSED loudly, never lost silently.** See
"What the proxy cannot see" below — and note the two shapes of "loudly": a
write from a handle held past its stage is refused AT THE WRITE (it throws); an
in-place mutation of a borrowed read is reported AFTER THE FACT (a dev-mode
warning at commit — the write already happened, there was nothing to
intercept).

## What the proxy cannot see

An element reached WITHOUT an index — `find`, `filter`, `for…of`, `forEach`,
destructuring — is handed back raw. Wrapping those would mean returning proxies
out of every read method (`map` would build an array of proxies, `filter` would
compare proxies, a returned value could escape the stage still bound to one),
for a cost the library should not pay and a semantic change it should not make.

So that family is warned about rather than intercepted. `StageContext.commit`
compares what the stage READ with what the value holds at commit — a key it
read but never staged must still hold it — and WARNS with the exact path and
the two ways to write it back. This is a report after the fact, not a refusal
at the write, and it runs under TWO preconditions, both required:

- `enableDevMode()` — the default run pays nothing and says nothing;
- `readTracking: 'full'` (the default) — the comparison needs the clone of the
  value that mode retains at read time; under `'summary'` or `'off'` there is
  nothing to compare against, so the guard is silent there too.

```typescript
// Warned about in dev mode: the proxy is not in this expression at all.
const line = scope.order.lines.find((l) => l.id === 'x');
line.qty = 4;

// Both of these are seen, logged, and replay correctly:
scope.order.lines[0].qty = 4;
scope.$setValue('order', next);
```

The same applies to any value the allowlist refuses to proxy (a `Date`, `Map`,
`Set`, class instance or frozen object) and to anything read out through
`$getValue`: `scope.k.when.setFullYear(1999)` or `scope.k.tags.add('b')` is an
in-place mutation of a borrowed read, and the guard names `k.when` / `k.tags`
(9.22.0 — `deepEqual` compares a `Date` by instant and a `Map`/`Set` by
members, so these no longer pass as "unchanged"). Replace the value instead:
`scope.k.when = new Date(…)` or `scope.$setValue('k', { ...next })` — both
keep the Date (9.24.0; until then the proxy's JSON round-trip turned it into
a string and only `$setValue` kept it).

## A handle is bound to its stage

A scope, and every proxy read out of it (`scope.k`, `scope.k.arr`,
`scope.k.arr[0]`), belongs to the stage it was handed to. Once that stage has
committed, a write through any of them has no frame to land in — it would sit
in a buffer nothing ever commits, with no trace row. So it is REFUSED: the
write throws, naming the stage the handle came from, and the error surfaces in
the stage that made the write (9.22.0).

```typescript
let held;
flowChart(
  'A',
  (scope) => {
    held = scope.order;
  },
  'A',
).addFunction(
  'B',
  (scope) => {
    held.total = 9; // throws: Stage "A" (A#1) has already committed — its scope is dead …
    scope.order.total = 9; // the way: read the key again through THIS stage's scope
  },
  'B',
);
```

Reads through a held handle are not refused (a stale read is not a lost write).

**What this cannot catch: a RAW handle held past its stage.** A value obtained
through `find`/`filter`/`for…of`/`forEach`/destructuring, `$getValue`, `$read`
or `$toRaw().getValue(...)` is the committed object itself, not a proxy —
mutating it in a later stage edits committed state in place. The dev-mode guard
above sees it only if the later stage also READS that key (the comparison is
per read); if it does not, the change is invisible: state moves, the log does
not. Never hold a raw value across a stage boundary; hold the key and read it
again.

## A handle that travels is a value

**Law: a handle the scope handed out is a value the engine accepts back.**
Every object read out of a scope is a Proxy; every value the engine RECORDS is
cloned (`structuredClone`, at commit since 9.23.0) — and a Proxy cannot be
cloned. So wherever the library itself carries an app-produced value out of
the stage that produced it, it takes the value BEHIND the handle first
(`handles.ts · unwrapHandles`): O(1) per handle (a registry lookup — no walk,
no JSON round-trip, a `Date` stays a `Date`), a copy-on-write walk only for a
plain container the app built around handles, and the SAME reference back for
a handle-free value. The boundaries that ask:

| Boundary | Site |
|---|---|
| `addParallelForEach` items selector — the items become `branch(item, index)`'s argument and each branch's seeded `item` | `ParallelForEachHandler · resolveItems` |
| a subflow `inputMapper` (the seed) and `outputMapper` (the merge-back) | `SubflowInputMapper · extractParentScopeValues` / `applyOutputMapping` |
| the explicit doors `$setValue`, `$update`, `$batchArray` | `createTypedScope · METHOD_ROUTES` |

```typescript
flowChart('Seed', (s) => { s.items = [{ id: 'a', facts: { latency: 12 } }]; }, 'seed')
  .addParallelForEach('Each', 'each', {
    items: (s) => s.items,                 // the scope's array HANDLE …
    branch: () => judge,                   // … each element crosses as a VALUE:
    into: 'results',                       // the branch's `item.facts.latency` is 12,
  });                                      // its seed commit clones fine

// Both doors store the value behind the handle, bytes intact (9.24.0):
s.$setValue('copy', s.customer);           // `copy.since` is still a Date
s.copy = s.customer;                       // … and so is this one (until 9.24.0: a string)
```

9.22.0–9.23.2 seeded the handle itself: every fan-out branch over an object
item failed its seed commit with `DataCloneError`, the best-effort policy kept
the slot as `undefined`, and the run resolved (9.23.3 fixed it). What is NOT a
handle stays a loud refusal — a function or a foreign Proxy inside a seed
still fails at commit under both policies, by design.

The value behind a handle is **borrowed** (the reads law): it is the same
reference a read hands back, cloned by the buffer at commit. `isHandle`,
`valueBehind` and `unwrapHandles` are exported from `footprintjs/advanced` for
a consumer that crosses a boundary of its own (a detach driver, a custom
recorder that clones).

## How the proxies are built

Five factories, one set of leaves (9.23.1). The rule: an **orchestrator**
only CALLS leaves in a readable sequence and holds state (a cache, a
`visited` set); a **leaf** computes one thing and never orchestrates. A fix
lands in a leaf once — the 9.22.0 stale-read bug was fixed in the element
proxy's traps and then found again in the nested and terminal copies, which
is the defect this shape removes.

| Orchestrator (file · symbol) | Holds | Decides itself |
|---|---|---|
| `createTypedScope.ts · createTypedScope` | the per-key child cache, `breakFn` | nothing — the top-level traps are `internalRead` → `wrapStateValue` / `assignStateKey` / `knownKey` / `stateKeys` |
| `createTypedScope.ts · createNestedProxy` | a per-member child cache, an immutable ancestor set | the cycle policy: an ancestor seen again becomes a terminal proxy |
| `createTypedScope.ts · createTerminalProxy` | a per-member child cache, ONE mutable `visited` set shared down the chain | the cycle policy: a value seen again is handed back raw |
| `arrayTraps.ts · createElementProxy` | a per-member child cache, an immutable `visited` set | the cycle policy: a value seen again is handed back raw (`wrapElementMember`) |

Every factory but the top-level scope registers what it builds in
`handles.ts · rememberHandle` with the same live reader its get trap uses, so
"the value behind a handle" and "what a read of it returns now" are one thing
(9.23.3).
| `arrayTraps.ts · createArrayProxy` | the per-index element cache | nothing — every trap body is a leaf |

The three object proxies wire the SAME traps: `liveView.ts · liveGetTrap`
(guards + the JSON law, then the child step above), `writeTraps.ts ·
sinkSetTrap` (take the assigned value as a value — a handle becomes what it
stands for — and hand it to the sink at the proxy's path plus the key),
`writeTraps.ts · sinkDeleteTrap`,
and `liveView.ts · liveInspectionTraps`.

Every child cache above is ONE leaf, `liveView.ts · cachedMember` over a
`MemberCache` (9.23.2): a proxy per member NAME under its parent, validated
by the raw member's identity, its map allocated on the first insert (an
element proxy over `{ id, n }` reads only primitives and never pays for one). A write through any proxy rebuilds the containers on its path
(`structuralWrite`), so the raw member is a new object afterwards, the
identity check misses, and the next read builds a proxy over the NEW value;
a hit can never be stale because every proxy reads live. Keyed by name under
the parent, never by the raw value alone — a diamond (`k.a` and `k.b` the
same array) needs two proxies, each bound to its own path. Before 9.23.2
only the top-level scope had this cache: `s.k.arr` built a fresh array
proxy, with a fresh empty element cache, on every access, so
`for (i < N) s.k.arr[i]` allocated N array proxies and N element proxies and
`s.k.arr[0] === s.k.arr[0]` was false. Where a write LANDS is a
`writeTraps.ts · WriteSink` (`readAt` / `put` / `remove`, a path measured
from the sink's root): `rootKeySink` for nested and terminal proxies (an
object leaf is a `merge` of a nested patch, an array leaf or a delete
rebuilds the root with `structuralWrite.setInPath` / `deleteInPath` and
commits a `set` of the key — law 3), `elementSink` for element proxies
(every write rebuilds the owning array and hands the WHOLE array to the
array proxy's commit). An array below either sink is `arrayTraps.ts ·
arrayProxyAt` — the one funnel `push` three levels down and `arr[i].x = v`
at the top share.

The array proxy's own leaves, one concern each: `mutatingMethod` (run on a
copy, arguments unwrapped, commit the copy), `setIndex` / `setLength` (fill
skipped slots with `null`, JSON's spelling of a hole), `deleteSlot`,
`cachedElement` (a proxy per index, validated by identity), `indexIn` /
`indexNamed` (the historical `Number(prop)` reading of an index name),
`boundMember` (a non-mutating read answers from the CURRENT array).

The same shape governs the commit funnel: `memory/TransactionBuffer.ts ·
toDeltaPayload` reads as `opsByPath` → `netChangeSurvivors` →
`groupIntoFamilies` → `memoisedFamilyValue` → the verb switch →
`emitInFamilyOrder`. The verb switch is deliberately NOT a leaf — it is the
delta encoder's own replica of the verb law (CLAUDE.md, "FOUR verb-switch
replicas in lockstep") and stays in one body; the leaves are extracted
around it, never from it. `changedSinceBase` is the ONE net-change verdict
both encodings ask.

Proven byte-identical to 9.23.0 by the reference suites in both
`commitValues` modes and a 13,000-program differential fuzz (see CHANGELOG
[9.23.1]).

## $-Prefixed Methods

Non-enumerable escape hatches (don't appear in Object.keys or destructuring):

$getValue, $setValue, $update, $delete, $read, $getArgs, $getEnv,
$debug, $log, $error, $metric, $eval,
$attachScopeRecorder, $detachScopeRecorder, $getScopeRecorders, $break, $toRaw

## Allowlist

Only plain, unfrozen objects and arrays get deep Proxy wrapping. These are returned unwrapped:

- Date, Map, Set, RegExp, class instances, TypedArrays, Promise, Error, WeakRef
- Object.freeze()'d and Object.seal()'d values (nested set traps would silently fail)

## Performance Guidance

**Arrays:** Each `push`/`splice`/`sort`, and each write through an element
(`lines[0].qty = 4`), clones the array (copy-on-write) and — for an array below
the top level — the containers on the path down to it. Element proxies are
cached per index and validated by identity, so repeated reads of an unchanged
element are free. For bulk operations on large arrays, build the final array and
set it once:

```typescript
// Slow: N clones for N pushes (O(n^2) total)
for (const item of items) scope.tags.push(item);

// Fast: one clone (O(n))
scope.tags = [...scope.tags, ...items];
// Or via $setValue:
scope.$setValue('tags', [...scope.$getValue('tags'), ...items]);
```

Same guidance as MobX: prefer batch assignment over repeated mutations for large collections.

`$batchArray(key, fn)` is the other one-clone path: `fn` receives a DEEP copy
(`structuredClone`) of the array and the result commits once as a `set` of the
key — an element edited inside `fn` (`arr[0].n = 9`) lands in that one write and
never touches the value in state (9.22.0; a shallow copy used to share the
committed elements).

**`s.k` in a loop is N tracked reads.** Each `scope.k` is a tracked read of
`k`, and under the default `readTracking: 'full'` each one retains a
`structuredClone` of the value (`StageContext.getValue`) — ~0.25 ms per read
when `k` holds 1,000 object elements, ~2.5 ms at 10,000 — so
`for (i < N) s.k.arr[i]` is O(N × |k|) under that dial whatever the proxy
does. Hoist it: `const arr = s.k.arr` reads `k` once, and the element cache
serves every index. The proxy's own cost is the other, smaller term
(`bench/nested-reads.ts` measures both dials; see CHANGELOG [9.23.2]).

**N element writes in one stage produce N whole-array rows.** Every
`arr[i].n = i` is a `set` of the ROOT key (law 3), so a loop of N of them stages
N whole-array trace rows in ONE bundle — the log records what happened, and N
things happened. The commit and every fold of that bundle are O(N) since 9.22.1
(a row a later row re-sets is not cloned twice). Since 9.23.0 nothing else in
the write path is O(N) per write either: the buffer and the tracked-writes
record hold the new array by reference and copy it once at commit
(`memory/README.md`, "clone once at commit"), and the array traps copy
nothing at the write: since 9.24.0 the ASSIGNED value — the index-set element,
a method's arguments, an element proxy's leaf — is stored as assigned (a
handle becomes what it stands for, O(1)); until 9.23.0 the whole rebuilt array
went through a JSON round-trip on every element write. What the stage body still pays per
write is the proxy's own copy-on-write, one shallow copy of the array
(`arrayTraps` · `replaceInElement` and the traps' `[...getCurrent()]`, ~1 ns
per element). Measured (`bench/element-writes.ts`, 2026-09-11, `loop` total /
body): 1,000 element writes 609 → 5.7 / 2.6 ms; 10,000 61,548 → 104 / 75 ms,
of which the shallow copies are ~89 ms — so beyond ~10k elements the loop is
still quadratic in that copy, at a constant 10,000× smaller than 9.22.1's.
`$batchArray` is the bulk path: one row, one copy — ~2× cheaper in the body at
N = 1,000 and ~6× at N = 10,000.

## Serialization

`JSON.stringify(scope.someObject)` returns exactly what `JSON.stringify(scope.$getValue('someObject'))`
returns -- nested objects, arrays and Dates included. The proxy's `toJSON` hands
JSON.stringify the underlying state object BY REFERENCE (no clone), so the two
read paths cannot drift apart. See `jsonProjection.ts`.

Two consequences worth knowing:

- **Assignment stores the value behind the handle.** `scope.copy = scope.results`
  commits the full structure, by reference to the value the handle stands for,
  detached by the buffer at commit — a `Date` stays a `Date`, a `Map` keeps its
  members, the same bytes `$setValue` stores (9.24.0; until then the trap JSON
  round-tripped the value and the two doors disagreed). A value NOTHING can
  clone — a function, a framework's own reactive Proxy — now fails the stage
  at commit through the trap too, loudly, as it always did through `$setValue`.
- **structuredClone cannot clone a Proxy.** `structuredClone(scope.obj)` throws
  `DataCloneError`; that is a JS limitation, not a footprint one. It is loud, not
  silent. Clone `scope.$getValue('obj')` instead.

## Limitations

- Cannot track if conditions (JS Proxy cannot intercept comparison operators)
- Nested reads fire onRead only at top-level key, not per nested property
- JSON.stringify(scope) fires a get trap per state key -- each is a real tracked
  read (the value is serialized). The `toJSON` probe JSON.stringify makes first is
  NOT tracked, unless `toJSON` is genuinely a state key.
- String coercion of the scope itself (`` `${scope}` ``) throws
  "Cannot convert object to primitive value" -- `toString`/`valueOf` resolve to
  state lookups, not methods. Serialize or read a key instead.
- User state keys starting with $ collide with ScopeMethods
- Class instances in state are returned unwrapped (no deep write tracking)
- Elements reached through a read METHOD (`find`/`filter`/`for…of`/`forEach`)
  are unwrapped by design -- mutating one is warned about in dev mode (under
  `readTracking: 'full'`) rather than intercepted (see "What the proxy cannot
  see")
- A scope handle held past its stage's commit refuses writes -- it throws (see
  "A handle is bound to its stage"); a RAW handle held that long cannot be
  caught at all
- Out of contract, dropped or refused as follows (named in review of 9.22.0,
  deliberately NOT fixed):
  - a cyclic self-reference reached through a terminal proxy
    (`scope.k.self.arr.push(1)`, `scope.k.self.arr[0].n = 9`, `scope.k.self.o.x = 9`)
    commits its array/element write to the WRONG place -- a row is recorded and
    the fold agrees with state, but the value lands beside the cycle edge, not
    where the expression pointed. Flatten the structure; a cycle is a legal
    value, not a write path.
  - a top-level key containing U+001F (the trace path separator) throws at the
    seed (`scope['x\u001Fy'] = …`). The character is reserved; there is no
    escaping.
  - an expando property on an array (`scope.k.arr.foo = 1`) is dropped: the
    array proxy's set trap handles indices and `length` only, so the write
    never reaches the log or state.
- Frozen/sealed objects are returned unwrapped (replace entire value to update)
- Circular references: detected via ancestor tracking (Set<object> per access chain).
  At the cycle break point, a terminal proxy is returned -- reads pass through (correct
  values), writes are tracked at any depth (terminal proxies chain for nested objects).
  Serializing a circular scope value prunes the back-edge (that key is omitted;
  an array slot becomes null) and does NOT throw -- the one place the property
  path deliberately differs from `$getValue`, which throws like standard
  JSON.stringify. A diamond is not a cycle and serializes on both paths.
