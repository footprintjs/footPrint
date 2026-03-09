#!/usr/bin/env bash
set -euo pipefail

# Release script — keeps package.json, git tag, and npm in sync.
#
# Usage:
#   npm run release:patch   # 0.4.0 → 0.4.1
#   npm run release:minor   # 0.4.0 → 0.5.0
#   npm run release:major   # 0.4.0 → 1.0.0

BUMP="${1:?Usage: release.sh <patch|minor|major>}"

# 1. Validate
if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Error: bump must be patch, minor, or major (got: $BUMP)"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# 2. Build + test (fail early before touching version)
echo "==> Building and testing..."
npm run build
npm test

# 3. Bump version in package.json (no git tag yet)
npm version "$BUMP" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
echo "==> Bumped to v$VERSION"

# 4. Update lockfile
npm install --package-lock-only

# 5. Commit + tag + push
git add package.json package-lock.json
git commit -m "chore: release v$VERSION"
git tag "v$VERSION"
git push
git push --tags

# 6. Publish to npm
npm publish

echo ""
echo "==> Released v$VERSION"
echo "    npm: https://www.npmjs.com/package/footprintjs/v/$VERSION"
echo "    tag: https://github.com/footprintjs/footPrint/releases/tag/v$VERSION"
