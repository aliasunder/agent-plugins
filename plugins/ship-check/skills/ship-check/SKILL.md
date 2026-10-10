---
name: ship-check
description: >
  Run the full post-implementation review pipeline: pr-review -> fresh-eyes ->
  code-quality -> test-audit -> bug-check -> pr-monitor. Phases 1-5 run as
  dedicated agent types (ship-check plugin) with skills preloaded — genuine fresh
  eyes with no inherited context. Phase 6 (pr-monitor) runs inline for user
  interaction. When a change touches a committed MCP tool list, the
  tool-definition reviewer runs after Phase 5 and again before each merge-ready
  verdict.
  Use when asked to "ship check", "review pipeline", "full review", "run all
  reviews", or after implementation is complete and ready for review.
  NOT for: single-dimension review (use the individual skill), quick CI check
  (use pr-monitor), or post-merge testing (use verify).
---

# Ship Check

Orchestrate the full review pipeline. Phases 1-5 dispatch **dedicated agent types**
from the ship-check plugin (not forks) so each reviewer approaches the code as a
genuine stranger — no inherited context, no authorship bias. Each agent has its review
skill and fable-mode preloaded via the `skills:` frontmatter, and loads project
conventions (CLAUDE.md, AGENTS.md, CLAUDE.local.md) and vault memory independently.
Phase 2 (fresh-eyes) is the exception: it deliberately loads no conventions, no
memory, and no shell — only Read/Grep/Glob — so its pauses reflect what a newcomer
experiences, not what the project allows.

## Pipeline

```
Phase 1: ship-check:pr-reviewer          -> correctness, security, conditional checks
Phase 2: ship-check:fresh-eyes            -> stranger pauses (report only, no conventions)
Phase 3: ship-check:code-quality-reviewer -> convention compliance, readability (resolves Phase 2 pauses)
Phase 4: ship-check:test-auditor          -> test design, assertion quality, coverage gaps
Phase 5: ship-check:bug-checker           -> description-vs-code, SQL, type coercion, boundary
Tool-definition review (conditional): ship-check:tool-definition-reviewer
                                          -> MCP tool definitions, only when a tool-list file changed (report only)
Phase 6: pr-monitor (inline)              -> CI status, bot comment resolution, loop until ready
```

## Attribution

Every piece of text the pipeline posts to a PR — inline review comments, review
bodies, PR-level comments, thread replies — MUST include the attribution footer.
This applies in ALL modes (default and comment), to ALL participants (phase agents,
orchestrator triage, pr-monitor replies).

**Comment footer format**: `\n\n---\n*🔍 ship-check · <component> · <model-id>*`

- `<component>` is the phase or role: `pr-review`, `code-quality`, `test-audit`,
  `bug-check`, `pr-monitor`, `triage` (for orchestrator inter-phase triage posts), or
  `tool-definitions` (for the orchestrator's post of tool-definition review findings).
- `<model-id>` identifies the poster's exact runtime model. Resolve it by runtime:
  - **Claude agent mode:** the phase agent uses the family ID from its system context,
    such as `claude-opus-4-6`; omit context-window and dated-build suffixes.
  - **Codex agent mode:** the orchestrator passes an exact model on every spawn and
    adds `Attribution model ID: <exact-id>` to the phase prompt. The phase agent uses
    that value verbatim. A Codex child never searches rollout files or infers a model
    from memory, parent prose, recency, cwd, or display name.
  - **OpenCode agent mode:** use the exact provider/model ID exposed by the child
    runtime or supplied by its dispatcher.
  - **Inline mode:** the poster uses the current session's exact runtime context. A
    Codex inline poster matches its own `CODEX_THREAD_ID` to
    `session_meta.payload.id` before reading
    `session_meta.payload.base_instructions.provenance.model`.
  If the required source is missing, stop before posting and report the attribution
  blocker.
- **The orchestrator's own PR-level comments** (non-inline findings, deferred items
  posted via `gh pr comment`) follow the same runtime-specific model-label rule with
  component `triage` or `ship-check`.

A comment posted without a footer is indistinguishable from the repo owner's manual
comments and misattributes automated output to a human. Every `gh api` and
`gh pr comment` call in the pipeline includes the footer — no exceptions.

**Commit trailer format**: every commit a phase agent makes includes a `Ship-Check`
git trailer identifying the phase and the agent's model:

```
Ship-Check: <component> · <model-id>
```

Add this instruction to each phase dispatch prompt (phases 1, 3-5 — Phase 2 does not
commit):

For Codex agent mode, prepend the literal prefix `Attribution model ID: ` followed by
the exact model passed to spawn, for example `Attribution model ID: gpt-5.6-terra`.
Never dispatch an unexpanded placeholder.

```
When committing, add this trailer to every commit message (after the body, before
any trailers the harness adds):
Ship-Check: PHASE_NAME · YOUR_MODEL_ID
Use the runtime-specific model label defined above for YOUR_MODEL_ID.
```

The harness appends its own `Co-Authored-By` trailer automatically; the `Ship-Check`
trailer supplements it with the phase and the agent's actual model, not the
dispatching session's.

## Before starting

1. **Check for a PR.** Run `gh pr view` on the current branch.
   - **PR exists**: record the PR number, branch name, and base branch. Proceed normally.
   - **No PR, and `--local` or `--report` was passed**: proceed in local review mode
     (see Local review mode below).
   - **No PR, no flag**: offer two options — create a PR first, or proceed in local
     review mode.
2. **Identify the review range.** In PR mode: the PR diff against the base branch. In
   local mode: `--diff <base>` if supplied, otherwise `HEAD~N..HEAD` where N is the
   number of commits since the last merge or tag (use `git log --oneline --first-parent
   main..HEAD | wc -l`; if on main, use the count of commits since the last tag or a
   user-supplied base).
3. Get the branch name (or "main" in local mode) — agents need this context in their
   briefing.

## Comment mode (`--comment`)

When `--comment` is active, the entire pipeline switches from fix-and-push to
review-and-comment. Each phase posts findings as inline PR review comments via `gh api`
instead of editing files. Phase 6 (pr-monitor) is skipped entirely — the pipeline is
reviewing a PR it isn't responsible for.

### Behavior changes

