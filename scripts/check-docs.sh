#!/usr/bin/env bash
set -euo pipefail

# Pre-release documentation check.
# Scans all .md files for references to removed/deprecated APIs.
# If any are found, the release is blocked.
#
# Usage: bash scripts/check-docs.sh
# Called by: scripts/release.sh (before version bump)

REMOVED_APIS="typedFlowChart|createTypedScopeFactory|setEnableNarrative|setInputSchema|setOutputSchema|setOutputMapper|generateOpenAPI|defineContract"

echo "==> Checking documentation for deprecated API references..."

FAILURES=0
while IFS= read -r file; do
  count=$(grep -c "$REMOVED_APIS" "$file" 2>/dev/null || true)
  if [[ "$count" -gt 0 ]]; then
    echo "  FAIL: $file ($count references to removed APIs)"
    FAILURES=$((FAILURES + count))
  fi
done < <(find . -name "*.md" -not -path "*/node_modules/*" -not -path "*/dist/*" -not -name "CHANGELOG.md")

if [[ "$FAILURES" -gt 0 ]]; then
  echo ""
  echo "Error: $FAILURES references to removed APIs found in documentation."
  echo "Update these files before releasing."
  echo ""
  echo "Removed APIs (use these instead):"
  echo "  typedFlowChart()        → flowChart<T>()"
  echo "  createTypedScopeFactory → (auto-embedded)"
  echo "  setEnableNarrative()    → .recorder(narrative())"
  echo "  setInputSchema()        → .contract({ input })"
  echo "  setOutputSchema()       → .contract({ output })"
  echo "  setOutputMapper()       → .contract({ mapper })"
  echo "  generateOpenAPI()       → chart.toOpenAPI()"
  echo "  defineContract()        → .contract() on builder"
  exit 1
fi

echo "  All documentation is up to date."
