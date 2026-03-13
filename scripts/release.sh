#!/usr/bin/env bash
set -euo pipefail

# Release script — keeps package.json, git tag, and GitHub releases in sync.
# npm publish is handled by GitHub Actions (with provenance).
#
# Flow:
#   1. Local: build + test → version bump → CHANGELOG check → commit + tag + push
#   2. GitHub release created → triggers .github/workflows/publish.yml
#   3. CI: npm publish --provenance --access public (green tick on npm)
#
# Prerequisites:
#   - gh auth login (for GitHub release creation)
#   - NPM_TOKEN secret configured in GitHub repo settings
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

# 4. Check CHANGELOG has an entry for this version
if ! grep -q "## \[$VERSION\]" CHANGELOG.md; then
  echo "Error: CHANGELOG.md has no entry for [$VERSION]."
  echo "Add a ## [$VERSION] section before releasing."
  # Revert the version bump
  git checkout package.json
  exit 1
fi

# 5. Extract release notes from CHANGELOG.md
# Grab everything between ## [$VERSION] and the next ## [
NOTES=$(awk "/^## \[$VERSION\]/{found=1; next} /^## \[/{if(found) exit} found{print}" CHANGELOG.md)
if [[ -z "$NOTES" ]]; then
  echo "Warning: CHANGELOG.md entry for [$VERSION] is empty. Continuing anyway."
fi

# 6. Update lockfile
npm install --package-lock-only

# 7. Commit + tag + push
git add package.json package-lock.json
git commit -m "chore: release v$VERSION"
git tag "v$VERSION"
git push
git push --tags

# 8. Create GitHub release (triggers CI → npm publish with provenance)
if command -v gh &> /dev/null; then
  echo "==> Creating GitHub release (CI will publish to npm with provenance)..."
  gh release create "v$VERSION" \
    --title "v$VERSION" \
    --notes "$NOTES" \
    --latest
  echo "    release: https://github.com/footprintjs/footPrint/releases/tag/v$VERSION"
  echo "    CI will publish to npm shortly — check Actions tab for status."
else
  echo "Warning: gh CLI not found. Skipping GitHub release creation."
  echo "Run manually: gh release create v$VERSION --title v$VERSION --latest"
  echo "Note: npm publish will happen automatically when the GitHub release is created."
fi

echo ""
echo "==> Released v$VERSION"
echo "    npm: https://www.npmjs.com/package/footprintjs/v/$VERSION (published by CI)"
echo "    changelog: CHANGELOG.md"
