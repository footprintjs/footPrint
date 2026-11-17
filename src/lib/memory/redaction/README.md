# Redaction constants

The sealed `redaction.ts` facade remains the selection authority. This folder holds the unchanged scope placeholder and its full contract comment, moved as one unit so that adding private ownership registration shrinks the facade's existing line ratchet. It does not implement record encoding or another redaction rule. `constants.test.mjs` checks the historical served value through the original facade.
