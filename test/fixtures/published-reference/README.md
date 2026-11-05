# Published declaration reference

This private fixture pins footprintjs10.1.0 and its declaration dependencies
with its own normal registry lock. It is outside the main runtime dependency
graph. The stable Foottrace here is declaration data; the main graph uses the
read-law candidate and keeps its required single physical Foottrace owner.

Every `npm test` runs the root `pretest` command:

```sh
npm --prefix test/fixtures/published-reference ci --ignore-scripts --strict-peer-deps --registry=https://registry.npmjs.org
```

That install replays this committed lock without regenerating it. Missing data
fails loudly in the explicit `test/architecture/published-reference.ts` port.
`published-doors.test.ts` reads package metadata and declarations with TypeScript;
it does not import or execute this package's runtime or exchange native objects.
Every existing door, name and value-kind comparison and deliberate broken
control remains. The independent 9.28 runtime baseline stays in the main graph.

Refresh the exact reference version and generate its lock normally in a reviewed
change. Its nested Foottrace is an intentional reference image, never evidence
that two Foottrace owners can execute together. The root and fixture locks are
separate authorities for separate images. `node_modules` stays ignored.