| Aspect | Default mode | Comment mode |
|--------|-------------|--------------|
| Findings | Edit files, commit, push | Post as inline PR review comments |
| Fresh-eyes (Phase 2) | Pauses flow into code-quality | Pauses flow into code-quality (no change — fresh-eyes never posts) |
| Phase 6 | Runs (monitoring loop) | Skipped |
| Phase sequencing | Sequential (each sees prior fixes) | Sequential (each sees prior findings to avoid duplicates) |
| Test-audit | Writes missing tests | Reports coverage gaps as comments |
| Tool-definition review | Triage, may fix; re-review before each merge-ready verdict | One PR-level comment with the reports' Defects and Unintended text changes; no re-review |
| Inter-phase triage | Evaluates flagged findings, may fix | Evaluates flagged findings, may post additional comments |

### Dispatch prompt addition

When `--comment` is active, prepend this to every phase's dispatch prompt:

In Codex agent mode, prepend the populated `Attribution model ID` line from the
Attribution section before this block.

```
COMMENT MODE: Do NOT edit any files, commit, or push. Instead, collect all findings
and post them as a single GitHub PR review with inline comments. Follow the "Comment
mode" section in your preloaded skill for the gh api template. Only post a review if
you have findings — skip the API call for 0 findings.
Repo: OWNER_REPO
Append a footer to the review body AND every inline comment body using the
runtime-specific model label from the Attribution section:
\n\n---\n*🔍 ship-check · PHASE_NAME · YOUR_MODEL_ID*
```

### Verify the tree stays clean

Comment mode is a promise that the pipeline leaves the repo untouched — but review
agents carry Edit/Write tools and can drift back into fix-mode habits despite the
dispatch instruction. Run `git status` after EVERY comment-mode phase, before
triage. If the tree is dirty: stop any running phase, show the user the diff, and
ask how to dispose of the edits. Do not assume the review agents produced them — a
dirty tree can equally be a concurrent session working in the same checkout (e.g.
the PR author applying fixes for the very findings the pipeline just posted, which
looks identical to an agent violating comment mode). Never dispatch the next phase
against a contaminated tree — its file reads and line anchors would reflect
uncommitted edits rather than the PR head, producing wrong or missing findings.
Treat an agent report of "no files edited" as a claim to verify, not a fact — and
treat a dirty tree as a claim about the agents to verify, not a verdict.

A related hazard: the checkout itself can change out from under the pipeline
(branch switched, work moved to a worktree). If the PR branch is no longer checked
out where the pipeline started, pin a dedicated detached review worktree at the PR
head (`git worktree add --detach <path> origin/<branch>`) and point subsequent
phases at it.

### Non-inline findings still land on the PR

Not every finding anchors to a diff line — beyond-diff findings, file-level or
repo-level issues, and orchestrator triage deferrals. These must still be visible on
the PR itself, not only in the chat transcript. Sub-agents include what they can in
their review body (e.g. a "Findings beyond the diff" section), but **ensuring
coverage is the primary agent's responsibility, not the sub-agents'**: in default
mode, verify and post as part of Phase 6 (pr-monitoring); in comment mode (Phase 6
skipped), verify after Phase 5 triage and the tool-definition review, and post
anything missing before the final summary. Post via `gh pr comment` /
`POST /repos/{owner}/{repo}/issues/{n}/comments` — include the attribution footer
(see Attribution section above). A finding that exists only in agent output is
invisible to anyone reading the PR.

**Keep the posting command plain.** A sandboxed session (a Claude Code worktree
session, for one) refuses a command it cannot analyze, and each refusal costs a
retry:

- **Never build the body with `$(…)`** — no `"$(cat file)"`, `$(printf …)`, or
  `$(jq …)`. Write the body text directly in the command.
- **When the body mentions `git` (a git command, or the word itself), or the
  sandbox refuses the call once, post from a file instead.** Write the comment,
  footer included, to a file with the file-write tool, then post it as its own
  command:
  ```
  gh pr comment NUMBER --body-file /absolute/path/comment.md
  ```
  Write the path out in full, not through a shell variable. Put the file in
  your session's scratchpad directory when the runtime gives you one;
  otherwise put it in a `probe-pr-NUMBER/` folder directly under `/tmp`, for
  example `/tmp/probe-pr-642/comment-deferred.md`. The `probe-` prefix marks the
  file as a throwaway posting copy: once posted, the PR holds the text.
- **Not a reason to switch:** backticks in the body. They run inline.

### Orchestrator setup

Before dispatching Phase 1, resolve the **repo identifier** for `gh api` calls:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

Pass it as `Repo: owner/repo` in the dispatch prompt. Claude and OpenCode agents use
their runtime-specific model source for the footer. In Codex agent mode, the
orchestrator also passes the exact attribution model ID resolved before Phase 1.

## Local review mode (`--local`)

When no PR exists — direct pushes to main, pre-PR work, or reviewing a commit
range — the pipeline runs in local review mode. Activated automatically when no PR
is found and `--local` or `--report` is passed, or when offered at startup and
accepted.

### Behavior changes from PR mode

| Aspect | PR mode | Local mode |
|--------|---------|------------|
| Review range | PR diff vs base branch | `--diff <base>` if supplied, otherwise commits since last merge/tag |
| Dispatch prompts | Reference PR number and branch | Reference commit range and branch |
| Phase 6 (pr-monitor) | Runs | Skipped — no PR to monitor |
| Comment mode | Posts inline PR review comments | Not available (no PR) |
| Findings | Edit/commit/push (default) or PR comments | On main: report only (implies `--report`). On a branch: edit/commit/push unless `--report` is set. |
| Delta review | Tracks PR head | Not applicable |
| Tool-definition re-review | Before each merge-ready verdict | On a branch, once before the summary when triage fixed tool text; none on `main` |

### Dispatch prompt changes

Replace PR references in each phase dispatch:

- `PR #<number>` → `commits <short-sha>..<short-sha>`
- `branch <branch>` → `branch <branch>` (unchanged if on a branch) or `main` (if reviewing main directly)
- Add: `LOCAL MODE: Report all findings to the orchestrator. Do not post PR comments.`

When `--report` is NOT set and the changes are on a feature branch, agents still fix
and commit normally — local mode only implies `--report` when reviewing main directly
(fixes on main require explicit intent).

## Phase discipline

