# Release-event package route

`run.sh` has three operations used by `publish.yml`:

- `admit`: validate a canonical `vX.Y.Z` or `vX.Y.Z-rc.N` release tag, its prerelease flag, the checked-out event SHA, and containment in main. Write the admitted version and source SHA to the job outputs. Stable tags must match the source package version.
- `stage`: after the existing source tests and package checks, change only the RC package's version with `jq`. Never run a version lifecycle or consume a changelog fragment. Stable metadata must already match.
- `publish`: read the checked archive's package name/version, require the admitted version, and choose explicit `next` for RC or `latest` for stable. Publish that same archive with provenance, without installing or repacking dependencies.

The publish job checks out only this helper at the admitted source SHA. OIDC permission stays in that job; admission/build have contents-read permission only. The GitHub compare result must say main is identical to or ahead of the release source. Unknown, failed or divergent reads refuse.

GitHub defines the release event's SHA as the last commit in the tagged release: [release events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#release).

`run.test.ts` exercises the actual workflow publish command, real fixture Git tags and tar archives, with simulated GitHub comparison and npm submission. It makes no network, credential, registry or release calls. Hosted gates and the first actual RC publication remain separate proof. `release.sh` and its stable consumer audit are unchanged; final releases retain the release train's downstream prerequisites.
