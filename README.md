# agent-plugins

Personal plugin marketplace for Claude Code and Claude Cowork — review agents, workflow orchestrators, and specialized skills.

> [!NOTE]
> **This is a personal workflow repo.** The plugins here are built around my
> specific setup: they load cross-project code standards and preferences from a
> personal Obsidian-vault MCP server ([vault-cortex](https://github.com/aliasunder/vault-cortex))
> and use external skills ([fable-mode](https://github.com/mrtooher/fable-mode))
> that live outside this repo. Installed as-is, they won't work for anyone else without
> adaptation. That said, the plugin structure, agent/skill design, and the
> ship-check review-pipeline pattern may be useful as a reference for building
> your own.

## Plugins

| Plugin | Description |
|--------|-------------|
| [ship-check](plugins/ship-check/) | Post-implementation review pipeline: six dedicated review agents (pr-reviewer, code-quality-reviewer, test-auditor, bug-checker, fresh-eyes, tool-definition-reviewer) plus eight skills: the pipeline orchestrator and one each for PR review, code quality, test audit, bug hunting, stranger reads, MCP tool-definition review, and PR monitoring |
| [plan-check](plugins/plan-check/) | Pre-implementation plan review: a fresh-eyes agent (plan-reviewer) plus the plan-review skill — premise audit, alternatives comparison, guard/control arithmetic, concurrent-writer analysis, mechanism-cost proportionality, and verification-plan safety before any code exists |

## Structure

- **`.claude-plugin/marketplace.json`** — marketplace manifest listing all plugins
- **`plugins/`** — the plugins themselves (agents, skills, manifests)
- **`.github/workflows/`** — release automation, script tests (`test.yml`), and PR review (`umm_review.yml`)

## Installation

Register the marketplace, then install a plugin:

```
claude plugin marketplace add aliasunder/agent-plugins
claude plugin install ship-check@agent-plugins
```

Or run `/plugin` inside Claude Code and open the Discover tab.

For local development, register the repo directory instead:

```
claude plugin marketplace add ~/Code/agent-plugins
```

The ship-check tool-definition reviewer runs a bundled script, which needs [Bun](https://bun.sh) installed.

## Adapting for your own use

If you want to use these plugins as a starting point:

1. Replace the vault-cortex loading steps ([vault-cortex](https://github.com/aliasunder/vault-cortex)) in the agents and skills — `vault_read_note` calls on `Reference/code-standards-*.md` and `vault_memory_recall`/`vault_get_memory` preference retrieval — with your own standards docs and memory/preference source (or remove them)
2. If you dropped vault-cortex, remove its entries from the agents' `tools:` allowlists. Claude Code names an MCP tool `mcp__<server>__<tool>`, so the vault-cortex entries start with `mcp__claude_ai_Vault_Cortex__` or `mcp__vault-cortex__` (the same server, connected two ways).
3. Install [fable-mode](https://github.com/mrtooher/fable-mode) as a skill, or remove it from the agents' `skills:` lists
4. Install the [sequential-thinking](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking) MCP server. The skills tell the agents to call the server's `sequentialthinking` tool before they decide what to do with a finding. To go without the server, drop that tool from the agents' `tools:` allowlists and the skills' `allowed-tools:` lists, and remove the skill steps that call it.
5. The pipeline structure, review dimensions, and procedural triggers in the skills are workflow-agnostic and should transfer as-is

## License

[MIT](LICENSE)
