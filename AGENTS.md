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
    test.yml                  # push to main and PRs → run the scripts' tests
    umm_review.yml            # PR review via the aliasunder/umm-actually action (configurable via repo variables)
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
      fresh-eyes.md           # Phase 2 — stranger read, report only
      security-auditor.md      # Conditional complete-surface audit; standalone per-profile audits
      tool-definition-reviewer.md  # After Phase 5 when a tool list changed, or on demand — report only
    skills/                   # Skills (SKILL.md in subdirectories)
      ship-check/             # Pipeline orchestrator
        scripts/              # artifact-gate.ts (the verification step's change classifier),
                              # function-growth.ts (the Growth: line's complexity measurement) and their __tests__/
      pr-review/              # Phase 1 — correctness, security, conditional checks
      fresh-eyes/             # Phase 2 — readability pauses a newcomer hits (report only)
      code-quality/           # Phase 3 — naming, structure, conventions (resolves Phase 2 pauses); dimension 8 is the design pass
      test-audit/             # Phase 4 — test quality + coverage gaps
      bug-check/              # Phase 5 — systematic bug hunt
      pr-monitor/             # Phase 6 — CI, bot comments, merge readiness
      security-audit/         # Standalone two-profile dispatch and shared audit preparation
      repo-security-review/   # Auditor method, local-only reproduction and report format
      tool-definition-review/ # MCP tool-definition review, in the pipeline or on demand (report only)
        scripts/              # surface-diff.ts (also plans the pipeline's dispatches) and its __tests__/
    README.md
  plan-check/                 # Pre-implementation plan review plugin
    .claude-plugin/
      plugin.json             # Plugin manifest
    agents/
      plan-reviewer.md        # Fresh-eyes plan critique agent
    skills/
      plan-review/            # Premise audit, alternatives, guard arithmetic,
                              # concurrent-writer analysis, verification safety
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

## Testing a plugin change

A running Claude Code session uses the installed copy of each plugin, read when
the session started, so an edit in your checkout does not reach it. To try a
change on a real project before it ships, run a headless session from that
project's directory that loads the plugin from your checkout:

```bash
claude -p --plugin-dir <checkout>/plugins/ship-check --setting-sources user,local \
  --settings '{"enabledPlugins":{"ship-check@agent-plugins":false}}' \
  --allowedTools Agent,Read,Grep,Glob \
  --output-format stream-json --verbose < prompt.md > run.jsonl
```

The example allows `Agent`, so the session can dispatch the plugin's agents, and
the read-only tools `Read`, `Grep`, and `Glob`. Add each other tool the prompt
needs to the comma-separated list, such as `Bash(git *)`.

- `--plugin-dir` loads the plugin from your checkout or a worktree; give its
  absolute path, since the command runs from the project's directory.
- `--settings` turns off the installed copy of the same plugin, keyed
  `<plugin>@<marketplace>`. Left on, the installed copy would load beside the
  checkout's copy, with agents of the same names. `--setting-sources user,local`
  leaves out the project's shared settings file (`.claude/settings.json`), whose
  hooks and permission rules are not part of the test.
- A headless run cannot answer a permission prompt, so it denies every tool
  that neither `--allowedTools` nor your own settings allow.
- Put three instructions in the prompt: do only what the prompt asks and start
  no routine your instructions run at session start; message no other session;
  wait for every agent or background task you start before answering, because a
  headless session stops them when it ends and their results are lost.
- `run.jsonl` receives the event stream. Its first `system` record (`subtype`
  `init`) lists each loaded plugin's `name`, `path` and `source`: the checkout
  copy's source is `ship-check@inline`, and no `ship-check@agent-plugins` entry
  should appear. The last `result` record holds the final answer and any
  permission denials.
- Run from a scratch clone of the project. A run allowed `Edit`, `Write`, or
  `Bash`, by `--allowedTools` or by your own settings, can edit and commit
  whatever the prompt asks for. Turn off pushing in that clone first:
  `git remote set-url --push origin no-push`.

The maintainer runs this command through a launcher described in her local
instructions, which saves the report and reports an outcome status.

Before adding a review phase or a reviewer for a class of miss, edit the existing
reviewer's instructions with the fix that would make it catch the miss, then run
that reviewer, loaded from your checkout as above, on the exact miss. Add the phase
only when that run still misses it.

## Conventions

- **Kebab-case** for all directory and file names
- **Agent frontmatter** requires: `name`, `description`, `model`, `color`; optional: `tools`, `skills`
- **Skill directories** contain `SKILL.md` with `name` and `description` in frontmatter
- **Plugin manifests** use semver versioning
- Agent `tools:` fields are allowlists — omit to give all tools, list explicitly to restrict
- Agent `skills:` preloads skill content from any installed plugin or `~/.claude/skills/`
- **Bundled scripts** live in a skill's `scripts/` directory as TypeScript (`.ts`)
  with no npm dependencies, run with Bun. Their tests (`*.test.ts` files) live in
  `scripts/__tests__/`. The release archives leave `__tests__` out, through the
  `-x` patterns on the `zip` commands in both release workflows.
- **Run every script test** with `bun test plugins`. The argument is a path
  filter: Bun runs every test file whose path contains `plugins`.

## Skill authoring

### Trigger structure

When a skill includes procedural rules ("when X → do Y"), each rule should have
three parts:

1. **Action** — what to do (flag, fix, suggest)
2. **Condition** — when it applies (the pattern to match)
3. **Boundary** — when NOT to apply (the decision criterion that prevents false
   positives at edge cases)

The boundary encodes the "why" — not as motivation, but as the line between
"apply" and "skip." Abstract rules ("simplify code") get skipped by agents.
Concrete rules with all three parts fire reliably. If a rule has no meaningful
boundary (always applies), say so explicitly.

### Generalization

Rule text should use generic language — skills in this repo may run across
multiple projects, repos, and languages. Domain-specific terms in rule text may
cause the agent to skip checks in contexts that don't match the framing.

Illustrative examples are fine to keep domain-specific — they help the agent
understand the pattern concretely. Only generalize the rule itself.

### Improving skills from real-world evidence

When real-world use reveals patterns a skill missed (user had to correct
manually, bot caught something the skill didn't):

1. Categorize each miss — which skill and which dimension should have caught it
2. Check whether a rule already exists — if it does but didn't fire, that's a
   model execution gap, not a rule gap (note for calibration, don't add text)
3. Write the rule with action + condition + boundary
4. Use generic language in the rule, concrete examples from the source

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
