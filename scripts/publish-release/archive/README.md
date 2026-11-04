# Inspected release archive

This folder admits the exact tarball submitted to npm. It never extracts a
package, runs package code, installs a dependency or publishes a folder.

`inspector.cjs` exports:

- `inspectArchive(bytes, { package, version, sourceManifest })`: requires the
  admitted source manifest and returns package identity, archive hashes and the
  inspected file list. The caller publishes these same bytes by absolute path.
- `parseManifest(bytes)`: reads source or packed JSON with a 1 MiB input bound,
  depth 64 and 100,000 values. Both roots are objects; decoded duplicate keys at
  every depth refuse. Root callers use this before passing sourceManifest.
- `archiveRefusalCode(error)`: returns a fixed refusal code, optionally a known
  manifest field or a short SHA-256 key label. Raw unknown/control keys and
  manifest values never enter the diagnostic.

The archive profile is copied from `footprintjs/foottrace` at
`bb3c18244655b794d7c3660b0c35f2a510b45ea0`,
`scripts/release-archive.cjs`. `PROVENANCE.json` pins its full file hash and the
unchanged parser units. The gzip, closed tar header, checksums, padding, single
member, path, regular-file and finite resource rules remain that copy. FootPrint
adds only `package/AGENTS.md` to the allowed root files; the rest is the existing
`package/package.json`, `package/README.md`, `package/LICENSE` and `package/dist/`
profile. PAX, GNU extensions, long/non-ASCII paths and links remain refused.

The unused ZIP reader was removed. The manifest comparison is the same typed
canonical whole-source comparison except `version`, with JSON object admission
made explicit. The source manifest is mandatory. Strict structural JSON
admission closes the copied reader's duplicate-key gap. The entire tar inventory
passes before packed JSON is read, so sibling `.npmrc`, `binding.gyp` and
`server.js` files refuse independently of manifest contents.

Adjacent `node:test` cases use the full current source manifest for positives,
changing only the planned version. Historical Claude archives are pinned inert
data under `fixtures/`; no member is extracted or executed. Their old minimal
baselines are not current positive fixtures. Structural corpus cases must fail
at archive admission, rather than borrowing an unrelated source mismatch.

Root runs `node --test scripts/publish-release/archive/*.test.cjs`; this folder's
builder does not execute tests. Hosted exact-head checks, actual npm-pack profile
proof and Claude review remain separate gates.
