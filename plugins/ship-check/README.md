# ship-check

Dedicated review agents for the ship-check pipeline. Each agent approaches the
codebase without prior context and returns structured findings. The four phase
agents that load conventions do so independently; `fresh-eyes` (Phase 2)
deliberately loads none. A sixth agent, `tool-definition-reviewer`, is dispatched
on demand and is not a pipeline phase.

## Agents

| Agent | Phase | Color | Role |
|-------|-------|-------|------|
| `pr-reviewer` | 1 | cyan | Correctness, security, conditional checks (Tool Definition Quality Score (TDQS), feature surface, stale paths) |
| `fresh-eyes` | 2 | purple | Stranger read: every place a newcomer pauses, per function. Report only — no conventions, no edits, no history. Pauses feed into Phase 3. |
| `code-quality-reviewer` | 3 | green | Naming, structure, comments, simplicity, module conventions. Resolves fresh-eyes pauses. |
| `test-auditor` | 4 | yellow | Test quality audit + coverage gap analysis (writes missing tests) |
| `bug-checker` | 5 | red | 7-dimension systematic bug hunt (description-vs-code, SQL, type safety, etc.) |
| `tool-definition-reviewer` | on demand | orange | MCP tool definitions read as the client receives them: TDQS rubric marks, a bullet filed under the wrong lead-in or a phrase with no named referent, text changed in tools nobody meant to touch, dropped facts, description text that repeats the schema, and failures the description never lists. Report only. |

Phase 6 (pr-monitor) runs inline in the orchestrator — it needs user interaction
and continuous monitoring, which agents can't do. `fresh-eyes` can also be dispatched
standalone to see what a newcomer experiences without the pipeline.

`tool-definition-reviewer` is not dispatched by the pipeline. Dispatch it yourself
when a change touches an MCP server's tool descriptions or input schemas.

## External Dependencies

Each agent preloads skills via `skills:` frontmatter. The `pr-review`,
`code-quality`, `test-audit`, `bug-check`, `fresh-eyes`, and
`tool-definition-review` skills are bundled in this plugin;
[fable-mode](https://github.com/mrtooher/fable-mode) is external and must be
installed separately (e.g. in `~/.claude/skills/`). `fresh-eyes` preloads only its
own skill and uses no MCP tools. `tool-definition-reviewer` preloads its own skill
and fable-mode, and the only MCP tool it uses is `sequentialthinking`.

The `tool-definition-review` skill bundles one script, `scripts/surface-diff.ts`.
It has no dependencies and runs with [Bun](https://bun.sh). Without Bun the agent
reports the review as `failed`.

The four convention-loading phase agents also use MCP tools
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

`tool-definition-reviewer` needs the tool list as a file (called a "surface" in the
prompt): the JSON a client gets from the MCP `tools/list` method, or a snapshot the
project commits to its repository. Give it the file from before the change as well,
when there is one:

```
Agent({ subagent_type: "ship-check:tool-definition-reviewer", prompt: "Current surface: /tmp/tools-now.json\nBase surface: /tmp/tools-before.json\nIntended tools: search_notes, read_note\nRepository root: /path/to/server" })
```

Only `Current surface` is required. Each other line unlocks checks:

- `Base surface` is the same file from before the change. Without it the agent
  reviews every tool and skips the checks that compare the two files.
- `Intended tools` names the tools the change means to alter. The agent reports a
  changed tool outside this list as an unintended change.
- `Repository root` is where the server's source lives. The agent traces each
  tool's handler there to find failures the description does not list.
