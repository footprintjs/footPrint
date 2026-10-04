# Shared test fixtures

`registerScope.ts` gives legacy plain-object test scopes an explicit runtime registration. Each fixture's existing methods are its declared target port; assignment protection remains enabled. It changes only fixture admission, not their state behavior or assertions.

This is test support, not a production compatibility fallback. Production adapters register through `footprintjs/advanced` and normally share one `ScopeFacade`. Strict proxies must declare a separate target port rather than use the data proxy itself.
