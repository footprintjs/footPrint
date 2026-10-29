# Attempt effects outside a stage — `attempt()` ends, touches, the exported law, and the series' effect (design, 2026-10-29)

**Status: Design for review. Not approved to implement.**

Four items from the consumer requirements ledger (L-27, L-36, L-37, L-38), read against footprintjs `origin/main`
25999ff (10.7.1). The consumer that raised them pins `footprintjs ^10.6.0` and runs one standalone `attempt()`
series per outside request, reading every `AttemptRecord` through `onAttempt`. Names marked † are proposed and do
not exist yet. Where this page and the code disagree, the code wins.

## 0. What exists (checked before designing)

| Asked for | Found on main | Gap |
|---|---|---|
| The runner's end-of-series summary | `attempt/runner.ts · AttemptRunOptions.onEnd`, called once with the `AttemptSummary` — also after a wait the signal or the deadline cut | `attempt/standalone.ts · AttemptOptions` has `onAttempt` only; `onEnd` is not passed through |
| A cut wait as its own fact | `runner.ts · sleep` resolves on abort by design; the loop then computes `cut` (`'aborted'` / `'no-time-left'`), hands `onEnd` a summary with `next: 'stop'` and rethrows the last attempt's error. No record is made for the attempt that never started | The summary's `last` is the last record's fields with `next`/`reason` overwritten; nothing names the wait. The standalone caller cannot see the summary at all |
| "ok" = an answer arrived | `types.ts · AttemptOutcome`: `'ok'` is the function returning. The rule's label for it is `'succeeded'` (`decision.ts · retryRules`, rule 1; `AttemptReason`), and the narrative prints "succeeded in 31ms" (`narrative/formatting/sentences.ts · attemptSentence`) | The word, not the fact |
| The effect law for a touching target | `attempt/effect.ts`: `touchesProblem`, `callTouches`, `admitIdempotencyKey`, `effectOf`, `unknownEffectError`, `refuseKeylessRetry`; the runner takes `AttemptRunOptions.effect: EffectTarget` and stamps `system` / `idempotencyKey` / `effect` on every record; `call.ts · runCall` passes the stage's `$call` declaration through | `standalone.ts` never builds an `EffectTarget`, so `attempt()` cannot declare `touches` |
| The key's format rule | `ids/idempotencyKey.ts · idempotencyKeyProblem` (1–255 printable ASCII, no space) and `MAX_IDEMPOTENCY_KEY_LENGTH` | Neither is on a public door (`src/index.ts` exports `attempt`, `errorCategory`, `UnknownEffectError`, the types) |
| `effectOf` | `effect.ts · effectOf(outcome, error)`: `ok → 'applied'`; `failed` with `error.effect === 'none'` → `'none'`; else `'unknown'` | Not exported |
| The series' effect | `runner.ts · lastOf`: `last.effect` is `'unknown'` when any attempt was unknown AND the series did not end `ok`; a series that ends `ok` after an unknown attempt says `'applied'` (`types.ts · AttemptSummary.last.effect`: "unless the series ended with an answer") | L-38: that `'applied'` hides "may have applied more than once" |

Existing tests that pin the current law: `test/lib/attempt/unit/standalone-attempt.test.ts`,
`test/lib/attempt/property/effect.property.test.ts`, `test/lib/attempt/scenario/side-effects.test.ts`,
`test/lib/attempt/security/side-effect-threats.test.ts`.

## 1. One law: answered, succeeded, cut

Stated once; every item below uses these three words and no others.

- **Answered** — the attempt's function returned a value. That is all `outcome: 'ok'` means. The value may be a
  503 response, a tool error inside a 200, or a refusal: the runner cannot read it, so the record never calls it
  success. The rule label and the narrative word follow the fact: `'answered'`†, not `'succeeded'`.
