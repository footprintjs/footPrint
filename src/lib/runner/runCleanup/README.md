# Run cleanup helpers

This internal module owns the existing flush allowance calculation and synchronous disposal-on-refused-entry helper. The executor chooses their call sites and keeps run lifecycle ordering.

Step 1 extraction: both function bodies, their comments and the 30-second constant move unchanged. No timer is added; the flush calculation reads Date.now only when called. Adjacent tests cover allowance boundaries and original-error/disposal order. Remaining lifecycle wiring stays with the executor.
