# Inspect a recorded value with `why`

Run `why` in a FootPrint checkout with Node.js 22 or newer. It reads a saved
`getSnapshot()` JSON file and explains the final recorded value of one root
state key.

```sh
npm ci --prefix tools/why
npm run --silent why -- snapshot.json answer
```

Enable [capture before the run](../../docs/guides/explain.md) and save the
snapshot with its root log address and execution tree. The command returns JSON
with the last recorded writer, the recorded dependencies behind it, and
retained writes to the same key that left its value unchanged. The output
includes reader gaps for evidence that is missing, redacted, or incomplete.
`valueBasis` describes the final recorded value, including deletion, separately
from the last writer and its evidence. Keys and record identifiers remain
visible. The command emits no state values.

If your application produced a bound Foottrace source-link inventory for this
same root snapshot, pass its JSON file explicitly.

```sh
npm run --silent why -- snapshot.json answer --source-links source-links.json
```

The source-link result preserves Foottrace's witnessed and declared standing
and any gaps. The inventory supplies evidence about the selected root. Without
it, source-link coverage reads `not-collected`.

The command operates on local JSON files of up to 16 MiB. Its separately locked
Foottrace reader is a checkout tool. It runs independently of the application
and its installed engine.

Run the command tests with `npm test --prefix tools/why`. To verify the command
against native saved snapshots, build FootPrint with `npm run build` and run
`npm run test:native --prefix tools/why` from the checkout.
