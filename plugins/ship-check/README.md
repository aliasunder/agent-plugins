# ship-check

Fresh-eyes review agents for the ship-check pipeline. Each agent approaches the
codebase without prior context, loads project conventions and user preferences
independently, and returns structured findings.

## Agents

| Agent | Phase | Color | Role |
|-------|-------|-------|------|
| `pr-reviewer` | 1 | cyan | Correctness, security, conditional checks (TDQS, feature surface, stale paths) |
| `code-quality-reviewer` | 2 | green | Naming, structure, comments, simplicity, module conventions |
| `test-auditor` | 3 | yellow | Test quality audit + coverage gap analysis (writes missing tests) |
| `bug-checker` | 4 | red | 7-dimension systematic bug hunt (description-vs-code, SQL, type safety, etc.) |

Phase 5 (pr-monitor) runs inline in the orchestrator — it needs user interaction
and continuous monitoring, which agents can't do.

## External Dependencies

Each agent preloads skills via `skills:` frontmatter. These skills must be installed
in `~/.claude/skills/`:

- `pr-review`
- `code-quality`
- `test-audit`
- `bug-check`
- `fable-mode`

Each agent also uses MCP tools loaded at runtime via `ToolSearch`:

- `vault_get_memory` (vault-cortex MCP) — user preferences
- `sequentialthinking` (sequential-thinking MCP) — reasoning organization

## Usage

The agents are dispatched by the `ship-check` skill (in `~/.claude/skills/ship-check/`):

```
Agent({ subagent_type: "ship-check:pr-reviewer", prompt: "Review PR #123..." })
Agent({ subagent_type: "ship-check:code-quality-reviewer", prompt: "..." })
Agent({ subagent_type: "ship-check:test-auditor", prompt: "..." })
Agent({ subagent_type: "ship-check:bug-checker", prompt: "..." })
```

They can also be dispatched standalone for single-dimension reviews.
