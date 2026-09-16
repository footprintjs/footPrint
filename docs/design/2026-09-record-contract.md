# The record contract — time travel over a declared record (2026-09-16)

Status: PLAN, tracked here. Facts found while building change the plan in
this file, not in a chat.

## The ask

Time travel, the fold and the lenses read a finished run's RECORD. Nothing
in that chain calls the executor. So a team whose runtime is not
footprintjs — a workflow engine, a state machine, a batch job — gets the
cursor, the fold and the Lens the moment it writes the record's shape. That
shape is the interface; it has never been written down as one. Packet B
writes it down, guards it at the reader, and proves it with a record built
by hand and read end to end, with no executor in the room.

## Facts (what exists — read before designing)

- The reader accepts `TimeTravelSource { commitLog?: unknown[]; history?;
  initialState?; executionTree? }` (`time-travel/types.ts`). `commitLog`
  is `unknown[]` on purpose (9.18.0): a stored record is parsed JSON and
  the reader narrows PER BUNDLE (`bundles.ts · readLog`); a bundle that
  does not narrow is a GAP `{ index, reason }` reported in
  `FoldedState.skipped`, never a refusal of the whole record. That is the
  contract's honesty rule already in force: omit-never-deny.
- Gap reasons today (`bundles.ts · bundleRefusal`): not an object;
  `runtimeStageId` missing or not a string; `trace` missing or not an
  array; `updates` / `overwrite` present but not a plain object. An
  unknown VERB on a trace row is NOT a gap: the replay's switch
  treats anything that is not `set` / `append` / `delete` as `merge`
  (`memory/utils.ts · applySmartMergeInto`) — a silent coercion the
  contract must close. DECIDED: the whole BUNDLE is a gap
  (`trace[i].verb is "x", not set | merge | append | delete`) — a gap is
  per bundle already, and a producer that got one row wrong got the
  bundle wrong; the rest of the record still folds and `skipped` says
  which bundle and why.
- A bundle (`memory/types.ts · CommitBundle`): `idx?`, `stage`, `stageId`,
  `runtimeStageId`, `trace[{ path, verb, readKeys? }]`, `overwrite`,
  `updates`, `redactedPaths`, `tags?`. `idx` equals the array position —
  the reader's stops are derived from position, so `idx` is advisory in the
  stored form.
- The address: `runtimeStageId = [subflowPath/]stageId#executionIndex`;
  every parser in the family splits on the LAST `#` and `/`; `~` is
  reserved for generated branch segments. A foreign record must follow it
  or the axes and the lens's stage lookups break.
- The tree: `executionTree` is a `StageSnapshot` linked by `next` and
  `children`; the reader's stops need it only for kinds and grouping
  (`commitStops(log, tree?)` works without it). A foreign record may omit
  it and gets the commit axis; with declared `tags` on bundles it gets
  `tagStops` too. The milestone axis is agentfootprint's vocabulary and is
  not part of this contract.
- Examples are integration tests: `examples/<folder>/NN-name.ts` with an
  `.md` sidecar, type-checked and run by `npm run test:examples`.
- No record version field exists. Adding one changes every stored byte
  the family pins (agentfootprint byte-identity references, lens
  fixtures). DECISION: the contract is versioned by the footprintjs
  version named in the page and its changelog; a `format` field is NOT
  added in this packet — flagged for the owner.

## The cut (one at a time)

1. **The contract page** — `docs/guides/record-contract.md`: the record's
   shape field by field; the laws (frozen base; append-only; one bundle
   per stage; four verbs; the address format; tags declared, never
   runtime); what the reader promises (fold, stops, gaps, basis); what a
   foreign producer must and need not write; what is agentfootprint's and
   not this contract's.
2. **Guards** — the unknown-verb gap at the reader, pinned; the existing
   gap reasons pinned in one test file that reads as the contract's
   refusals (`test/lib/time-travel/record-contract.test.ts`).
3. **The example** — a record built by hand, no executor: base +
   bundles with all four verbs + a tag, fed to `timeTravel()`; asserts the
   fold at each stop, the tag axis, and a gap for a malformed bundle.
   Sidecar `.md` tells it as "bring your own record".
4. **Docs and links** — the guide linked from the main README and the
   time-travel README; CHANGELOG entry (docs + one guard = minor).
5. **Proven in the Lens** — FACT: docs-next has no Playwright harness, and
   the `<Lens>` needs agentfootprint's recording (events), which is outside
   this contract. So the React proof lives where the views live: a lens
   test mounts `<ContextView runner={record}>` over the same hand-built
   record — its own axis from the declared tags, the fold at each stop,
   the writers, a skipped bundle shown. A docs-site page with a Playwright
   check is a separate decision (a harness to build); not in this packet.

## Track

- [x] 1 page (`docs/guides/record-contract.md`) · [x] 2 guards (unknown verb → bundle gap; `test/lib/time-travel/record-contract.test.ts` pins every reason) · [x] 3 example (`examples/post-execution/time-travel/06-bring-your-own-record.ts`; FACT: `tagStops(names)` is a STRATEGY handed to `timeTravel`, not a stop list) · [x] 4 links (README, time-travel README) + CHANGELOG 9.27.0; FACT: stop kinds are start | commit | end · [ ] 5 docs-site proof
