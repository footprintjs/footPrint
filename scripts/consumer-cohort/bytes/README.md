# Candidate bytes at their use boundary

Reuse the canonical bounded archive inspector. Verify same-run bundle source/plan/run joins,
archive SHA-512, exact installed file sets/hashes and the actual single physical expected Foottrace
before and after every consumer command. Lock metadata alone is never runtime-source proof.
The Actions artifact ID/ZIP digest is recorded separately after upload: it cannot hash itself.
These checks prove inspected bytes/graph, not a foreign review or arbitrary build correctness.

The source-audit entry selects a fixed package policy before reading metadata.
AgentFootprint uses its existing native 32 MiB/128 MiB/20,000-file profile through
the same canonical parser. FootPrint's release profile remains unchanged. Installed
directory entries are counted separately from regular files and bounded from the
admitted archive paths. No plan/receipt may supply a limit or member-root override.
