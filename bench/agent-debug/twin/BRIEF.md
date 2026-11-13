# What the twin's writer was told

The ordinary-code twin was written by an agent that saw only a kit (the specification, the data tables, the fixtures and their expected results, one test) and the two messages below. They are copied from the record of its session, unedited. `<folder>` stands for the writer's working folder on the machine it ran on.

## Message 1 (the brief)

# Build brief: write a small command-line program from its specification

Your folder, and the ONLY place you work:

`<folder>/`

Everything you need is already in it:

- `SPEC.md`: the specification of the program ("the order desk"): what goes in, what comes out, every rule.
- `data/`: the data tables the rules use.
- `fixtures/`: example orders.
- `expected/`: for every fixture, exactly what the program must print (`<name>.json`), and its exit code where that is not 0 (`<name>.exit`).
- `test/kit.test.mjs`: a test that runs your program on every fixture and compares. Do not change it.
- `README.md`: how the program is run and tested.

## One rule about where you look

Read and write only inside your folder. Do not open, list or search any other file or folder on this machine (not its parent folders either), do not use the network (no clone, no install, no web search), and do not look for an existing implementation of this program anywhere. Everything you need is in the folder; the record of this session is checked afterwards for anything read outside it, and work that used something else is thrown away. If you find that something you need is missing, do not go looking for it: stop and say what is missing in your final message.

Shell notes: start EVERY command with `cd` into your folder, using the full path above (the working directory resets between calls, and a command run elsewhere counts as looking elsewhere). Use the file tools only with full paths inside your folder. Run nothing that needs the network. A foreground `sleep` is blocked.

## What to write

The program, as ordinary Node.js that a colleague will maintain for years (Node 22, ES modules, only Node's standard library, no dependency):

- `src/run-order.mjs`, the command: `node src/run-order.mjs fixtures/<name>.json` prints the result and sets the exit code as `SPEC.md` says.
- Whatever other modules under `src/` you find natural. Plain modules and functions that call each other, `if` and loops. You decide how many files and how they are named; organise it the way you would want to find it when you come back in a year.
- A doc comment on every exported function saying what it is for. A comment wherever a rule has an edge that is not obvious from the code (say the rule and why, with the numbers).
- Tests of your own with `node:test` under `test/`, for the rules (beside the kit's test, which stays as it is).
- `package.json`: `"type": "module"`, a `test` script that runs `node --test`, no dependencies.

Where `SPEC.md` and `expected/` disagree, `expected/` is right about what is printed: follow it, and report the disagreement.

## Done when

- `node --test` passes: the kit's test and yours.
- For every fixture, the printed result equals `expected/<name>.json` byte for byte, and the exit code matches.

## Your final message (it is the only thing read; write no report file)

The files you wrote, one line each; the real output of the last test run (the counts); every place where `SPEC.md` was unclear, silent, or disagreed with `expected/`, and what you did there; anything you had to guess.

## Message 2 (after the first hand-back)

The coordinator sent a message while you were working:
Accepted: all fixtures match and the tests pass. Three small additions, same rules as before (work only inside your folder, start every command with `cd` into it, no network).

1. **Move the tables under `src/`.** Everything the program needs at run time should live under `src/`: move `data/` to `src/data/` and update the imports. Nothing else about the tables changes.

2. **The program's own README.** Replace `README.md` (it still describes the starting kit) with a short one for the program, about a dozen lines: what the order desk does (two sentences); how the code is laid out (which module holds which rules); how to run one order (`node ./src/run-order.mjs ./fixtures/<name>.json`); how to run the tests; the nine keys of the result. Do not mention `SPEC.md`, `expected/` or the kit in it.

3. **A small developer suite, `test/visible.test.mjs`.** "The order desk's own tests: a small suite a developer runs before a commit", run with `node --test ./test/visible.test.mjs`. Exactly these eight tests, written against your program's in-process entry point (not through the command line), reading the fixtures from `fixtures/`:
   - a small order collected at the store is approved: fixture `small-pickup` gives status `approved`, subtotal 6, shipping 0, grandTotal 6.36;
   - an order the shelf cannot fill is held and names the item: fixture `out-of-stock` gives status `on-hold` and reasons `["out of stock: DESK-LAMP"]`;
   - a fixed coupon takes its amount off: fixture `welcome-coupon` gives discount 5;
   - a one-item order is priced at the catalog price: fixture `harbour-express-lamp` gives subtotal 42.5;
   - every result has the same keys: the result of `small-pickup` has exactly the nine keys, in order;
   - the same order gives the same result twice: fixture `studio-lamps`, run twice, deep-equal;
   - an unknown customer is refused: `small-pickup` with `customerId` changed to `C-999` is refused with a message matching `unknown customer C-999`;
   - an unknown item is refused: `small-pickup` with its lines replaced by one line `{ sku: "NOPE", qty: 1 }` is refused with a message matching `unknown item NOPE`.
   Nothing more in that file. Your other tests stay as they are.

Done when `node --test` passes (the kit's test must still pass unchanged apart from nothing: it runs the command line, so the move must not break it) and every fixture still prints `expected/` byte for byte.

Final message: what moved, the README's text, and the test counts of the last run.

Address this before completing your current task.
