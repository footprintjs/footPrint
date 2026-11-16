# Built-door measurements

`index.mjs` owns the exact minified ESM measurement used by
`test/architecture/door-sizes.test.ts`. The assertions and budgets stay in that test.
Foottrace, Zod and Node doors remain external; no minifier or tree-shaking option
changes when comparing packages.

Run `node scripts/door-sizes/measure.mjs /path/to/already-built/package /path/to/build/checkout` to print
bytes and entry hashes for all doors and the same minimal chart. This reads and
bundles in memory, without building, installing or editing the measured package.
The second path supplies the build's `tsconfig.json`; it defaults to the package
path. A packed artifact omits that file, so retain the checkout's configuration
explicitly: the bundler also reads it when the ordinary test runs in the checkout.
Compare artifacts built from the declared base and candidate with the same tools
and configuration. The report includes their versions and configuration hash.
Adjacent controls prove actual dead-code elimination and external imports.
