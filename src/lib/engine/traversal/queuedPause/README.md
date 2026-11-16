# Queued sibling pause

Runs the resumed entry chain through the caller's native traversal callback,
with the same single await, then re-raises the original waiting sibling.
A new pause from the chain keeps the waiting siblings behind it. Other errors
keep their original identity. The notification uses the current leg's root
stamp while the signal retains the original paused execution. It writes no
new run-evidence stop: this leg did not execute that sibling again.

Adjacent tests pin ordering, identity and queued-sibling preservation.
