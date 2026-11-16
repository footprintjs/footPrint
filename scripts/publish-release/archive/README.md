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

The internal `inspectCohortArchive` entry shares this same parser for source-audit
inputs. It accepts only package/version/sourceManifest, with no caller limits,
profile or roots. `cohort-profile.cjs` selects fixed policy from the admitted
expected package name before metadata reads. AgentFootprint reuses its native
publication policy at commit `9288d55ae50bcbe65c365064e3166e4d600e79f1`: 32 MiB
compressed, 128 MiB expanded, 20,000 regular files; its six known root leaves and
the dist, ai-instructions and bin prefixes. The portable header, path, strict
manifest, gzip and refusal laws stay here; no second parser is imported.
FootPrint's existing release entry, callers, defaults and member policy are
unchanged. This source-audit entry grants no publication authority.

The installed-file verifier uses the same fixed file/byte profile. AgentFootprint's
separate entry scan budget comes from its admitted files and implied directory
prefixes, plus its dependency-directory slot: directories never consume its file
budget. Other packages retain the existing entry bound. No receipt controls these
limits. The actual reviewed 14.7.2 archive has 11,294 files and 740 implied
directories; its source-audit admission does not establish a future consumer cohort.

Storydeck source inputs use their pinned shared-CI policy at commit
`1ca5d7de9bde68c205b5d140c94dc475ae3b2520`, selected only by the expected
package name. Required member-bearing dist/plugin prefixes, the exact browser
runtime and CHANGELOG, optional root declarations/styles, unconditional npm
configuration/dependency denials and native filesystem collision rules narrow
the same parser. Source/archive versions must equal; AF's RC projection cannot
apply. Limits stay 16 MiB/64 MiB/10,000 files. The actual public policy probe has
81 members; its old peer manifest is refused for source51. This proves package
policy fit, not source51, engine13 or Viz runtime compatibility.

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

Run `node --test scripts/publish-release/archive/*.test.cjs` for the adjacent
contracts. The normal package test gate also runs these cases through the archive
test entry. Hosted exact-head checks, actual npm-pack profile proof and Claude
review remain separate gates.
