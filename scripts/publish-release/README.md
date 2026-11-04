# Release-event package route

The release workflow is the chart: admit the event, check and build the source,
stage the RC version, pack, then admit and publish on a separate job.
`run.sh` wires three operations; `check-archive.cjs` owns filesystem admission and
`archive/` owns the copied canonical tar and source-manifest laws.

- `admit` accepts only canonical `vX.Y.Z` / `vX.Y.Z-rc.N` event tags and matching
  prerelease flags. It reads the pinned source manifest, checks HEAD against the
  event SHA, and requires the GitHub comparison to say main contains that source.
  Stable tags already match the source version. Unknown or failed reads refuse.
  An RC core must be exactly one patch, minor or major bump of that stable source;
  its canonical ordinal must be a safe integer from 0 through
  `Number.MAX_SAFE_INTEGER`. `candidate-version.cjs` owns these pure rules,
  following Foottrace's bump law.
- `stage` runs after source tests and package checks. It changes only an RC's
  version with `jq`, with no version lifecycle, lock, fragment or Git change.
- `publish` independently repeats admission from the event and pinned checkout;
  build outputs carry no authority. The intake must contain exactly one regular
  `package.tgz`. The bounded canonical reader admits every member, rejects
  ambiguous manifests, and compares the complete manifest with source except
  `version`. npm receives the identical absolute tarball path, never a folder,
  with `--ignore-scripts --provenance --access public`. Only RCs get `--tag next`;
  stable publishes pass no tag, preserving npm's built-in refusals.

Both jobs set up pinned Node and npm before checking out source. The npm upgrade
uses a fixed registry and disables lifecycle scripts. Publish checks out only the
helper folder and source manifest at `github.sha`,
without retained Git credentials. Pinned checkout/download actions keep that
source outside the artifact intake under `runner.temp`. npm runs in a separate
empty directory, so artifact configuration cannot become project configuration.

Runner-temporary paths belong to the publication step's environment. The download
path and that step's intake path must agree. `workflowContexts.ts` checks context
availability by YAML position in the real publish, docs and CI workflows; job
outputs retain their valid runner and step contexts. This policy check does not
implement GitHub's complete expression grammar. CI also runs checksum-pinned
actionlint over those three workflows for workflow syntax and expression types.
No artifact is extracted, and this job installs only the pinned npm toolchain,
never package dependencies. OIDC permission is confined to publication. Docs
skip prerelease events and grant Pages/OIDC writes only to deployment.

The old local-tag check was removed: checkout creates the event tag locally,
so it was not an independent observation that the remote tag still points there.
The trusted event SHA and current main containment remain explicit checks.

Tests beside the code exercise the actual shell and YAML run body with inert
GitHub/npm stand-ins. The archive reader's provenance and pinned historical
attack corpus are in `archive/`. Hosted checks, exact-head Claude plus fresh-reader
review, and the owner's first RC dispatch remain separate gates. `release.sh`
and its consumer audit are unchanged; final releases keep the train's downstream
prerequisites.
