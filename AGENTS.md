# AGENTS.md

Project conventions for AI-assisted development on agent-plugins — for Claude Code and other AI agents.

## What this project is

Personal plugin marketplace for Claude Code and Claude Cowork. Hosts plugins
that bundle agents, skills, commands, and hooks as distributable packages.

Registered as a marketplace in `~/.claude/plugins/known_marketplaces.json`.
Claude Code syncs the repo to `~/.claude/plugins/marketplaces/agent-plugins/`
and reads plugins from there at runtime.

## Structure

```text
.claude-plugin/
  marketplace.json            # Marketplace manifest — lists all plugins with metadata
plugins/
  ship-check/                 # Ship-check pipeline plugin
    .claude-plugin/
      plugin.json             # Plugin manifest
    agents/                   # Agent definitions (.md with YAML frontmatter)
      pr-reviewer.md
      code-quality-reviewer.md
      test-auditor.md
      bug-checker.md
    skills/                   # Skills (SKILL.md in subdirectories)
      ship-check/
        SKILL.md              # Pipeline orchestrator skill
    README.md
README.md                    # Marketplace README
```

## Adding a plugin

1. Create `plugins/<plugin-name>/` with `.claude-plugin/plugin.json` (minimum: `name` field)
2. Add agents, skills, commands, or hooks directories as needed
3. Add a `README.md` to the plugin directory
4. Register the plugin in `.claude-plugin/marketplace.json` under the `plugins` array
5. Update the root `README.md` plugin table
6. Commit and push — the local symlink makes changes available immediately after `/reload-plugins`

## Conventions

- **Kebab-case** for all directory and file names
- **Agent frontmatter** requires: `name`, `description`, `model`, `color`; optional: `tools`, `skills`
- **Skill directories** contain `SKILL.md` with `name` and `description` in frontmatter
- **Plugin manifests** use semver versioning
- Agent `tools:` fields are allowlists — omit to give all tools, list explicitly to restrict
- Agent `skills:` preloads skill content from any installed plugin or `~/.claude/skills/`

## Cross-tool compatibility

| Component | Claude Code / Cowork | Codex / Copilot / Gemini / OpenCode |
|-----------|:-------------------:|:-----------------------------------:|
| Plugin manifest | Yes | No |
| Agents | Yes | No |
| Skills (`SKILL.md`) | Yes | Yes (different paths) |
| Commands | Yes | No |
| Hooks | Yes | No |

Skills are the universal layer. Agents, commands, and hooks are Claude Code/Cowork-only.
