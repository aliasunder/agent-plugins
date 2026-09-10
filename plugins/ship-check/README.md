# ship-check

Dedicated review agents for the ship-check pipeline. Each agent approaches the
codebase without prior context and returns structured findings. The four phase
agents load project conventions and user preferences independently; `fresh-eyes`
deliberately loads none.

## Agents

| Agent | Phase | Color | Role |
|-------|-------|-------|------|
| `pr-reviewer` | 1 | cyan | Correctness, security, conditional checks (TDQS, feature surface, stale paths) |
| `code-quality-reviewer` | 2 | green | Naming, structure, comments, simplicity, module conventions |
| `test-auditor` | 3 | yellow | Test quality audit + coverage gap analysis (writes missing tests) |
| `bug-checker` | 4 | red | 7-dimension systematic bug hunt (description-vs-code, SQL, type safety, etc.) |
| `fresh-eyes` | on demand | purple | Stranger read: every place a newcomer pauses, per function. Report only — no conventions, no edits, no history |

Phase 5 (pr-monitor) runs inline in the orchestrator — it needs user interaction
and continuous monitoring, which agents can't do. `fresh-eyes` is not a pipeline
phase; dispatch it standalone, or on the files a code-quality pass reviewed to see
what the conventions missed.

## External Dependencies

Each agent preloads skills via `skills:` frontmatter. The `pr-review`,
`code-quality`, `test-audit`, `bug-check`, and `fresh-eyes` skills are bundled in
this plugin; [fable-mode](https://github.com/mrtooher/fable-mode) is external and
must be installed separately (e.g. in `~/.claude/skills/`). `fresh-eyes` preloads
only its own skill and uses no MCP tools.

The four phase agents also use MCP tools loaded at runtime via `ToolSearch`:

- `vault_get_memory` ([vault-cortex](https://github.com/aliasunder/vault-cortex) MCP) — user preferences
- `sequentialthinking` ([sequential-thinking](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking) MCP) — reasoning organization

## Usage

The agents are dispatched by the `ship-check` skill (bundled in this plugin at `skills/ship-check/`):

```
Agent({ subagent_type: "ship-check:pr-reviewer", prompt: "Review PR #123..." })
Agent({ subagent_type: "ship-check:code-quality-reviewer", prompt: "..." })
Agent({ subagent_type: "ship-check:test-auditor", prompt: "..." })
Agent({ subagent_type: "ship-check:bug-checker", prompt: "..." })
```

They can also be dispatched standalone for single-dimension reviews. `fresh-eyes`
is standalone only and needs the file list in its prompt:

```
Agent({ subagent_type: "ship-check:fresh-eyes", prompt: "Read src/a.ts and src/b.ts at <sha> as a stranger..." })
```
