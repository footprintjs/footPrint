# Foottrace final candidate sweep

This read-only proof workflow builds the exact release proposal in `cohort.json`.
It uses the release route's pinned npm toolchain, locked install, build,
package check and lifecycle-disabled pack. The proposal's own canonical archive
reader checks the retained archive against its source manifest. The archive,
SHA256, source head, tree and inspection report are retained as artifacts and
labelled **offline; not published**.

Each pinned consumer runs on Node 22 and 24 in a separate hosted job. A normal
strict install in an isolated resolution copy generates a candidate lock. The
source copy replays that lock with strict `npm ci`, builds, runs its Foottrace
contract and runs its whole suite. Foottrace is the only replaced dependency;
consumer names, versions, peers and all other dependencies are preserved.
Candidate metadata is active only during installation and installed-graph checks.
Every source command sees the exact original manifest and lock bytes, modes and
absence; the installed candidate image remains unchanged. Original metadata is
restored even after a failed check.
Generated locks contain an ephemeral candidate path and are test evidence,
never portable release locks.

Before and after the suites, `npm ls foottrace` and the existing installed-tree
inspector must find one physical Foottrace owner. Every installed Foottrace
file must match the canonical archive report. A failed command, failed suite,
changed archive, extra physical copy or failed restoration fails the job.
Logs, command exits, whole-suite JSON and restoration results stay navigable
in each job's artifact. Only the dedicated evidence subfolder is uploaded; resolver,
cache and home trees remain separate and intact. The workflow has no publication authority.

Consumer workspaces and evidence live outside the harness checkout and cannot
inherit an installed ancestor tree. The source snapshot is tested as source;
an unpublished source version is never renamed to imitate a published package.
Other package members resolve normally from the registry.

The fixed hosted paths avoid UUID-like segments that npm may sanitize in its
JSON tree output. The child environment does not inherit proxy settings.

Run the inert driver controls with:

```sh
node --test scripts/foottrace-candidate/run.test.mjs
```

Those controls do not install packages or execute product suites. Actual
resolution, archive production and consumer gates are proven by the hosted run.
