# ship-check

Dedicated review agents for the ship-check pipeline. Each agent approaches the
codebase without prior context and returns structured findings. The five phase
agents that load conventions do so independently; `fresh-eyes` (Phase 2)
deliberately loads none.

## Agents

| Agent | Phase | Color | Role |
|-------|-------|-------|------|
| `pr-reviewer` | 1 | cyan | Correctness, security, conditional checks (Tool Description Quality Score (TDQS), feature surface, stale paths) |
| `fresh-eyes` | 2 | purple | Stranger read: every place a newcomer pauses, per function. Report only — no conventions, no edits, no history. Pauses feed into Phase 3. |
| `code-quality-reviewer` | 3 | green | Naming, structure, comments, simplicity, module conventions. Resolves fresh-eyes pauses. |
| `test-auditor` | 4 | yellow | Test quality audit + coverage gap analysis (writes missing tests) |
| `bug-checker` | 5 | red | 7-dimension systematic bug hunt (description-vs-code, SQL, type safety, etc.) |

Phase 6 (pr-monitor) runs inline in the orchestrator — it needs user interaction
and continuous monitoring, which agents can't do. `fresh-eyes` can also be dispatched
standalone to see what a newcomer experiences without the pipeline.

## External Dependencies

Each agent preloads skills via `skills:` frontmatter. The `pr-review`,
`code-quality`, `test-audit`, `bug-check`, and `fresh-eyes` skills are bundled in
this plugin; [fable-mode](https://github.com/mrtooher/fable-mode) is external and
must be installed separately (e.g. in `~/.claude/skills/`). `fresh-eyes` preloads
only its own skill and uses no MCP tools.

The convention-loading phase agents (all except `fresh-eyes`) also use MCP tools
loaded at runtime via `ToolSearch`:

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
runs as Phase 2 in the pipeline and can also be dispatched standalone — either way
it needs the file list in its prompt:

```
Agent({ subagent_type: "ship-check:fresh-eyes", prompt: "Read src/a.ts and src/b.ts at <sha> as a stranger..." })
```