1. **All 6 phases run by default.** The orchestrator NEVER skips, refuses, or
   short-circuits phases based on its own assessment of the PR's content. This
   includes PRs that only change CI/CD workflows (`.yml`), IaC, Dockerfiles,
   configuration, or documentation — **CI/CD and IaC are reviewable code**, not
   boilerplate to wave through. Each phase determines its own scope and exits
   cleanly when nothing is applicable; the orchestrator dispatches unconditionally.
   Only the user can skip phases — via `--skip` or `--only`.
   **The tool-definition review is the one conditional step.** It runs only when its
   gates find a changed tool-list file — a fact git and the plan script decide (see
   "Tool-definition review (conditional)"). NEVER skip it on your own reading of the
   change; only `--skip tool-definitions` or an `--only` list without it turns it off.

2. **Each phase handles its own scope.** If a phase detects nothing in scope, it reports
   "0 files in scope" and exits cleanly. The orchestrator reports this result, not its
   own judgment. A "0 findings" result from a dispatched agent is a valid outcome —
   it is never a reason to have skipped the dispatch.

3. **Phases run sequentially.** Each phase reviews the code *after* the previous phase's
   fixes are committed and pushed. Never parallelize review phases. Phase 2 (fresh-eyes)
   writes nothing, but it runs before Phase 3 (code-quality) so the pause list exists
   when code-quality starts.

4. **The orchestrator never parrots sub-agent labels.** When a phase returns flagged
   findings, evaluate each one independently using inter-phase triage (below). A
   sub-agent's "low-risk" or "low-confidence" label is input to your assessment, not
   a disposition you relay.

## Inter-phase triage

After each of Phases 1, 3-5 completes, triage any flagged findings BEFORE launching the
next phase. This is mandatory when flagged findings exist — skip only when a phase
reports all findings fixed. Phase 2 (fresh-eyes) produces pauses, not findings — no
triage needed.

### Procedure

Use **sequential thinking** to evaluate each flagged finding. This is not optional —
sequential thinking forces you to deliberate instead of relaying.

1. **Read the flag category** from the phase output. Sub-agents categorize each flagged
   finding as: `uncertain diagnosis`, `complex fix`, `needs design decision`, or
   `pre-existing gap`.
2. **Verify effort claims before applying the matrix.** When a finding is flagged as
   `complex fix`, don't take the sub-agent's effort estimate at face value. Grep for
   actual call sites and usages. "Would change every call site across the codebase"
   has turned out to mean "one call site, one-line fix." A 10-second grep prevents
   deferring a 30-second fix.
3. **Apply the triage matrix**:

   | Category | Fix | Action |
   |-----------|-----|--------|
   | Uncertain diagnosis | Trivial (< 5 lines, no interface change) | Fix — safe even if diagnosis is wrong |
   | Uncertain diagnosis | Complex or risky | Defer to user |
   | Complex fix | Trivial (after grep — step 2) | Fix — the sub-agent overestimated |
   | Complex fix | Actually complex (> 10 lines or interface changes) | Defer to user |
   | Pre-existing gap | Trivial and mechanical | Fix — the PR revealed the gap |
   | Pre-existing gap | Non-trivial or scope question | Present to user — they decide scope |
   | Any | Needs design decision | Always defer to user |

4. **For fixes**: read the relevant code, apply the edit, run tests, commit and push.
   **In comment mode**: instead of editing, post a separate inline comment on the PR
   for each triage fix — use the same `gh api` review template. Mark these as
   orchestrator triage findings so they're distinguishable from phase findings.
5. **Report deferrals immediately — never silently.** Deferring a finding to the user
   is a message to the user, not a bookkeeping state. The moment triage defers a
   finding, say so in the status update before dispatching the next phase: file:line,
   flag category, what the issue is, the options with their tradeoffs, and what
   decision is needed. Phases take minutes each — a deferral held back until the
   final summary is a decision the user didn't know they were sitting on. The final
   summary re-lists deferrals; it is never their first disclosure.
6. **Record results**: track triage fixes separately from phase fixes in the summary.

### Key principle: risk vs. confidence

"Low-risk" (the fix is safe to apply) is a reason TO fix, not to defer. "Low-confidence"
(uncertain whether the issue exists) calls for caution — but when the fix is trivial and
safe, apply it anyway. The cost of a no-op 3-line fix is near zero; the cost of leaving
a real bug is not.

Only defer when the **fix itself** is uncertain, risky, or requires a design decision.

### Effort assessment is not optional

This applies everywhere — inter-phase triage, bot comment handling, user requests,
your own observations. Before calling ANY fix "high lift," "out of scope," "would
change every call site," or deferring because a change "seems complex":

1. **Grep for actual call sites / usages.** `grep -rn "functionName" --include="*.ts" src/`
2. **Count the changes needed.** State the number explicitly: "2 call sites, ~4 lines each."
3. **Then decide.** A fix with 1 call site is not "high lift" regardless of how it
   sounds in the abstract.

The failure this prevents: an agent says "refactoring its signature would change every
call site across the codebase — that's high lift," and a 10-second grep reveals one
call site and a one-line fix. Never estimate effort from intuition when a grep gives
the real answer.

### No environment-specific dismissals

Don't use one deployment's specs to dismiss resource, performance, or scaling concerns.
"On Lightsail with 4GB RAM and 772 notes, this is negligible" is not a valid dismissal
for an OSS project where users may have 10x the data on half the RAM. Evaluate against
the worst reasonable use case for the project's audience — not the maintainer's current
setup. And if the fix is trivial, fix it regardless of the impact assessment.

## Pre-merge delta review

Phases 1-5 review a snapshot, but the PR keeps moving after they finish — bot-response
fixes, scope growth, manual cleanups. On real PRs the majority of commits can land
after Phase 5 (observed: 11 of 19 commits over the 22 hours after the phases ran,
including a monitoring-cycle fix that introduced a real bug only an external bot
caught). Post-phase commits that no phase ever sees are the largest source of shipped
misses. This section closes that hole. Comment mode skips it (Phase 6 doesn't run and
the pipeline pushes nothing).

1. **Record the reviewed SHA.** When Phase 5 completes (including its triage fixes),
   note the branch head SHA — the high-water mark of what the phases have seen.
2. **Check the delta before every merge-ready verdict.** In Phase 6, before declaring
   merge-ready (and again before re-declaring it on later passes), run
   `git diff <reviewed-sha>..HEAD --stat`. An empty or trivial delta (typo-level docs
   edits, lockfile churn) needs no action — state that the delta was checked and its
   commit range.
