# Test and release automation

`bun install` at the repository root installs the Next.js example as a
workspace, including its local `jevlang` dependency. `bun test` and
`bun run test` run the core, site and example tests; CI runs the same suite.
The example reads policy source relative to its module so running tests
from the root and from the example directory both work.

Releases require a clean working tree. After bumpp changes the version,
it rebuilds `site/out` and runs the site tests before committing the version
and generated files together. The stale-output assertion stays enabled so
ordinary documentation edits still need a fresh build.

Verify with a frozen root install, the full JavaScript suite, the type
checks, and a release in a temporary repository with push and tag disabled.
