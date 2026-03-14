#!/usr/bin/env bash
# footprint.js — AI coding tool setup
# Installs instruction files for your preferred AI coding assistant.
#
# Usage:
#   npx footprintjs-setup          (after npm install footprintjs)
#   bash node_modules/footprintjs/ai-instructions/setup.sh

set -euo pipefail

PKG_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(pwd)"

echo ""
echo "  footprint.js — AI Coding Tool Setup"
echo "  ──────────────────────────────────────"
echo ""
echo "  This will copy instruction files so your AI coding"
echo "  assistant understands the footprint.js API."
echo ""

install_claude_code() {
  mkdir -p "$PROJECT_DIR/.claude/skills/footprint"
  cp "$PKG_DIR/claude-code/SKILL.md" "$PROJECT_DIR/.claude/skills/footprint/SKILL.md"
  # Also copy CLAUDE.md to project root if not present
  if [ ! -f "$PROJECT_DIR/CLAUDE.md" ]; then
    cp "$PKG_DIR/../CLAUDE.md" "$PROJECT_DIR/CLAUDE.md" 2>/dev/null || true
  fi
  echo "  [ok] Claude Code — .claude/skills/footprint/SKILL.md"
}

install_codex() {
  if [ ! -f "$PROJECT_DIR/AGENTS.md" ]; then
    cp "$PKG_DIR/../AGENTS.md" "$PROJECT_DIR/AGENTS.md" 2>/dev/null || true
    echo "  [ok] OpenAI Codex — AGENTS.md"
  else
    echo "  [skip] AGENTS.md already exists"
  fi
}

install_copilot() {
  mkdir -p "$PROJECT_DIR/.github"
  if [ ! -f "$PROJECT_DIR/.github/copilot-instructions.md" ]; then
    cp "$PKG_DIR/copilot-instructions.md" "$PROJECT_DIR/.github/copilot-instructions.md"
    echo "  [ok] GitHub Copilot — .github/copilot-instructions.md"
  else
    echo "  [skip] .github/copilot-instructions.md already exists"
  fi
}

install_cursor() {
  mkdir -p "$PROJECT_DIR/.cursor/rules"
  cp "$PKG_DIR/cursor/footprint.md" "$PROJECT_DIR/.cursor/rules/footprint.md"
  echo "  [ok] Cursor — .cursor/rules/footprint.md"
}

install_windsurf() {
  if [ ! -f "$PROJECT_DIR/.windsurfrules" ]; then
    cp "$PKG_DIR/windsurfrules" "$PROJECT_DIR/.windsurfrules"
    echo "  [ok] Windsurf — .windsurfrules"
  else
    # Append footprint rules to existing file
    echo "" >> "$PROJECT_DIR/.windsurfrules"
    cat "$PKG_DIR/windsurfrules" >> "$PROJECT_DIR/.windsurfrules"
    echo "  [ok] Windsurf — appended to .windsurfrules"
  fi
}

install_cline() {
  if [ ! -f "$PROJECT_DIR/.clinerules" ]; then
    cp "$PKG_DIR/clinerules" "$PROJECT_DIR/.clinerules"
    echo "  [ok] Cline — .clinerules"
  else
    echo "" >> "$PROJECT_DIR/.clinerules"
    cat "$PKG_DIR/clinerules" >> "$PROJECT_DIR/.clinerules"
    echo "  [ok] Cline — appended to .clinerules"
  fi
}

install_kiro() {
  mkdir -p "$PROJECT_DIR/.kiro/rules"
  cp "$PKG_DIR/kiro/footprint.md" "$PROJECT_DIR/.kiro/rules/footprint.md"
  echo "  [ok] Kiro — .kiro/rules/footprint.md"
}

install_all() {
  install_claude_code
  install_codex
  install_copilot
  install_cursor
  install_windsurf
  install_cline
  install_kiro
}

# Interactive menu
echo "  Which tool(s) do you use?"
echo ""
echo "    1) Claude Code"
echo "    2) OpenAI Codex"
echo "    3) GitHub Copilot"
echo "    4) Cursor"
echo "    5) Windsurf"
echo "    6) Cline"
echo "    7) Kiro"
echo "    a) All of the above"
echo "    q) Quit"
echo ""
read -rp "  Choose (e.g. 1,4 or a): " choice

echo ""

if [[ "$choice" == "q" ]]; then
  echo "  Cancelled."
  exit 0
fi

if [[ "$choice" == "a" || "$choice" == "A" ]]; then
  install_all
else
  IFS=',' read -ra selections <<< "$choice"
  for sel in "${selections[@]}"; do
    sel="$(echo "$sel" | tr -d ' ')"
    case "$sel" in
      1) install_claude_code ;;
      2) install_codex ;;
      3) install_copilot ;;
      4) install_cursor ;;
      5) install_windsurf ;;
      6) install_cline ;;
      7) install_kiro ;;
      *) echo "  [?] Unknown option: $sel" ;;
    esac
  done
fi

echo ""
echo "  Done! Your AI assistant now knows the footprint.js API."
echo "  Add the generated files to .gitignore if you don't want them in version control."
echo ""
