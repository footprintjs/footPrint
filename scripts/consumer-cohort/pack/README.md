# One same-run producer

The existing pack job builds only the closed recipe table, in authored dependency order, after
strict pairing. Source versions and immutable original manifests come from the owner's branch. Only AgentFootprint
has its reviewed native version-only RC stage AFTER its normal paired build and BEFORE hooks-off
pack; no old published AF archive or compiled output is patched. Original manifest and lock bytes
(or lock absence) are restored in finally after success/failure; temporary strict install manifest/lock
hashes are separate evidence. The engine uses the existing version-only audit copy; it is not a published release. Exact registry archives keep their selected
SHA-512. One bundle records actual source, tree, run, plan and archive/member identities.
No foreign artifact downloader, service credential, publisher or release ledger is added.
