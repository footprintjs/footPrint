# One same-run producer

The existing pack job builds only the closed recipe table, in authored dependency order, after
strict pairing. Source versions come from the owner's branch, never a rewritten peer or dist file.
Original source manifests are restored before hooks-off npm pack. The engine alone uses the existing
version-only audit copy; it is not a published release. Exact registry archives keep their selected
SHA-512. One bundle records actual source, tree, run, plan and archive/member identities.
No foreign artifact downloader, service credential, publisher or release ledger is added.
