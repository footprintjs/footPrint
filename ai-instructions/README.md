# AI instructions

Files that teach an AI coding tool how to use FootPrint. One source, one generated file per tool.

**Do not edit a generated file.** Edit `source/`, then run `npm run ai:generate`.

## Which file is for which tool

`bash ai-instructions/setup.sh`, run from your project, copies the ones you pick. None of them ship in the npm package. `AGENTS.md` does, at `node_modules/footprintjs/AGENTS.md`, and every other file points there.

| Tool | Generated file | Installs to |
|---|---|---|
| Claude Code | `claude-code/SKILL.md` | `.claude/skills/footprint/SKILL.md` |
| Codex and other `AGENTS.md` readers | `../AGENTS.md` | `AGENTS.md`, only if you have none |
| GitHub Copilot | `copilot-instructions.md` | `.github/copilot-instructions.md` |
| Cursor | `cursor/footprint.mdc` | `.cursor/rules/footprint.mdc` |
| Kiro | `kiro/footprint.md` | `.kiro/steering/footprint.md` |
| Cline | `clinerules` | `.clinerules/footprint.md` |
| Windsurf | `windsurfrules` | `.windsurfrules` |

These install paths come from each tool's own documentation, read on 2026-11-06. None was tested in the tool itself. Cursor ignores a plain `.md` file in `.cursor/rules` and asks for `.mdc` with frontmatter. Kiro reads `.kiro/steering`. Cline documents a `.clinerules` folder. Windsurf's rules page now redirects to Devin Local, which still imports `.windsurfrules`.

Cursor, Copilot, Kiro, Cline and that Devin Local page also read `AGENTS.md`, which is why this repository keeps no copy of these files at its own root. In your project the root `AGENTS.md` is yours and FootPrint's sits in `node_modules`, so these files are how the tool finds it.

## The source

| File | What it holds |
|---|---|
| `source/instructions.md` | The prose, as `##` sections. `{{…}}` marks where the data below goes. |
| `source/import-map.json` | One row per public door: its job and common names. |
| `source/tasks.json` | The task table: a task, the API to use, the pages to read. |
| `source/snippets/*.mts` | The canonical snippets. Each is a file you can run. |
| `source/targets.json` | Each generated file: its tool, sections, install path and size budget. |

The generator and its checks are in [`scripts/ai-instructions`](../scripts/ai-instructions/README.md).
