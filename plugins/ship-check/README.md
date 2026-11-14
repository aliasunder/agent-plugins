# ship-check

Dedicated review agents for the ship-check pipeline. Each agent approaches the
codebase without prior context and returns structured findings. Five agents run
Phases 1-5: four of them load conventions independently, and `fresh-eyes` (Phase 2)
deliberately loads none. A sixth agent, `tool-definition-reviewer`, runs as a
conditional step after Phase 5 when a change touches a committed MCP tool list, and
can also be dispatched on demand. A seventh agent, `security-auditor`, runs
conditionally for security-sensitive changes and serves standalone repository audits.

## Agents

| Agent | Phase | Color | Role |
|-------|-------|-------|------|
| `pr-reviewer` | 1 | cyan | Correctness, security, conditional checks (tool-definition changes handed to `tool-definition-reviewer`, feature surface, stale paths) |
| `fresh-eyes` | 2 | purple | Stranger read: every place a newcomer pauses, per function. Report only — no conventions, no edits, no history. Pauses feed into Phase 3. |
| `code-quality-reviewer` | 3; design pass after 5, and in 6 when code changed since | green | Naming, structure, comments, simplicity, module conventions. Resolves fresh-eyes pauses. In the design pass, reads the whole PR for duplicated logic, redundant mechanisms and guards that don't earn their place; report only. |
| `test-auditor` | 4 | yellow | Test quality audit + coverage gap analysis (writes missing tests); a stand-in audit of stubbed dependencies when the project has a verification profile |
| `bug-checker` | 5 | red | 7-dimension systematic bug hunt (description-vs-code, SQL, type safety, etc.) |
| `tool-definition-reviewer` | after 5, when a tool list changed; or on demand | orange | MCP tool definitions read as the client receives them: rubric marks from Glama's Tool Definition Quality Score (TDQS), a bullet filed under the wrong lead-in or a phrase with no named referent, text changed in tools nobody meant to touch, dropped facts, added sentences that give the calling agent nothing to act on, description text that repeats the schema, and failures the description never lists. Report only. |
| `security-auditor` | after design/tool-definition triage when security boundaries change; or standalone | red | Complete-surface security audit, local-only reproduction and private findings. Report only. |

Phase 6 (pr-monitor) runs inline in the orchestrator — it needs user interaction
and continuous monitoring, which agents can't do. `fresh-eyes` can also be dispatched
standalone to see what a newcomer experiences without the pipeline.

The design pass is a report-only run of `code-quality-reviewer`: it reads the whole
PR, not a delta, and proposes what the change could remove or merge. It runs once
after Phase 5, and once more in Phase 6, before the first merge-ready verdict, when
code changed since. It edits nothing. Every proposal to remove a guard, check,
catch or option goes to the user, and so does every proposal from the second run.
`--skip design-pass` turns off both runs.

