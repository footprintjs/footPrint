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

The resolver is a fresh sibling of the canonical consumer checkout under the
same parent, outside the evidence tree. Relative `file:` lock entries must name
the same canonical archive from the consumer before `npm ci` can run. The lock
is copied verbatim, never rewritten. A resolver collision refuses before any
command and leaves the old directory intact.

Immediately after `npm ci`, the runner reads the actual root and hidden locks
and requires their Foottrace `version`, `resolved` and `integrity` entries to
match. This catches npm silently repairing a request from the manifest. In
earlier failed sweeps the lock was generated one level too deep; npm repaired
the install, so that retained lock was not the request actually installed.

`hidden-lock.mjs` is the pure entry/hash and diagnostic law;
`hidden-lock-fs.mjs` supplies read-only filesystem facts. The initial hidden-lock
SHA256 and mtime, then fresh before/after reports, stay in the artifact. Changed
hidden bytes refuse before a graph check; nothing re-stamps or reinstalls them.
Arborist can distrust an unchanged hidden lock when a directory is newer by
more than its 10 ms tolerance. Creating `.vite` changes `node_modules`'s own
mtime even though dot entries are skipped. A correct root lock still lets the
ordinary actual-tree checks succeed after that fallback.

Drift reports list newer ordinary directories, packages unlisted in the lock
and locked locations not observed. The bounded scan includes the modules root,
scopes and nested modules containers, and does not walk package contents. Links,
`.store`, workspace roots and atomic snapshots are outside its profile; links
or truncation mark the scan incomplete. Counts and omitted rows remain explicit.
Drift is diagnosis, not a substitute Arborist validator or authenticity proof.

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
node --test scripts/foottrace-candidate/*.test.mjs
```

Those controls do not install packages or execute product suites. Actual
resolution, archive production and consumer gates are proven by the hosted run.
