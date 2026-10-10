# ship-check

Dedicated review agents for the ship-check pipeline. Each agent approaches the
codebase without prior context and returns structured findings. The four phase
agents that load conventions do so independently; `fresh-eyes` (Phase 2)
deliberately loads none. A sixth agent, `tool-definition-reviewer`, runs as a
conditional step after Phase 5 when a change touches a committed MCP tool list, and
can also be dispatched on demand.

## Agents

| Agent | Phase | Color | Role |
|-------|-------|-------|------|
| `pr-reviewer` | 1 | cyan | Correctness, security, conditional checks (tool-definition changes handed to `tool-definition-reviewer`, feature surface, stale paths) |
| `fresh-eyes` | 2 | purple | Stranger read: every place a newcomer pauses, per function. Report only — no conventions, no edits, no history. Pauses feed into Phase 3. |
| `code-quality-reviewer` | 3 | green | Naming, structure, comments, simplicity, module conventions. Resolves fresh-eyes pauses. |
| `test-auditor` | 4 | yellow | Test quality audit + coverage gap analysis (writes missing tests) |
| `bug-checker` | 5 | red | 7-dimension systematic bug hunt (description-vs-code, SQL, type safety, etc.) |
| `tool-definition-reviewer` | after 5, when a tool list changed; or on demand | orange | MCP tool definitions read as the client receives them: rubric marks from Glama's Tool Definition Quality Score (TDQS), a bullet filed under the wrong lead-in or a phrase with no named referent, text changed in tools nobody meant to touch, dropped facts, description text that repeats the schema, and failures the description never lists. Report only. |

Phase 6 (pr-monitor) runs inline in the orchestrator — it needs user interaction
and continuous monitoring, which agents can't do. `fresh-eyes` can also be dispatched
standalone to see what a newcomer experiences without the pipeline.

The pipeline dispatches `tool-definition-reviewer` when a change touches a committed
tool-list file (a server's `tools/list` saved as JSON):

1. After Phase 5, the `ship-check` skill runs `surface-diff.ts --plan` to find each
   tool whose definition changed, and dispatches the reviewer for them. A tool
   with the same definition before and after in several tool-list files is
   reviewed once.
2. Before each merge-ready verdict, it reviews again any tool text edited since
   the last tool review.

Dispatch it yourself for a server that commits no tool list (see Usage).

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
reports the review as `failed`, and in the pipeline the tool-definition step fails
and holds the merge-ready verdict until you accept the missing review.

The four convention-loading phase agents also use MCP tools
loaded at runtime via `ToolSearch`:

- `vault_get_memory` ([vault-cortex](https://github.com/aliasunder/vault-cortex) MCP) — user preferences
- `sequentialthinking` ([sequential-thinking](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking) MCP) — reasoning organization

## Usage

### Model and effort

The dispatcher reads guidance named by the project. Without a pointer, it uses
vault tools to find a unique living reference tagged `model-selection`. If
guidance cannot be read or found, it reports the fallback and uses these defaults:

| Runtime | Model | Ordinary review | Bug-check or explicitly adversarial/security PR review |
|---|---|---|---|
| Codex | `gpt-6.1-sol` | `high` | `xhigh` |
| Claude | `opus` | `high` | `xhigh` |

Guidance overrides the portable defaults. The selected model stays fixed through
the run, including fresh-eyes, delta reviews and tool-definition continuations.
The dispatcher never escalates to Astra or Fable without an explicit model choice.

| Option | Effect |
|---|---|
| `--model <selector>` | Selects one supported model for the run; omitted effort follows the review's task class. |
| `--effort <level>` | Selects supported effort for every cold review in the run. |
| `--model inherit` alone | Preserves verified parent model and effort. |
| `--effort inherit` | Preserves verified parent effort, independently of model selection. |
| `--model inherit --effort high` | Preserves parent model and explicitly uses high effort. |
| `--inline`, `--fork` | Retain session controls; ignored model/effort flags are disclosed. |

Codex cold dispatches use dedicated `agent_type`, `fork_turns: "none"`, `model`
and `reasoning_effort`. Claude uses dedicated `subagent_type`, `model` and supported
`effort`; when the tool lacks effort, a verified matching setting on that same
role is required. OpenCode Task has no per-call model/effort fields: the dispatcher
reads the dedicated role's model and supported variant and reports overrides the
role cannot realize. Unsupported choices are reported without substitution.

For standalone agents, first read the [skill's Execution guidance](skills/ship-check/SKILL.md#execution)
and resolve both controls before dispatch. Every label includes model and effort.
The examples below show explicit Claude choices; validate them against the current
Agent schema and model support.

### Review dispatches

The agents are dispatched by the `ship-check` skill (bundled in this plugin at `skills/ship-check/`):

```
Agent({ subagent_type: "ship-check:pr-reviewer", model: "opus", effort: "high", description: "PR review — opus / high", prompt: "Review PR #123..." })
Agent({ subagent_type: "ship-check:code-quality-reviewer", model: "opus", effort: "high", description: "Code quality — opus / high", prompt: "..." })
Agent({ subagent_type: "ship-check:test-auditor", model: "opus", effort: "high", description: "Test audit — opus / high", prompt: "..." })
Agent({ subagent_type: "ship-check:bug-checker", model: "opus", effort: "xhigh", description: "Bug check — opus / xhigh", prompt: "..." })
```

They can also be dispatched standalone for single-dimension reviews. `fresh-eyes`
runs as Phase 2 in the pipeline and can also be dispatched standalone — either way
it needs the file list in its prompt:

```
Agent({ subagent_type: "ship-check:fresh-eyes", model: "opus", effort: "high", description: "Fresh eyes — opus / high", prompt: "Read src/a.ts and src/b.ts at <sha> as a stranger..." })
```

To dispatch `tool-definition-reviewer` yourself, give it the tool list as a file
(called a "surface" in the prompt): the JSON a client gets from the MCP `tools/list`
method, or a snapshot the project commits to its repository. Give it the file from
before the change as well, when there is one:

```
Agent({ subagent_type: "ship-check:tool-definition-reviewer", model: "opus", effort: "high", description: "Tool definitions — opus / high", prompt: "Current surface: /tmp/tools-now.json\nBase surface: /tmp/tools-before.json\nIntended tools: search_notes, read_note\nRepository root: /path/to/server" })
```

Only `Current surface` is required. Each other line unlocks checks:

- `Base surface` is the same file from before the change. Without it the agent
  reviews every tool and skips the checks that compare the two files.
- `Intended tools` names the tools the change means to alter. The agent reports a
  changed tool outside this list as an unintended change.
- `Repository root` is where the server's source lives. The agent traces each
  tool's handler there to find failures the description does not list.