The pipeline dispatches `tool-definition-reviewer` when a change touches a committed
tool-list file (a server's `tools/list` saved as JSON):

1. After Phase 5, the `ship-check` skill runs `surface-diff.ts --plan` to find each
   tool whose definition changed, and dispatches the reviewer for the tool-list
   file with the most changed tools. A tool with the same definition before and
   after in several tool-list files is reviewed once. In every other tool-list
   file, the pipeline proofreads only the lines that file words differently, for
   typos and broken sentences.
2. Before each merge-ready verdict, it reviews again any tool text edited since
   the last tool review. When the user accepts a fix for a fault class, such as
   an unexplained returned field, the reviewer also checks every tool the PR
   changed in that file for the same fault. From the second re-review round (the
   first, in a local run), the user can accept that round's fixes without another
   review.

Dispatch it yourself for a server that commits no tool list (see Usage).

The `ship-check` skill's verification step runs the project's live test last in
Phase 6, before the first merge-ready verdict. It runs only when the project's
`CLAUDE.local.md` has a `## Verification profile` (the labels inline, or one
`Profile:` line linking the note or file that holds them) and the PR changes one of
these:

- a file under the profile's artifact paths that no exemption class covers: the step
  deploys the PR and probes it
- only files under the profile's audit paths: the step probes them locally, with no
  deploy

`--skip verification` turns it off.

The security auditor runs when a change affects sign-in, permissions or other
security boundaries. It reviews the affected paths before the initial push; see
the [security checkpoint](skills/ship-check/SKILL.md#security-audit-conditional) for details.

## External Dependencies

Each agent preloads skills via `skills:` frontmatter. The `pr-review`,
`code-quality`, `test-audit`, `bug-check`, `fresh-eyes`,
`tool-definition-review`, `security-audit` and `repo-security-review` skills are
bundled in this plugin;
[fable-mode](https://github.com/mrtooher/fable-mode) is external and must be
installed separately (e.g. in `~/.claude/skills/`). `fresh-eyes` preloads only its
own skill and uses no MCP tools. `tool-definition-reviewer` preloads its own skill
and fable-mode, and the only MCP tool it uses is `sequentialthinking`.

The `tool-definition-review` skill bundles one script, `scripts/surface-diff.ts`.
It has no dependencies and runs with [Bun](https://bun.sh). Without Bun the agent
reports the review as `failed`, and in the pipeline the tool-definition step fails
and holds the merge-ready verdict until you accept the missing review.

The `ship-check` skill bundles `scripts/artifact-gate.ts`, which decides whether a
PR's changes need the verification step. It also runs with Bun. Without Bun the
step cannot classify the change and holds the merge-ready verdict.

The auditor preloads the bundled `repo-security-review` method. For standalone
repository audits, use the bundled `security-audit` skill. Codex/OpenCode require
external native translators; the auditor role is `ship-check:security-auditor` in
Claude/Codex and `ship-check--security-auditor` in OpenCode.

The four convention-loading phase agents also use MCP tools
loaded at runtime via `ToolSearch`:

- `vault_get_memory` ([vault-cortex](https://github.com/aliasunder/vault-cortex) MCP) — user preferences
- `sequentialthinking` ([sequential-thinking](https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking) MCP) — reasoning organization

## Usage

### Model and effort

The dispatcher reads guidance named by the project. Without a pointer, it uses
vault tools to find a unique living reference tagged `model-selection`. If
guidance cannot be read or found, it reports the fallback and uses these defaults:

| Runtime | Model | Ordinary review | Bug-check, security-auditor or explicitly adversarial/security PR review |
|---|---|---|---|
| Codex | `gpt-6.1-sol` | `high` | `xhigh` |
| Claude | `opus` | `high` | `xhigh` |

Guidance overrides the portable defaults. The selected model stays fixed through
the run, including fresh-eyes, delta reviews and tool-definition continuations.
The dispatcher never escalates to the Astra or Fable models (other model tiers the
guidance lists beside Sol and Opus) without an explicit model choice.

| Option | Effect |
|---|---|
| `--model <selector>` | Selects one supported model for the run; omitted effort follows the review's task class. |
| `--effort <level>` | Selects supported effort for every cold review in the run. |
| `--model inherit` alone | Preserves verified parent model and effort. |
| `--effort inherit` | Preserves verified parent effort, independently of model selection. |
| `--model inherit --effort high` | Preserves parent model and explicitly uses high effort. |
| `--inline`, `--fork` | Ordinary phases retain session controls; the security auditor stays a fresh dedicated role with resolved controls. |
| `--only security-audit` | Runs the conditional audit only; makes no full-pipeline readiness claim. |
| `--skip security-audit` | Waives initial/delta audits; reports skipped by request. |

Codex cold dispatches use dedicated `agent_type`, `fork_turns: "none"`, `model`
and `reasoning_effort`. Claude uses dedicated `subagent_type`, `model` and supported
`effort`; when the Agent tool has no effort parameter, the dedicated role must
already set the requested effort, and the dispatcher verifies that it does.
OpenCode uses native `subagent` with the dedicated role and a verified
`provider/model#variant` on each call; the generated reviewer roles carry no
model. The dispatcher labels the effective controls and reports requested choices
it cannot realize.
Unsupported choices are reported without substitution.

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