- **Succeeded** — the caller's verdict on an answer. The library never records it. A consumer that knows what the
  answer meant (a status, a tool result's `isError`) writes its own word beside the record; the record stays
  what the runner saw.
- **Cut** — the series ended without the attempt's function returning or throwing its own error: the attempt's
  cap or the deadline (`outcome: 'timeout'`), the caller's signal in flight (`outcome: 'aborted'`), or the signal or
  deadline landing in the wait between two attempts (no record; summary `reason: 'aborted' | 'no-time-left'`,
  `last.during: 'wait'`†). A cut attempt was sent: its effect is `'unknown'`, never `'none'` (the law `effect.ts`
  already states for a timeout, extended to the wait by name).

Corollary for effects: `effect: 'applied'` means "the target answered" — never proof of a write, and never a count.

## 2. L-27 — `attempt()` reports how the series ended

**Current behaviour.** `standalone.ts · attempt` wires `onAttempt` only. The runner's `onEnd` fires, with the only
summary that says a wait was cut, into nothing. A consumer that needs "the series ended during a wait" has to
infer it from the last record's `next: 'retry'` and the rejection arriving with no further record. The reason label
on an answered attempt is `'succeeded'`.

**Decision.**

1. `AttemptOptions.onEnd?: (summary: AttemptSummary) => void`† — passed through to the runner's `onEnd` exactly as
   `onAttempt` is: once per series, before the last `onAttempt` (or after a cut wait, when no record follows),
   isolated the same way (`standalone.ts · deliver`: a throw never changes the call's outcome; dev mode warns).
2. `AttemptSummary.last.during?: 'wait'`† — present only when the series ended between attempts: the signal cut the
   wait (`reason: 'aborted'`) or the deadline landed in it or passed before the next attempt could start
   (`reason: 'no-time-left'`). Then the last record says `next: 'retry'` and no record of the next attempt exists.
   One field, one place (`runner.ts`, the `cut` branch), so the stage path reports it too (`StageSnapshot.attemptSummary`).
3. Rename the reason: `AttemptReason` `'succeeded'` → `'answered'`†, in `decision.ts · retryRules` rule 1 (the
   labels are the reasons), `recorder/attemptMetricRows.ts` (the admitted reason set), and the narrative word in
   `sentences.ts · attemptSentence` ("answered in 31ms"). `outcome: 'ok'` keeps its name (Q1).
4. What a cut wait rejects with is unchanged: the last attempt's own error, or `UnknownEffectError` on a touching
   target that had an unknown attempt (`runner.ts · stopError`). One law for the stage and the standalone runner;
   the summary, not the thrown value, says the series was cut (Q2).

**Public API change.** `AttemptOptions.onEnd`†, `AttemptSummary.last.during`†, `AttemptReason` value
`'answered'`†. No new door.

**Compatibility (10.x, no shims).** Breaks, named in the CHANGELOG: every reader of `reason === 'succeeded'` (the
recorder's row admission, consumer switches, narrative fixtures with "succeeded in"). `last.during` and `onEnd` are
additive. `sleep` keeps resolving on abort: the runner re-checks the signal itself, and a rejecting sleep would move
the abort check ahead of the discard and change the 9.15 order the runner preserves.

**Tests.** Unit: `onEnd` fires once with the summary, before the last `onAttempt`; a throw in it is isolated. Scenario:
a signal aborted during the wait → `onEnd` summary `{ next: 'stop', reason: 'aborted', during: 'wait' }`, no further
record, rejection = the last attempt's error; the same for a deadline inside the wait (`no-time-left`). Property:
for any script of outcomes and any cut point, `last.during === 'wait'` iff the last record's `next === 'retry'`, and
`count === ok + failed + timeout + aborted + paused` with `ok ≤ 1` (an answer ends the series). Byte identity: a run
without a cut wait keeps its summary bytes but the renamed label.

## 3. L-36 — `attempt()` can declare a side-effecting target

**Current behaviour.** `effect.ts` has the whole law — refusal of a keyless retry, the key's format, the effect
per attempt, `UnknownEffectError` — and `runner.ts` applies it to any series handed an `EffectTarget`. Only the
stage (`.touches()`) and `scope.$call(…, { touches, idempotencyKey })` build one. Outside a run the consumer
re-implements: it writes its own `changes: true` guard, its own key check, its own effect per attempt.

**Decision.** `AttemptOptions` gains the `$call` shape, verbatim — `touches?: string`† (the outside system, a
name under `attempt/name.ts`) and `idempotencyKey?: string`† (the key, a value the caller derived from its input
or state). Admission is the existing `effect.ts · callTouches(where, { touches, idempotencyKey }, policy)`,
called in `standalone.ts · readOptions` before anything is sent: a key without a system, a malformed key, or a
touching target whose policy may retry (`attemptCeiling > 1`) with no key is a `TypeError` naming the field, never
the value. The admitted pair becomes `AttemptRunOptions.effect = { system, idempotencyKey }`; there is no run and
no redaction rule, so `recordedKey` is the key itself.

From then on the standalone series behaves as a `$call`: every record carries `system`, `idempotencyKey` and
`effect` (`effectOf`); the function's `AttemptContext` carries `system` and `idempotencyKey`; a series that ends
without an answer after any attempt of unknown effect rejects with `UnknownEffectError { system, idempotencyKey,
attempts, cause }` (`runner.ts · stopError`), never the attempt's own error.

**The effect law outside a stage.** Same words as inside: *no blind retry of an outside effect*. A target that
touches a system and may retry must carry a key, and the refusal happens at the door, before the first attempt. The
difference outside a run is who keeps the record: `onAttempt` is the only sink, so the caller's callback is the
one place the key and the system name leave the runner.

**Threat model.**

| Threat | Where it is stopped |
|---|---|
| A side-effecting target retried without a key — a charge sent twice | `callTouches` refuses `touches` + `attempts > 1` + no key before attempt 1; `runner.ts · refuseKeylessRetry` refuses it again at the last door |
| A key the model wrote, or one that changes per attempt | The key is a VALUE the caller computed once; the runner hands the same string to every attempt. The format rule rejects what cannot travel in a header. What the value was derived from is the caller's law (the doc says: input or state, never model output) — the library cannot check provenance outside a run |
| A key forged into a request header (CR/LF, control bytes) | `ids/idempotencyKey.ts`: printable ASCII only, no space, ≤ 255 |
| A declined retry read as "nothing happened" | A failed attempt is `'none'` only when its error declares `effect: 'none'`; a timeout, an abort and a cut wait are `'unknown'` |
| The key or system name leaking into a log the caller did not mean to keep | No redaction rule exists outside a run. The note says so on `AttemptOptions.idempotencyKey`: the caller's `onAttempt` must scrub what it keeps. The error (`UnknownEffectError.idempotencyKey`) carries the key as every record does |
| A series that answers after an unknown attempt and is read as "applied once" | L-38 |

**Public API change.** `AttemptOptions.touches`†, `AttemptOptions.idempotencyKey`†. The type `CallOptions` is not
reused by name (its doc speaks of `$getArgs()` and `interrupt()`), but the fields and their admission are the same.

**Compatibility.** Additive. A caller that passes neither field is byte-identical.

**Tests.** Unit: the three refusals (key without system, bad key, keyless retry), each naming the field and never
echoing the key. Scenario: a touching series whose attempt 1 timed out and attempt 2 answered → records
`[unknown, applied]`, resolves; attempt 1 timed out and attempt 2 failed `effect: 'none'` → rejects with
`UnknownEffectError`, `cause` = attempt 2's error. Property (extend `effect.property.test.ts`): for any script, the
records of `attempt(fn, policy, { touches, idempotencyKey })` equal the records of the same script under
`scope.$call(target, fn, policy, { touches, idempotencyKey })` after dropping `series`, and the thrown value's class
is the same. Security (extend `side-effect-threats.test.ts`): a key with `\r\n` is refused at the door with no
request sent (a counting `fn`).

## 4. L-37 — export the law, not a copy of it

**Current behaviour.** `effectOf` and `idempotencyKeyProblem` are internal. The consumer records every thrown
failure as `'unknown'` — it cannot read `effect: 'none'` the way the runner does — and checks "carries a key" as a
non-empty string, so a key with a space or a CR passes its guard and is refused only if it ever reaches the
runner.

**Decision.** Export from the root door (`src/index.ts`, beside `errorCategory`):

- `effectOf(outcome: AttemptOutcome, error: unknown): AttemptEffect` — unchanged, the one reading.
- `idempotencyKeyProblem(value: unknown): string | undefined` and `MAX_IDEMPOTENCY_KEY_LENGTH` — the one format rule,
  under their existing names (plain, no suffix; the `errorCategory` precedent for a classifier exported as-is).

Not exported: `admitIdempotencyKey` (a throwing wrapper with the library's own `where` text), `touchesProblem` and
`callTouches` (they read a `RetryPolicy` and the builder's shapes; a consumer that wants the admission gets it by
calling `attempt()` with `touches`, L-36).

**Public API change.** Three names on the root door. `scripts/doors.mjs` resolves them to `attempt/effect.ts` and
`ids/idempotencyKey.ts`, neither a record file, so the extraction gates (`check:trace-ready` R3/R5) do not trip.

**Compatibility.** Additive.

**Tests.** The root-door export test gains the three names. Property: `idempotencyKeyProblem(s) === undefined` iff
`s` matches `/^[\x21-\x7e]{1,255}$/` over `fc.string()` (and `fc.fullUnicodeString()`); `effectOf` is total over
`AttemptOutcome × { null, primitives, objects, a throwing getter }` and returns `'none'` only for `failed` with a
plain own `effect: 'none'`.

## 5. L-38 — the series' effect, and "may have applied more than once"

**Current behaviour.** `runner.ts · lastOf` folds the series' knowledge into `last.effect`: `'unknown'` sticks only
while the series has not answered; an answer after an unknown attempt reports `'applied'`. `types.ts ·
AttemptSummary.last.effect` documents exactly that. So a series [timeout, ok] on a touching target says `applied`,
and a consumer reading it as "applied once" may skip the reconciliation the first attempt needs.

**Decision.** Separate the two facts the summary mixes.

1. `AttemptSummary.effect?: AttemptEffect`† — the SERIES' effect, touching targets only, with one rule:
   - `'unknown'` once any attempt's effect was `'unknown'`, whatever came after — a later `'none'` cannot clear it,
     and a later answer does not say how many times the effect applied;
   - `'applied'` when the series answered and no attempt was unknown — applied exactly once;
   - `'none'` otherwise — every attempt said nothing was sent.
2. `AttemptSummary.last.effect` becomes the LAST attempt's own effect (its record's), no folding. `last` means last.
3. The rejection rule is unchanged: a touching series that ends WITHOUT an answer after an unknown attempt rejects
   with `UnknownEffectError`; a series that answers resolves with its value, and the uncertainty travels in the
   summary.

**The series-level wording rule — exact values and how a consumer reads them.**

| `summary.effect` | `summary.ok` | Reads as |
|---|---|---|
| `'none'` | `0` | nothing was sent |
| `'applied'` | `1` | applied once (the answer's attempt; no attempt before it was unknown) |
| `'unknown'` | `0` | may have applied; the series rejected with `UnknownEffectError` |
| `'unknown'` | `1` | applied, and may have applied more than once: reconcile under the key before any new send |

No fourth value: "more than once" is `effect: 'unknown'` beside `ok: 1`, two fields the summary already has. The
values stay the three `AttemptEffect` words so a row, a record and a summary are compared with one set.

**Public API change.** `AttemptSummary.effect`†; the meaning of `AttemptSummary.last.effect` changes. The attempt
metrics recorder reads `record.effect` per row (`recorder/attemptMetricRows.ts`, `attemptMetrics.ts ·
effectUnknown`) and is unchanged; the narrative sentence is per attempt and unchanged.

**Compatibility (10.x, no shims).** Break, named in the CHANGELOG: `last.effect` on a series that ended without an
answer after an unknown attempt was `'unknown'` and now is the last record's own effect (`'none'` when the last
attempt declared it); readers move to `summary.effect`. A series with no unknown attempt keeps its bytes but for the
added field.

**Tests.** Unit: the four rows of the table, from scripted outcomes. Property (extend `effect.property.test.ts`):
for any script, `summary.effect === 'unknown'` iff some record has `effect: 'unknown'`; `=== 'applied'` iff the
last record is `ok` and none is unknown; `=== 'none'` otherwise; `summary.last.effect === records.at(-1).effect`;
and `summary.effect === 'unknown' && ok === 0` iff the series rejected with `UnknownEffectError`. The same property
over the stage path (`StageSnapshot.attemptSummary`), since one runner serves both.

## 6. The CHANGELOG, in one place

One 10.x minor, under **Breaks**: `AttemptReason` `'succeeded'` → `'answered'` (rows, switches, narrative
"answered in"); `AttemptSummary.last.effect` is now the last attempt's own effect — read `AttemptSummary.effect` for
the series. Under **Added**: `attempt()` `onEnd`, `touches`, `idempotencyKey`; `AttemptSummary.effect`;
`AttemptSummary.last.during`; `effectOf`, `idempotencyKeyProblem`, `MAX_IDEMPOTENCY_KEY_LENGTH` on the root door.
No deprecation path, per the owner's rule. Consumers are fixed in the same train (the compat sweep before release).

## 7. Open questions, each with a proposed answer

- **Q1. Rename `outcome: 'ok'` too?** Proposed: no. `'ok'` already means "returned" in `AttemptOutcome`'s doc and in
  every recorder row and fixture; the word that overclaims is the reason label, so that is the one renamed.
- **Q2. Should a cut wait reject with the signal's reason (or the deadline's) instead of the last attempt's error?**
  Proposed: no, in this design. Both runners share `stopError`; changing the stage's rejection on a cut wait changes
  what `run()` rejects with for every retried stage under a cancel. The summary names the cut. Revisit if a consumer
  shows a case the summary cannot serve.
- **Q3. Is the `'succeeded'` → `'answered'` rename worth the narrative byte change?** Proposed: yes. The narrative is
  what a person reads; a line that says a 503 "succeeded" is the overclaim this ledger is about. The byte-identity
  fixtures for retried stages are regenerated once, in the same PR.
- **Q4. Should `summary.effect` get a fourth value for "applied, possibly more than once"?** Proposed: no. Two
  existing fields carry it (§5); a fourth word would have to be mirrored into rows and the metrics recorder.
- **Q5. Should the standalone runner accept a key RULE (`(ctx) => string`) like a stage?** Proposed: no. There is no
  execution to hand it, and a value computed once by the caller is the `$call` precedent. A rule would invent an
  `IdempotencyKeyContext` with no `args`, `runId` or state.
- **Q6. Minor or major?** Proposed: minor, with the breaks named — the repo's practice since 9.4x. The owner decides.

## 8. Not in this design

- A redaction rule for standalone records — there is no run and no policy; the caller's `onAttempt` scrubs.
- A series-level effect in the attempt metrics recorder or its OTel projection (rows stay per attempt).
- A change to `sleep` (it keeps resolving on abort), to the retry rule table's order, or to the stage path's
  rejection on a cut wait (Q2).
- A reconciliation helper ("look the key up before sending again") — the consumer's, built on `UnknownEffectError`
  and `summary.effect`.
- Observed attempts (`AttemptContext.observed`) — they carry no effect today and this page does not add one.
- Anything in foottrace: no record shape, codec or attention mark changes.
