# AGENTS.md

Project conventions for AI-assisted development on agent-plugins — for Claude Code and other AI agents.

## What this project is

Personal plugin marketplace for Claude Code and Claude Cowork. Hosts plugins
that bundle agents, skills, commands, and hooks as distributable packages.

## Structure

```text
.claude-plugin/
  marketplace.json            # Marketplace manifest — lists all plugins with metadata
.github/
  workflows/
    auto_release.yml          # v* tag push → validate versions, build artifacts, GitHub release
    manual_release.yml        # workflow_dispatch → bump version, tag, build, release
  scripts/                    # Shared release-note and changelog helpers
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
      ship-check/             # Pipeline orchestrator
      pr-review/              # Phase 1 — correctness, security, conditional checks
      code-quality/           # Phase 2 — naming, structure, conventions
      test-audit/             # Phase 3 — test quality + coverage gaps
      bug-check/              # Phase 4 — systematic bug hunt
      pr-monitor/             # Phase 5 — CI, bot comments, merge readiness
    README.md
README.md                    # Marketplace README
CHANGELOG.md                 # Release history (updated by CI on release)
package.json                 # Repo-level version + metadata (kept in lockstep by CI)
LICENSE                      # MIT
SECURITY.md                  # Vulnerability reporting policy
```

## Adding a plugin

1. Create `plugins/<plugin-name>/` with `.claude-plugin/plugin.json` (minimum: `name` field)
2. Add agents, skills, commands, or hooks directories as needed
3. Add a `README.md` to the plugin directory
4. Register the plugin in `.claude-plugin/marketplace.json` under the `plugins` array
5. Update the root `README.md` plugin table
6. Commit and push

## Conventions

- **Kebab-case** for all directory and file names
- **Agent frontmatter** requires: `name`, `description`, `model`, `color`; optional: `tools`, `skills`
- **Skill directories** contain `SKILL.md` with `name` and `description` in frontmatter
- **Plugin manifests** use semver versioning
- Agent `tools:` fields are allowlists — omit to give all tools, list explicitly to restrict
- Agent `skills:` preloads skill content from any installed plugin or `~/.claude/skills/`

## Releases

Versions are kept in lockstep: `metadata.version` in `.claude-plugin/marketplace.json`,
every `plugins[].version` entry, each plugin's `plugin.json` `version`, and the root
`package.json` `version` must all match the release tag. CI validates this on tag push
and fails the release on mismatch.

- **Manual release** (preferred): Actions → Manual Release → choose patch/minor/major.
  Bumps all version fields, regenerates CHANGELOG.md from conventional commits, commits,
  tags, builds plugin `.zip` and per-skill `.skill` artifacts, and publishes a GitHub release.
- **Tag release**: bump the version fields yourself, push a matching `v*` tag, and
  `auto_release.yml` validates, builds, and publishes.

Commit messages follow conventional-commit syntax — the release-notes generator
buckets them by type (`feat`, `fix`, `refactor`, `docs`, `ci`, `chore`).

## Cross-tool compatibility

| Component | Claude Code / Cowork | Codex / Copilot / Gemini / OpenCode |
|-----------|:-------------------:|:-----------------------------------:|
| Plugin manifest | Yes | No |
| Agents | Yes | No |
| Skills (`SKILL.md`) | Yes | Yes (different paths) |
| Commands | Yes | No |
| Hooks | Yes | No |

Skills are the universal layer. Agents, commands, and hooks are Claude Code/Cowork-only.
