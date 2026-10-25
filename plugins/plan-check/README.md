# plan-check

Pre-implementation plan review — the upstream counterpart to
[ship-check](../ship-check/). Ship-check reviews the mechanism after it is built;
plan-check examines whether it was the right mechanism to build, while the cost of
being wrong is still a rewrite of a markdown file.

## Why it exists

The founding case: a row cap on OAuth client registrations was planned,
implemented, and passed all four ship-check phases (9 code-level findings, all
mechanism-correct). Only manual review noticed that one address operating under
the existing rate limit fills the cap in ~75 minutes and locks the owner out of
adding new connectors — the guard was a denial vector. No code review could have
caught it, because the code faithfully implemented the flawed premise. Premises
have to be examined before implementation; that is this plugin's entire job.

## Components

| Component | Type | Role |
|-----------|------|------|
| `plan-reviewer` | Agent | Fresh-eyes critique of a plan, task note, or plan-mode output. Findings only — never edits, never implements. |
| `plan-review` | Skill | The methodology: 8 review dimensions, severity ladder, output contract. Usable standalone/inline on surfaces without agents. |

## Review dimensions

1. **Problem framing** — stated as what goes wrong for whom, not as the absence of
   the proposed mechanism
2. **Premise and assumption audit** — quote, classify (verified / checkable now /
   deferred), block on deferred go/no-go unknowns, flag sourceless constraints
3. **Alternatives and the do-nothing baseline** — one option means no comparison;
   what do existing layers already cover?
4. **Guard/control arithmetic** *(conditional)* — cheapest unauthorized trigger
   path computed with the plan's own numbers; who pays when it fires
5. **Concurrent writers and async state** — every other writer of touched state;
   proxy-for-truth conflations; what survives the reset
6. **Scope and proportionality** — post-incident overcompensation, the accepted
   mechanism's cost priced against the margin it buys over the next-cheapest
   alternative, scope creep, multi-PR delivery mechanics
7. **Verification plan quality** — runnable checks that can fail; destructive test
   steps get their own blast-radius analysis
8. **Structure and open-question hygiene** — task-note conventions; go/no-go
   unknowns separated from user-judgment questions

Dimensions and severity rules are distilled from a corpus of real planning
failures and conventions in the maintainer's project history (plans, task notes,
and session logs), not from first principles.

## Usage

In Claude Code with the plan-check plugin enabled:

```
/plan-check:plan-review                 # inline, reviews the plan in context
```

Or dispatch the agent for fresh-eyes review:

> Use the plan-reviewer agent to review plans/my-feature.md

Before spawning the dedicated reviewer, read the
[plan-review skill's Dispatcher guidance](skills/plan-review/SKILL.md#dispatcher-guidance).
An already-running reviewer does not relaunch itself. The inline skill invocation
above retains the current session's model and effort.

In Tanisha's OpenCode V2 setup, follow the setup and `--write` procedure in
`~/.agents/skills/sync-opencode-plugins/SKILL.md`, then verify the dedicated
reviewer in a fresh session. Use `/plan-review <plan path>` to dispatch it.
The plugin marketplace does not install this adapter or command.

Like ship-check, the agents load personal context (vault-cortex MCP, fable-mode
skill) and won't work for anyone else without adaptation — the structure and
review dimensions are the reusable part.

### Model and effort

The dispatcher reads project-supplied guidance first. With no pointer, available
vault tools find a unique living reference tagged `model-selection`. If guidance
cannot be read or found, the dispatcher reports the fallback:

| Runtime | Portable model | Adversarial review effort |
|---|---|---|
| Codex | `gpt-6.1-sol` | `xhigh` |
| Claude | `opus` | `xhigh` |

Guidance overrides these defaults; explicit user choices override guidance.

| Control | Effect |
|---|---|
| Concrete `--model`, effort omitted | Uses that model and guidance's adversarial effort, or portable `xhigh`. |
| `--effort <level>` | Uses supported explicit effort. |
| `--model inherit` alone | Preserves verified parent model and effort. |
| `--effort inherit` | Preserves verified parent effort independently of the model. |
| `--model inherit --effort high` | Preserves the parent model and explicitly uses high effort. |
| Inline invocation or fork | Retains session controls; ignored model/effort flags are disclosed. |

Codex keeps `agent_type: "plan-check:plan-reviewer"` with `fork_turns: "none"`
and explicit `model` and `reasoning_effort`. Claude keeps the dedicated
`subagent_type` with supported `model` and `effort`; if the tool lacks effort, a
verified matching setting on that same role is required.

OpenCode V2 uses native `subagent` with `agent: "plan-check--plan-reviewer"`,
`description`, `prompt`, a verified `model: "provider/model#variant"` and
`background: false`. The `/plan-review` command runs in OpenCode's build agent to resolve
an explicit target or an unambiguous artifact in the current conversation, then
calls a fresh dedicated reviewer and relays its complete report verbatim. Missing
or ambiguous targets are resolved before dispatch; role, permission and depth
failures stop without an inline substitute.

The OpenCode dispatcher chooses model and effort deliberately from the shared
model guide, using non-Anthropic/non-OpenAI models and never Grok. It verifies
model IDs and supported variants through `tools.opencode.models` (Code Mode
`opencode_models`), including pagination or exact-ID lookup before declaring a
choice absent. It labels the native variant and stops on unsupported explicit
controls; vendor variants are never guessed to equal `high` or `xhigh`.
Generated roles remain model-free. The catalog does not identify the parent's
current model or variant. Parent matching or inheritance requires trusted
runtime/caller identity metadata; without it, the dispatcher requests a concrete
model reference instead of guessing from config, catalog order or self-description.
Every dispatch label names the resolved model and effort.
