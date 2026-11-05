# Generated install-fixture version policy

This pure helper reads the actual contributor caret range and locked pin as data.
It accepts one complete finite stable or prerelease SemVer floor, requires the
pin to satisfy that range using normal prerelease admission, and chooses the
next synthetic version from the pin: prerelease increment or stable patch.
The generated version must also be finite, strictly newer and inside the same
range. Unsupported data fails; the range never changes.

The adjacent tests use SemVer inputs and controlled increment faults. They run
no install, registry or child process. The parent development-install test keeps
its actual generated loopback registry, normal npm install/ci/pack/consumer
checks, one-copy assertions, finite request/process bounds and cleanup. Its
versions are synthetic test data, never claims of public registry availability.

This separates source policy from fixture generation. Both a stable contributor
pin and the reviewed RC pin exercise the same locked-root/newer-consumer law;
no RC number, wildcard, skip or includePrerelease bypass is built in.
