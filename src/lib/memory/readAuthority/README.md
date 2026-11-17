# Private read authority

This folder observes existing owner state without invoking user code. It does not track reads or produce recorder paths.

| Owner        | Responsibility                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `identity`   | Weak identity minted by direct original constructors; original prototype and method descriptors |
| `intrinsics` | Captured descriptor operations and brand-first native Set cardinality                           |
| `rule`       | Complete current marked/policy/inherited predicate; inert, active or unknown                    |
| `policy`     | Only native frozen policy creation sites mint carrier identity                                  |
| `context`    | Read the actual current DATA policy carrier, including replacement; never a cached Rule         |

Only the `memory/readAuthority.ts` facade and this folder import these modules. Original constructors register weakly, without adding fields or changing public method behavior. Unknown identities are refused before reflection. Set branding precedes prototype/descriptor inspection so a Proxy receives no trap. Custom methods, accessors, subclasses, shadows and changed original descriptors are unknown.

`rule.test.mjs` and `context.test.mjs` exercise real owners, shared marks, current-carrier replacement, callback/trap refusal and unchanged borrowed value behavior. Metadata can observe current inert state after unseen shared Set mutations clear; this is no interval certificate. There is no epoch, mirrored policy, live A/B/C sampling, call-local read holder, native paired read or recorder event change. The later event-time adapter and its public path/dependency adoption require their own source scope and proof.

Existing `redaction.ts` and `StageContext.ts` remain oversized owners; only whole constant units are extracted in this phase to keep their ratchets shrinking. This is not a completed class split. Packed CJS/ESM, public/runtime-key parity, full hosted gates and unchanged bundle budgets remain required for this private foundation.

`keys.test.mjs` uses `test/fixtures/read-authority-parent-keys.json`, captured from exact Main ab021ccb65e73426a22fee5e0183b3886a588197 with the three runtime owners restored byte-for-byte before source capture. Parent and candidate public/default controls pass separately. The fixture pins actual public exports and Rule/context/facade own/prototype keys, not a new API or raised baseline. `test/architecture/read-authority-package.test.ts` packs the real built package on hosted CI and repeats those checks in fresh CJS/ESM processes, reusing the existing locked physical Foottrace. This does not prove a new native API, strict future-version pair or event-time integration. Its disposable package/cache/extraction are removed in `finally`.
