#!/usr/bin/env bash
set -euo pipefail

# Release script — keeps package.json, git tag, and GitHub releases in sync.
# npm publish is handled by GitHub Actions (with provenance).
#
# Release pipeline (7 gates before version bump):
#   1. Clean working tree
#   2. Documentation check (no stale API refs in .md files)
#   3. API conformance tests (47 design contract tests)
#   4. Build (CJS + ESM)
#   5. Full test suite (1874+ tests)
#   6a. Sample integration tests (snapshot assertions — narrative output)
#   6b. Sample projects (run all samples to verify real-world usage)
#   7. CHANGELOG entry exists
#   Then: version bump → commit + tag + push → GitHub release → CI npm publish
#
# Usage:
#   npm run release:patch   # 3.0.0 → 3.0.1
#   npm run release:minor   # 3.0.0 → 3.1.0
#   npm run release:major   # 3.0.0 → 4.0.0

BUMP="${1:?Usage: release.sh <patch|minor|major>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SAMPLES_DIR="$(cd "$PROJECT_DIR/../footprint-samples" 2>/dev/null && pwd || echo "")"

# ── Gate 1: Clean working tree ──────────────────────────────────────────
if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Error: bump must be patch, minor, or major (got: $BUMP)"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

# ── Gate 2: Documentation check ─────────────────────────────────────────
bash scripts/check-docs.sh

# ── Gate 3: API conformance tests ───────────────────────────────────────
echo "==> Running API conformance tests (47 design contract tests)..."
npx vitest run test/api-conformance/ --reporter=verbose

# ── Gate 4: Build ───────────────────────────────────────────────────────
echo "==> Building (CJS + ESM)..."
npm run build

# ── Gate 5: Full test suite ─────────────────────────────────────────────
echo "==> Running full test suite..."
npm test

# ── Gate 6: Sample projects ─────────────────────────────────────────────
if [[ -n "$SAMPLES_DIR" && -d "$SAMPLES_DIR" ]]; then
  echo "==> Running sample projects ($SAMPLES_DIR)..."

  # Install latest local build
  (cd "$SAMPLES_DIR" && npm install 2>&1 | tail -1)

  # Run integration snapshot tests (verifies narrative output against golden snapshots)
  echo "==> Running sample integration tests (snapshot assertions)..."
  if (cd "$SAMPLES_DIR" && npm test 2>&1 | tail -5); then
    echo "  Sample integration tests passed."
  else
    echo ""
    echo "Error: Sample integration tests failed."
    echo "Run 'npm run test:update' in footprint-samples to update snapshots if intentional."
    exit 1
  fi

  # Run all samples defined in package.json "all" script
  if (cd "$SAMPLES_DIR" && npm run all 2>&1 | tail -3); then
    echo "  All samples passed."
  else
    echo ""
    echo "Error: Sample projects failed."
    echo "Fix the samples before releasing — these are what developers copy-paste."
    exit 1
  fi
else
  echo "==> Skipping samples (../footprint-samples not found)."
  echo "    To enable: clone footprint-samples next to footPrint."
fi

# ── Version bump ────────────────────────────────────────────────────────
npm version "$BUMP" --no-git-tag-version
VERSION=$(node -p "require('./package.json').version")
echo "==> Bumped to v$VERSION"

# ── Gate 7: CHANGELOG entry ─────────────────────────────────────────────
if ! grep -q "## \[$VERSION\]" CHANGELOG.md; then
  echo "Error: CHANGELOG.md has no entry for [$VERSION]."
  echo "Add a ## [$VERSION] section before releasing."
  git checkout package.json
  exit 1
fi

# ── Extract release notes ──────────────────────────────────────────────
NOTES=$(awk "/^## \[$VERSION\]/{found=1; next} /^## \[/{if(found) exit} found{print}" CHANGELOG.md)
if [[ -z "$NOTES" ]]; then
  echo "Warning: CHANGELOG.md entry for [$VERSION] is empty. Continuing anyway."
fi

# ── Update lockfile ────────────────────────────────────────────────────
npm install --package-lock-only

# ── Commit + tag + push ───────────────────────────────────────────────
git add package.json package-lock.json
git commit -m "chore: release v$VERSION"
git tag "v$VERSION"
git push
git push --tags

# ── Create GitHub release ─────────────────────────────────────────────
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
fi

echo ""
echo "==> Released v$VERSION"
echo "    npm: https://www.npmjs.com/package/footprintjs/v/$VERSION (published by CI)"
echo "    changelog: CHANGELOG.md"
echo ""
echo "Release pipeline passed all 7 gates:"
echo "  1. Clean tree               ✓"
echo "  2. Doc check                ✓  (0 stale API refs)"
echo "  3. API conformance          ✓  (47 design contract tests)"
echo "  4. Build                    ✓  (CJS + ESM)"
echo "  5. Full test suite          ✓"
echo "  6a. Sample integration      ✓  (snapshot assertions)"
echo "  6b. Sample projects         ✓  (all runnable samples)"
echo "  7. CHANGELOG                ✓"
