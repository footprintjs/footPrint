# Foottrace consumer contract

After `npm ci`, run `npm run test:contract:foottrace`. The same command runs in
this repository's Node 22/24 CI matrix. It does not build the engine or run the
engine's full unit suite.

`foottrace.imports.mjs` reads TypeScript syntax trees under `src/`. Comments do
not count. Aliases and mixed type/value imports retain the owning public door.
Every imported runtime symbol must have a behavior contract, and every behavior
contract must correspond to a real import. Adding an import without a contract,
or retaining a contract after removing its last import, fails the suite.
Namespace, wildcard, default, dynamic and type-query imports are refused until
their coverage can be explicit. Every imported declaration is also compiled
against both CommonJS and ESM public type doors, with typed engine boundary
examples. The generated declaration check stays in memory.

The suite covers the root, `/write` and `/paths` APIs the engine uses. It does
not contract unimported readers such as `stateAt`, variable/forward slices,
`/cause`, `/prov` or `/metadata`.

To check an upstream candidate, stage the already-built package separately:

```sh
npm ci
npm install --no-save --package-lock=false --ignore-scripts /absolute/foottrace.tgz
npm run test:contract:foottrace
```

The command tests the installed dependency and performs no installation or
network access. A candidate failure must be classified under the ecosystem's
upstream-break / intended-major / downstream-staleness rule before acting.
Foottrace's release integration is maintained in its own repository.
