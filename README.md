# agent-plugins

Personal plugin marketplace for Claude Code and Claude Cowork — review agents, workflow orchestrators, and specialized skills.

> [!NOTE]
> **This is a personal workflow repo.** The plugins here are built around my
> specific setup: they reference machine-local paths (`~/.claude/references/`),
> a personal Obsidian-vault MCP server ([vault-cortex](https://github.com/aliasunder/vault-cortex))
> for loading my preferences, and external skills ([fable-mode](https://github.com/mrtooher/fable-mode))
> that live outside this repo. Installed as-is, they won't work for anyone else without
> adaptation. That said, the plugin structure, agent/skill design, and the
> ship-check review-pipeline pattern may be useful as a reference for building
> your own.

## Plugins

| Plugin | Description |
|--------|-------------|
| [ship-check](plugins/ship-check/) | Post-implementation review pipeline: four fresh-eyes review agents (pr-reviewer, code-quality-reviewer, test-auditor, bug-checker) plus six skills covering PR review, code quality, test audit, bug hunting, and PR monitoring |

## Structure

- **`.claude-plugin/marketplace.json`** — marketplace manifest listing all plugins
- **`plugins/`** — the plugins themselves (agents, skills, manifests)
- **`.github/workflows/`** — release automation (version validation, artifact builds, GitHub releases)

## Installation

Register the marketplace, then install a plugin:

```
claude plugin marketplace add aliasunder/agent-plugins
claude plugin install ship-check@agent-plugins
```

Or browse via `/plugin > Discover`.

For local development, register the repo directory instead:

```
claude plugin marketplace add ~/Code/agent-plugins
```

## Adapting for your own use

If you want to use these plugins as a starting point:

1. Replace the `vault_get_memory` ([vault-cortex](https://github.com/aliasunder/vault-cortex)) preference-loading steps in the agents with your own memory/preference source (or remove them)
2. Replace the `~/.claude/references/*.md` reference-doc paths with your own standards docs
3. Install [fable-mode](https://github.com/mrtooher/fable-mode) as a skill, or remove it from the agents' `skills:` lists
4. Install the [sequential-thinking](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking) MCP server — the agents use it for triage reasoning (or drop it from their `tools:` allowlists)
5. The pipeline structure, review dimensions, and procedural triggers in the skills are workflow-agnostic and should transfer as-is

## License

[MIT](LICENSE)