3. **Dispatch a delta review when the delta is substantive** — any new or changed
   logic, API shape, config/CI behavior, or restructured docs. Scope the dispatch to
   the delta diff only, naming the commits under review: dispatch
   `ship-check:bug-checker` when the delta contains logic changes,
   `ship-check:code-quality-reviewer` when it contains style/docs-weight changes, both
   when mixed. Findings follow the normal fix/flag rules and inter-phase triage.
   Model selection follows the same table as phases 1-5 (see Execution above).
4. **Fixes written during monitoring are never exempt.** Code the orchestrator or
   pr-monitor itself authors in the bot-response cycle is unreviewed content like any
   other — it enters the next delta. Do not reason "the pipeline wrote it, so it's
   reviewed"; a monitoring-cycle fix has replaced byte-exact truncation with
   character-count truncation on a confidently wrong invariant claim, and no phase
   ever saw it.
5. **Advance the reviewed SHA** once a delta review (and its fixes) completes, then
   repeat step 2 on subsequent passes. Deltas shrink, so this converges.
6. **Re-review tool text before every merge-ready verdict**, after steps 3-5 and
   their fixes: run the re-review in "Tool-definition review (conditional)". Run it
   even when step 2 of this section found the delta trivial — the re-review's own
   gates decide whether tool text changed. It tracks its own tool-review commit (the
   head the last tool-definition review saw, recorded by that section's step 9),
   separate from the reviewed SHA.

## Execution

The dispatch templates below omit model selection. Resolve it once, then reuse it for
every agent-mode phase:

| Runtime | No `--model` | Explicit `--model` | `--model inherit` |
|---|---|---|---|
| Claude | pass `opus` | pass the supported Claude selector | omit the override; the child inherits |
| Codex | pass `gpt-5.6-terra` | pass the exact supported `gpt-*` ID | resolve the parent's exact model and reasoning effort, then pass both explicitly |
| OpenCode | use its configured default | pass the runtime-supported selector or provider/model ID | use its inherited-model mechanism |

For Codex `inherit`, match the root's `CODEX_THREAD_ID` to one rollout's
`session_meta.payload.id`. Read the model from
`session_meta.payload.base_instructions.provenance.model`, then read the reasoning
effort from the latest `turn_context.payload.effort` in that same rollout at or before
the phase dispatch. Never select a rollout by recency, cwd, or display name. Stop before
dispatch if the matching rollout, model, or applicable effort is missing.

`--inline` needs no child model selection. `--fork` inherits the session model and
ignores model overrides; a Codex fork prompt still carries the root's verified
`Attribution model ID`.

The dispatch templates below also omit the `Ship-Check` commit trailer instruction.
Append it to every phase that commits (phases 1, 3-5):

For Codex agent mode, also prepend the populated attribution line described above.

```
When committing, add this trailer to every commit message:
Ship-Check: PHASE_NAME · YOUR_MODEL_ID
Use the runtime-specific model label from the Attribution section for YOUR_MODEL_ID.
```

### Phase 1: PR Review

Dispatch the `pr-reviewer` agent type from the ship-check plugin:

```
Agent({
  subagent_type: "ship-check:pr-reviewer",
  description: "PR review — correctness, security, conditional checks",
  prompt: "Review the PR on branch <branch> (PR #<number>) against main. This is Phase 1 of the ship-check pipeline — focus on dimensions 1 (correctness), 4 (security/performance), and conditional dimensions 5-7 (the tool-definition handoff, feature surface docs, stale path references). Skip dimensions 2 (conventions) and 3 (test quality) — dedicated agents handle those next. Fix all high/medium confidence findings directly. For low-confidence findings: fix if the change is trivial and safe (< 5 lines, no interface change); only flag when the fix itself is uncertain, risky, or needs a design decision. When flagging, categorize as: 'uncertain diagnosis', 'complex fix', or 'needs design decision'. Commit and push."
})
```

Wait for the agent to complete. Read its findings. **Run inter-phase triage** on any
flagged findings (see procedure above) before launching Phase 2. Then compose the
Phase 2 dispatch prompt — append a one-line prior-phase context summarizing what
Phase 1 fixed (or commented on, in comment mode) and what remains deferred.

### Phase 2: Fresh Eyes (report only)

Dispatch the `fresh-eyes` agent type. Fresh-eyes receives the changed non-test file
list and reads each file whole — it does not see the diff. It reports pauses per
function but edits nothing. No inter-phase triage is needed because there are no fixes
or flags; the output feeds directly into Phase 3.

**Choose the persona.** Fresh-eyes reads as a specific person (its skill's Persona
section); the reader should be whoever the changed files will actually face.
`--persona` wins when given. Otherwise choose from the diff's content:

| Changed content | Persona |
|---|---|
| Code, contributor-facing docs (the usual case) | Omit the `Persona:` line from the dispatch — the skill's default (an experienced developer, new to this codebase) |
| User-facing docs — README, setup or usage guides, user-visible error text | The doc's audience, named concretely: "a prospective user evaluating whether to install this", "a non-technical user following the setup guide" |
| Public API surface — tool descriptions, CLI help, published types | "a developer integrating against this, reading only what ships" |

When the diff mixes code with substantial user-facing docs, dispatch fresh-eyes twice
— the default read over the code files, an audience-persona read over the docs —
rather than averaging one persona over both. A persona varies the reader's background
knowledge only: it cannot grant codebase familiarity or turn the read into another
review type.

Build the file list from the diff, excluding test files:

```bash
git diff --name-only main...HEAD | grep -v '__tests__\|\.test\.\|\.spec\.'
```

```
Agent({
  subagent_type: "ship-check:fresh-eyes",
  description: "Fresh eyes — stranger read, report only",
  prompt: "Read the following files at HEAD on branch <branch> (PR #<number>) as a reader who has never seen this codebase. Report every place you pause — a name you had to trace, a loop with no stated reason, a comparison you had to reason about, a term never introduced. Report only; do not edit anything.\n<if a persona was chosen, append:>\nPersona: <the chosen reader>\n\nFiles:\n<file list, one per line>"
})
```

Wait for the agent to complete. Read its pause report. No triage — pauses are not
fixes. Extract the per-function pause list and carry it into the Phase 3 dispatch,
labeled with the persona when one was set, so code-quality reads each pause against
the reader who felt it.

### Phase 3: Code Quality

Dispatch the `code-quality-reviewer` agent type. When Phase 2 produced pauses, append
them to the dispatch prompt so code-quality resolves each one as a fix or a named
dismissal.

```
Agent({
  subagent_type: "ship-check:code-quality-reviewer",
  description: "Code quality — conventions, readability",
  prompt: "Run a code quality pass on branch <branch> (PR #<number>) against main. Review all changed files (source, CI/CD, IaC, config — everything except test files) for naming, structure, comments, simplicity, and module conventions; changed markdown docs get the docs & comment concision dimension. Fix every finding, commit, and push. Prior-phase context: <summarize what Phase 1 fixed and any deferred findings>.\n\n<if Phase 2 produced pauses, append:>\nStranger pauses from the fresh-eyes pass (Phase 2<if a persona was set:>, read as <persona>). Each pause is a readability problem that reader hit — fix it or dismiss it on the trigger's boundary only. 'Pre-existing' is not a dismissal; 'matches local style' is not a boundary. A pause with no matching trigger is still a finding. If your dismissals outnumber your fixes, re-examine each with sequential thinking before reporting. List every disposition in your report:\n<paste the per-function pause list>"
})
```

Wait for the agent to complete. Read its findings. **Run inter-phase triage** on any
flagged findings. Then compose the Phase 4 dispatch prompt with prior-phase context.

### Phase 4: Test Audit

Dispatch the `test-auditor` agent type:

```
Agent({
  subagent_type: "ship-check:test-auditor",
  description: "Test audit — quality + coverage gaps",
  prompt: "Audit tests on branch <branch> (PR #<number>) against main. Audit all changed test files against convention dimensions AND run coverage gap analysis on changed non-test files. Write missing tests for coverage gaps. Fix test quality issues. Commit and push. Prior-phase context: <summarize what Phases 1-3 fixed and any deferred findings>."
})
```

Wait for the agent to complete. Read its findings. **Run inter-phase triage** on any
flagged findings. Then compose the Phase 5 dispatch prompt with prior-phase context.

### Phase 5: Bug Check

Dispatch the `bug-checker` agent type:

```
Agent({
  subagent_type: "ship-check:bug-checker",
  description: "Bug check — 7-dimension systematic hunt",
  prompt: "Run a systematic bug check on branch <branch> (PR #<number>) against main. Read every changed file in full (source, CI/CD, IaC, config — all non-test files). Apply all 7 dimensions — especially dimension 1 (description-vs-implementation, quote verbatim). Fix high-confidence bugs directly. For medium/low-confidence findings: fix if the change is trivial and safe (< 5 lines, no interface change); only flag when the fix itself is uncertain, risky, or needs a design decision. When flagging, categorize as: 'uncertain diagnosis', 'complex fix', or 'needs design decision'. Commit and push. Prior-phase context: <summarize what Phases 1, 3-4 fixed and any deferred findings>."
})
```

Wait for the agent to complete. Read its findings. **Run inter-phase triage** on any
flagged findings.

### Tool-definition review (conditional)

Run this after Phase 5 and its triage: Phase 3 and Phase 5 rewrite tool text, and
this review must read the text they leave. It dispatches
`ship-check:tool-definition-reviewer` (report only) for each MCP tool whose
definition changed in a **tool-list file**: the JSON a server's `tools/list`
returns, committed to the repository (for example, the vault-cortex MCP server
commits one such file for each of its server configurations under
`__snapshots__/tool-surface/`). It is not a numbered phase. It runs only when
the gates in step 2 pass, and only `--skip tool-definitions` or an `--only` list
without `tool-definitions` turns it off.

1. **Resolve the base.** In PR mode, fetch the base branch and take the merge base;
   in local mode, use the base of the review range. Call the result MERGE_BASE and
   the head commit HEAD_SHA. Write both as full commit SHAs (`git rev-parse <ref>`),
   never as a symbolic ref such as `main~1`, because step 9 records them for a later
   re-review.
   ```
   git fetch origin <base-branch>
   git merge-base origin/<base-branch> HEAD
   git rev-parse HEAD
   ```
2. **Gates (git only).** The gates run before the plan script, so a runtime without
   Bun fails the step only when a tool list changed. List the changed JSON files,
   then check both ends for a tool list. Run them at the repository root: inside a
   subfolder, git lists only that folder's changes. Each `git grep` is ONE command
   carrying every listed path:
   ```
   git diff --name-only MERGE_BASE HEAD_SHA -- '*.json'
   git grep -l '"inputSchema"' HEAD_SHA -- <every listed path>
   git grep -l '"inputSchema"' MERGE_BASE -- <every listed path>
   ```
   - No JSON file changed → the step is `not dispatched: no JSON file changed`.
   - Neither `git grep` lists a file → `not dispatched: no tool-list file changed`.
     One listed file at either end passes the gate. `git grep` exits 1 when it finds
     nothing, and a path missing at one end finds nothing; neither is an error.
   - Either of these two `not dispatched` outcomes, when Phase 1 reported tool
     definitions changed in source → tell the user the on-demand route: capture the
     server's `tools/list` to a file and dispatch the reviewer on demand.
3. **Plan the dispatches.** Run the plan script yourself, never through the
   reviewer: the script writes files under `--out`, and the reviewer may run without
   write access. Make a fresh parent folder, then pass a child that does not exist
   yet:
   ```
   mktemp -d <scratchpad>/probe-tool-definitions-XXXX
   bun <script> --plan --repo <repository root> --from MERGE_BASE --to HEAD_SHA --out <parent>/plan
   ```
   - `<scratchpad>` is the session scratchpad; with none, use `/tmp`.
   - `<parent>` is the folder `mktemp` prints.
   - `<script>` is `tool-definition-review/scripts/surface-diff.ts` in the folder
     that holds this skill's folder: `${CLAUDE_SKILL_DIR}/../tool-definition-review/scripts/surface-diff.ts`
     in Claude Code. When `${CLAUDE_SKILL_DIR}` appears above as literal text, use
     the skills folder this `SKILL.md` was read from, such as `~/.agents/skills/`.
     Resolve the path to an absolute one and write it unquoted, so a permission rule
     written for that path matches.
   - The step **fails** when the script exits non-zero (its reason is on standard
     error), Bun is missing, or the parent folder cannot be created.
4. **Read the plan.** The script prints JSON. The fields this step uses are
   `records`, `files` (each with `current`, `base`, `reviewOnly`, `withRoot`,
   `coldDispatch`, `batches`, `alsoChangedOnBaseBranch`), `filesWithNoToolChange`,
   `broken`, `removed`, `removedTools`, `addedThenDropped`, and `notToolLists`.
   - `records` is 0 → `not dispatched`, with one reason for each non-empty list:

     | Non-empty list | Reason |
     |---|---|
     | `filesWithNoToolChange` | no tool needs review: only instructions, prompts, or key order changed; a new file ships only definitions another changed file already has; or, in a re-review, no tool text changed since the last review except edits from the base branch |
     | `removed` or `removedTools` | only tools were removed |
     | `addedThenDropped` | the branch added tools and dropped them again |
     | `broken` | a tool-list file no longer parses as one |
     | `notToolLists` | the changed JSON files are not tool lists (name the paths) |

   - A changed file that appears in none of these lists holds only records that
     another file in `files` already carries, so it gets no dispatch of its own. In
     a re-review, a file the base branch deleted and this branch never touched is
     also in no list.
   - Each `broken` or `removed` file goes to the user as a finding before the verdict.
   - List every `removedTools` and `addedThenDropped` entry in the summary. A removed
     tool whose name the PR title or body does not mention goes to the user as a
     finding.
5. **Intended tools.** Collect every name in the plan's `reviewOnly` lists that
   appears as a whole word in the PR title or body
   (`gh pr view <number> -R OWNER_REPO --json title,body`, where OWNER_REPO is the
   repo identifier from "Orchestrator setup", resolved the same way in every mode);
   in local mode, in the subjects and bodies of the range's commit messages. A
   whole word means `vault_search` does not match inside `vault_search_by_tag`.
   None → `not stated`. Never pass the PR description itself.
6. **Dispatch.** For each entry in `files`:
   - `coldDispatch` false → one dispatch for the file's single batch, doing both
     reads.
   - `coldDispatch` true → one `Pass: cold` dispatch carrying only the current file
     and every name in `reviewOnly`, plus one `Pass: diff` dispatch per batch.
   - `withRoot` true → include the `Repository root:` line. `withRoot` false → omit
     it: those tools repeat an edit another file's dispatch traces, so the reviewer
     skips the error-entry and project-conventions checks for them and can still
     report `complete`.
   - Number the report files with one counter across the whole step:
     `report-1.md`, `report-2.md`, … in the parent folder. The `batch <n>` in each
     description counts within its file.
   - In local mode, replace `branch <branch> (PR #<number>)` in the prompt the way
     "Dispatch prompt changes" under Local review mode says: `commits <short-sha>..<short-sha>`.

   The two parenthesized `(only when …)` notes in this template are instructions
   to you, not prompt text: keep the line, without the note, when its condition
   holds, and drop the whole line otherwise.

   ```
   Agent({
     subagent_type: "ship-check:tool-definition-reviewer",
     description: "Tool definitions — <file name>, batch <n>",
     prompt: "Review the MCP tool definitions changed on branch <branch> (PR #<number>).\nCurrent surface: <current>\nBase surface: <base, or: none>\nIntended tools: <names, or: not stated>\nRepository root: <repository root>   (only when withRoot is true)\nReview only: <the batch's names>\nPass: diff   (only when coldDispatch is true)\nReport file: <parent>/report-<n>.md\nReturn the Defects list, the Unintended text changes list, and the Unfinished entries and Status lines."
   })
   ```

   The cold dispatch carries only these four lines:

   ```
   Agent({
     subagent_type: "ship-check:tool-definition-reviewer",
     description: "Tool definitions — <file name>, cold read",
     prompt: "Current surface: <current>\nReview only: <every name in reviewOnly>\nPass: cold\nReport file: <parent>/report-<n>.md"
   })
   ```

   - Send every dispatch in one message. They write nothing but their reports, so
     they run in parallel.
   - **Codex:** spawn `agent_type: "ship-check:tool-definition-reviewer"` with the
     model from the Execution table. Codex has no operation to close an agent, so a
     spawn refused with "agent thread limit reached" waits on `wait_agent` for one of
     this step's own dispatches, then retries. When none of this step's dispatches
     is running, the refusal fails the step.
   - **OpenCode:** the subagent is `ship-check--tool-definition-reviewer`.
   - The runtime has no reviewer agent → `not dispatched: no reviewer agent in this
     runtime`; the verdict rule below applies.
   - A dispatch that errors (an API error, a timeout) is retried once. A second
     error fails the step.
   - A reviewer that cannot write its report file returns the report inline, under
     a `Report file not written:` line. Save it to the named path yourself.
7. **Unfinished entries.** A report whose `Unfinished entries:` count is above 0
   names its unfinished tools on that line. For each such report, send ONE
   continuation dispatch: the same file and inputs as that report's dispatch,
   `Pass:` line included, with `Review only:` set to its unfinished names. A diff
   dispatch held at most eight names, so its continuation stays within the cap.
   Names still unfinished after the continuation make the step `partial`; never
   send a second continuation.
8. **Triage the findings.** The reviewer reports without flag categories, so assign
   them yourself and run inter-phase triage on each report's Defects:
   - A description-text edit is not an interface change. An input-schema edit (a
     type, `required`, `enum`, or a parameter name) is an interface change, so it
     goes to the user.
   - An unintended text change ALWAYS goes to the user, never to a fix. Only the
     author knows whether it was meant.
   - Count unintended changes once per tool and change. A report's Unintended text
     changes list covers every changed tool in its file, not only its `Review only:`
     names, so one change appears in every report on that file.
   - A tool listed in `alsoChangedOnBaseBranch` was changed on the base branch too:
     say so with any finding on it, since its diff can hold the base branch's edit.
   - Fixes follow the mode's rule in the table below. The re-review covers them.
9. **Record the tool-review commit.** Write HEAD_SHA and MERGE_BASE into the step's
   `Tool Definitions:` summary line (see Reporting; its "N reviews" is the plan's
   `records`) on every outcome: not dispatched (including `records` 0), complete,
   or partial or failed once the user accepted the missing coverage. A partial or
   failed step the user has not accepted keeps the previous tool-review commit, so
   its tools are reviewed again next time.

#### The re-review

Run it whenever the step runs again in this session on the same branch: before
every merge-ready verdict (see "Pre-merge delta review"), and on any later
`/ship-check`. From the step's last summary line, take the tool-review commit as
TOOL_REVIEW_SHA and its merge base as OLD_MERGE_BASE.

1. Recompute MERGE_BASE and HEAD_SHA as in step 1.
2. Run step 2's gates over the branch's edits since the last review:
   ```
   git diff --name-only TOOL_REVIEW_SHA HEAD_SHA -- '*.json'
   git grep -l '"inputSchema"' HEAD_SHA -- <every listed path>
   git grep -l '"inputSchema"' TOOL_REVIEW_SHA -- <every listed path>
   ```
   When MERGE_BASE differs from OLD_MERGE_BASE, run them again over the base
   branch's edits between the two merge bases:
   ```
   git diff --name-only OLD_MERGE_BASE MERGE_BASE -- '*.json'
   git grep -l '"inputSchema"' MERGE_BASE -- <every listed path>
   git grep -l '"inputSchema"' OLD_MERGE_BASE -- <every listed path>
   ```
   Either run passing passes.
3. Plan with `--since`, in a fresh parent folder:
   ```
   bun <script> --plan --repo <repository root> --from MERGE_BASE --to HEAD_SHA --since TOOL_REVIEW_SHA --since-from OLD_MERGE_BASE --out <new parent>/plan
   ```
4. Read the plan, collect the intended tools, dispatch, and send continuations as
   in steps 4-7. A non-null `base` is a composed file holding only this branch's
   edits since the review, so a dropped fact is one dropped since then. A `base` of
   null marks a file that was not a tool list at the review; its tools are reviewed
   with no base.
5. Triage as in step 8, except that every re-review finding goes to the user.
   NEVER fix a re-review finding through triage: each round rereads whole tools and
   can raise new small defects, and fixing them would start the loop again. The
   user's earlier decisions stand for text that did not change.
6. Record the new tool-review commit as in step 9.

- No recorded tool-review commit, or one git cannot find (the gate's `git diff`
  reports a bad object, or the script exits 2 with "not a commit") → run the step in
  full and say so in the summary.
- In "Pre-merge delta review" step 2, a delta that changes tool text is never
  trivial.

#### By mode

| Mode | When it runs | What happens to findings |
|---|---|---|
| Default | After Phase 5; re-review before each merge-ready verdict | First review: triage, fixes committed and pushed. Re-review: to the user |
| `--comment` | After Phase 5; no re-review (Phase 6 is skipped) | One PR-level comment holding each report's Defects and Unintended text changes, posted under "Non-inline findings still land on the PR" with component `tool-definitions`; nothing edited |
| `--report` | After Phase 5; re-review whenever a merge-ready verdict is checked or ship-check runs again in the session | To the user only; `--report` wins over every other mode's fixing rule |
| `--local`, `--diff` on a branch | On the range; then, when triage committed a tool-text fix, one re-review before the summary | First review: triage, fixes committed. Re-review: to the user |
| `--local` on `main` or a detached head | On the range | To the user only, under the local-on-`main` rule |
| `--inline`, `--fork` | Invoke the `tool-definition-review` skill in this context or a fork with the same inputs, file by file, at most eight tools per diff pass | As in default; the status can be `complete` and is labelled "not cold", because the cold read ran with this session's context instead of a stranger's |
| `--skip tool-definitions` | Never, and no re-review | Summary: `skipped` |
| `--only` including `tool-definitions` | After the other selected phases | As in default |
| `--only` without `tool-definitions` | Never | Summary: `not selected` |
| `--model` | The Execution table's model choice | — |

#### Verdict

Withhold the merge-ready verdict (in comment and local modes, the `ship` verdict)
until the user accepts the missing coverage in words when the step:

- failed: the script exited non-zero, Bun is missing, the parent folder could not
  be created, a dispatch failed after its retry, or a spawn was refused while none
  of this step's dispatches was running;
- stayed `partial` after its continuation; or
- could not be dispatched because the runtime has no reviewer agent.

Deferred findings already hold the verdict: Reporting says to put them to the user
for a decision before any verdict.

### Phase 6: PR Monitor (inline — does not end)

**Skip this phase entirely in comment mode.** The pipeline is reviewing a PR it isn't
responsible for — there are no pushed fixes to monitor, no bot comments to resolve, and
no CI to watch. After Phase 5 and the tool-definition review complete, output the
summary report and stop.

Run /pr-monitor inline (not as an agent). This phase stays inline because timed
follow-up and human comment decisions need the primary agent.

Carry the orchestrator's verified attribution model ID into pr-monitor. A standalone
pr-monitor run resolves the current session's exact model under the Attribution rules.

**Phase 6 does not end.** Phases 1-5 are "complete and move on" steps. Phase 6 is a
continuous monitoring loop that outlives the pipeline. The pipeline "completes" when
Phases 1-5 and the tool-definition review are done, but Phase 6 runs until the user
says stop or the PR merges or closes.

**Invoke the pr-monitor skill** (call the Skill tool with `skill: "pr-monitor"`) and
follow ALL steps through Step 5, including:
- **Step 3**: Reply to every bot comment BEFORE resolving the thread, and report each
  fix's sweep receipt in the run output — a fix that wasn't swept repo-wide comes back
  as a review bot comment on the next pass
- **Step 4**: Follow-up check after pushing fixes is mandatory. In Claude Code,
  call `ScheduleWakeup(delaySeconds: 180, reason: "waiting for bot reviews after
  push", prompt: "/pr-monitor")`. In Codex, stay in the active turn and use
  `clock.sleep({ duration_ms: 50000 })` in repeated intervals until at least
  180 seconds have elapsed, then re-run the full status pass. Do NOT reason
  about why monitoring can be skipped or end a Codex turn while it is active.
- **Step 5**: Continue monitoring — never auto-terminate

As part of this phase, the primary agent also ensures PR visibility for non-inline
findings: any deferred finding or beyond-diff issue not already visible on the PR
(inline comment or review body) gets a PR-level comment (`gh pr comment`) so the
decision trail lives on the PR, not only in the chat transcript. Post it under the
plain-command rule in "Non-inline findings still land on the PR": no `$(…)` in the
body, and `gh pr comment NUMBER --body-file /absolute/path/comment.md` when the
body mentions `git` or the sandbox refuses the call once. Put that file in your
scratchpad directory, or in `/tmp/probe-pr-NUMBER/` when the runtime has no
scratchpad.

Phase 6 also owns the **pre-merge delta review** (see the section above): before any
merge-ready verdict, diff the current head against the last phase-reviewed SHA and
dispatch a delta review if the difference is substantive, then run the
tool-definition re-review (delta review step 6).

## Reporting

### Default mode

Output the summary below as a **status snapshot** during Phase 6 monitoring — not as a
pipeline conclusion. Update it on each monitoring pass as PR status evolves.

```
Ship check complete:
- Reviewed at:  <last phase-reviewed SHA; delta since then checked in Phase 6>
- PR Review:    N findings, M fixed (correctness, security, conditional)
- Fresh Eyes:   N functions read, M pauses — K fixed by code-quality, J dismissed <when a persona was set: (read as <persona>)>
- Code Quality: N findings, M fixed (conventions, readability)
- Test Audit:   N findings, M fixed (test quality); K coverage gaps, J tests written
- Bug Check:    N findings, M fixed (by dimension)
- Tool Definitions: <complete | partial | failed | not dispatched: reason | skipped | not selected> — N reviews in M files at <HEAD_SHA, full> (merge base <MERGE_BASE, full>), K defects, J unintended changes <"not cold" for --inline/--fork; "re-review since <SHA>" for a re-review>
- Triage:       N flagged findings triaged across all phases — M fixed, K deferred (L pre-existing gaps)
- PR Monitor:   CI status, N bot comments resolved
- Deferred:     <list each with flag category, or "none">
- Dismissed:    N across phases — includes fresh-eyes pauses code-quality dismissed and proof-of-dismissal lines from each phase (or "none")
- Verdict:      ship / ship-with-minor-fixes / needs-changes
```

If any findings remain deferred at the end of Phases 1-5 and the tool-definition
review, present them to the user with their flag category and ask for a decision
before declaring the verdict.

After outputting this report, **continue the Phase 6 monitoring loop** — the report is a
status update, not a termination signal.

### Comment mode

Output the final summary after Phase 5 and the tool-definition review complete — this
is the pipeline conclusion.

```
Ship check complete (comment mode):
- Reviewed at:  <PR head SHA at Phase 5 completion — or per-phase SHAs when the head moved mid-pipeline (each phase reports its own)>
- PR Review:    N findings commented (correctness, security, conditional)
- Fresh Eyes:   N functions read, M pauses — K fixed by code-quality, J dismissed <when a persona was set: (read as <persona>)>
- Code Quality: N findings commented (conventions, readability)
- Test Audit:   N findings commented (test quality); K coverage gaps reported
- Bug Check:    N findings commented (by dimension)
- Tool Definitions: <complete | partial | failed | not dispatched: reason | skipped | not selected> — N reviews in M files at <HEAD_SHA, full> (merge base <MERGE_BASE, full>), K defects, J unintended changes, posted as one PR comment
- Triage:       N flagged findings triaged across all phases — M commented, K deferred
- PR Monitor:   skipped (comment mode)
- Deferred:     <list each with flag category, or "none">
- Dismissed:    N across phases — includes fresh-eyes pauses code-quality dismissed and proof-of-dismissal lines from each phase (or "none")
- Verdict:      ship / ship-with-minor-fixes / needs-changes
- Reviews posted: N (one per phase with findings)
```

Present deferred findings to the user with their flag category. The pipeline ends here
— no Phase 6 monitoring loop.

## Options

The user can customize the pipeline:

- `/ship-check --skip code-quality` — skip a phase
- `/ship-check --skip fresh-eyes` — code-quality runs on its own dimension 0 only
- `/ship-check --only pr-review,test-audit` — run specific phases
- `/ship-check --only fresh-eyes` — standalone stranger read, report to user
- `/ship-check --skip tool-definitions` — skip the tool-definition review and its
  re-review (see "Tool-definition review (conditional)" → By mode)
- `/ship-check --only tool-definitions` — run only the tool-definition review; it
  still dispatches nothing when no tool-list file changed
- `/ship-check --report` — report only, don't apply fixes or post PR comments (findings
  reported to the orchestrator). Alias: `--no-fix`.
