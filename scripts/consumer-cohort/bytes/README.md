# Candidate bytes at their use boundary

Reuse the canonical bounded archive inspector. Verify same-run bundle source/plan/run joins,
archive SHA-512, exact installed file sets/hashes and the actual single physical expected Foottrace
before and after every consumer command. Lock metadata alone is never runtime-source proof.
The Actions artifact ID/ZIP digest is recorded separately after upload: it cannot hash itself.
These checks prove inspected bytes/graph, not a foreign review or arbitrary build correctness.
