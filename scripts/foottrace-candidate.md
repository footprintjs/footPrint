# E3: testing the unpublished foottrace candidate

`package.json` keeps the release dependency `foottrace: ^1.0.0`. During E3 that version is not
on npm. A plain `npm install` cannot bootstrap this branch and must not silently substitute a
different package. `foottrace-candidate.json` holds the one approved source repository, full
40-character commit, and version. A missing or placeholder commit fails before fetching or
installing anything; the pin must identify the committed and pushed foottrace PR head.

```sh
node scripts/foottrace-candidate.mjs pack /absolute/temporary/candidate-directory
node scripts/foottrace-candidate.mjs install /absolute/temporary/candidate-directory/foottrace-candidate.tgz
```

`pack` fetches that exact public source commit into a fresh temporary checkout, verifies its
identity and package version, runs `npm ci` and the build, and packs the result. It checks that
tracked source files stayed unchanged. The archive has an adjacent `.tgz.json` manifest containing
the source identity and SHA-512 integrity. No branch, latest version, or registry fallback exists.
The temporary source checkout is removed afterwards. No command publishes or changes remote refs.

`install` validates the archive/manifest against the checked-in pin and uses `npm install --no-save`
with that archive in the same resolution. It verifies that `package.json` is unchanged and that
npm recorded exactly one root foottrace package entry and no nested copy, with the expected
version, file source and archive integrity. `--ignore-scripts` is available for the audit's
source-only dependency setup.

The engine CI builds one archive and shares it with its Node 22/24 tests and lint job. The Consumers
workflow likewise builds one archive, uploads it beside the engine tarball, and passes it to every
candidate swap:

```sh
node scripts/audit-consumers.mjs --candidate /absolute/footprintjs-candidate.tgz \
  --foottrace-candidate /absolute/foottrace-candidate.tgz
```

Each candidate swap installs both archives together and rejects a missing, stale or nested duplicate
foottrace. For playgrounds with linked sibling checkouts, verified sibling package paths are then
linked to the consumer's canonical installation inside the temporary audit workspace. Their real
paths must agree, so one process cannot load separate constructor or freeze-metadata instances.
Every path and archive is verified before linking; external source/global paths are refused. The
audit notes report this E3-only arrangement. It does not claim production consumers are already
deduplicated. Linking repeats after every candidate swap; metadata alone is not an identity proof.
The published-footprintjs comparison keeps its ordinary published dependencies.
Consumers still run their real checks on their selected refs; imports removed by E3 remain visible
failures until E5 migrates those consumers. This bootstrap does not skip tests or claim that the
family migration has passed.

## Security refresh after FootPrint 9.48.2

The branch includes the released 9.48.2 history, but the copy-safety implementation remains solely
in the pinned Foottrace candidate. Neither the new private `capture/ownData.ts` leaf nor its
record-only regression suite is copied back into the engine. The leaf stays in `RECORD_FILES`
as historical ownership data: the extracted-source guard rejects a local copy, and its negative
control deliberately restores a dummy file to prove that rejection. The original extraction
inventory in `trace-extraction.json` remains a historical snapshot, not a new source manifest.

Two engine witnesses in `test/lib/engine/security/hostile-keys-no-pollution.security.test.ts`
exercise full and delta records through the real scope/frame integration. They preserve rich-array
payload keys after an unrelated write and nested read, a nested write, commit and replay; a staged
`Date` also keeps its prototype before commit. This does not promise that Date expandos survive
the existing structured-clone record boundary. Both witnesses fail against the prior `b66d99e`
candidate at the post-write array read and pass against the fixed candidate. The record-only
copy matrix remains Foottrace's responsibility. No frozen reference fixture is changed.

After E4 publishes the approved foottrace 1.0.0, remove the pin, helper, temporary bootstrap tests
and candidate artifact plumbing, restore ordinary dependency installation, and retain the
one-installed-copy check in the consumer audit. E6 must test the registry dependency before the
footprintjs 10.0.0 release. The docs deployment and release workflows deliberately remain on the
ordinary dependency path: this E3 branch must not merge or publish before the release sequence
makes those dependencies available.