- `/ship-check --local` — run without a PR. Reviews the commit range on the current
  branch (see Local review mode). Implies `--report` when on main.
- `/ship-check --diff <base>` — set the review range explicitly (e.g. `--diff HEAD~3`,
  `--diff abc1234`). Implies `--local`.
- `/ship-check --comment` — post findings as inline PR review comments instead of fixing.
  Implies --no-fix. Phase 6 (pr-monitor) is skipped — the pipeline is reviewing a PR it
  isn't responsible for. Composable with --skip, --only, --inline, --fork.
- `/ship-check --persona "<reader>"` — set who fresh-eyes reads as, overriding the
  orchestrator's content-based choice (see Phase 2). Only affects fresh-eyes; a
  persona cannot grant codebase familiarity or change the read into another review
  type. No-op when fresh-eyes doesn't run.
- `/ship-check --model <name>` — override the model for all phase agents for this run.
  Use a selector the active runtime accepts: Claude aliases such as `opus`, exact Codex
  IDs such as `gpt-5.6-luna`, or an OpenCode-supported selector/provider ID. `inherit`
  follows the session model through the runtime-specific procedure in Execution.
  Ignored with `--inline` and `--fork` — both run on the session model, though Codex
  fork prompts still receive the root's verified attribution ID.
- `/ship-check --inline` — run all phases in the current context (no agents, no fresh
  eyes — useful when context from prior work is actually helpful). Fresh-eyes is skipped
  because inherited context defeats the no-prior-knowledge persona.
- `/ship-check --fork` — use forks instead of agents (legacy behavior — spawns forks
  that call Skill to load each review skill). Fresh-eyes is skipped because forks
  inherit context.

Fresh-eyes option interactions:

| Option | Fresh-eyes behavior |
|--------|-------------------|
| default, `--comment` | Runs before code-quality; pauses flow into code-quality |
| `--persona "<reader>"` | Reads as that persona instead of the orchestrator's content-based choice |
| `--skip fresh-eyes` | Skipped; code-quality uses its own dimension 0 only |
| `--skip code-quality` | Still runs; pauses go to the user in the summary |
| `--only fresh-eyes` | Standalone report to the user |
| `--only` set excluding fresh-eyes | Not dispatched |
| `--inline`, `--fork` | Skipped (inherited context defeats the persona); noted in the summary |

If the user doesn't specify options, run all six phases with agents, plus the
tool-definition review when its gates pass (the default).
