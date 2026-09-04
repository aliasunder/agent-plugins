---
name: ship-check
description: >
  Run the full post-implementation review pipeline: pr-review -> code-quality ->
  test-audit -> bug-check -> pr-monitor. Phases 1-4 run as dedicated agent types
  (ship-check plugin) with skills preloaded — genuine fresh eyes with no inherited
  context. Phase 5 (pr-monitor) runs inline for user interaction.
  Use when asked to "ship check", "review pipeline", "full review", "run all
  reviews", or after implementation is complete and ready for review.
  NOT for: single-dimension review (use the individual skill), quick CI check
  (use pr-monitor), or post-merge testing (use verify).
---

# Ship Check

Orchestrate the full review pipeline. Phases 1-4 dispatch **dedicated agent types**
from the ship-check plugin (not forks) so each reviewer approaches the code as a
genuine stranger — no inherited context, no authorship bias. Each agent has its review
skill and fable-mode preloaded via the `skills:` frontmatter, and loads project
conventions (CLAUDE.md, AGENTS.md, CLAUDE.local.md) and vault memory independently.

## Pipeline

```
Phase 1: ship-check:pr-reviewer          -> correctness, security, conditional checks
Phase 2: ship-check:code-quality-reviewer -> convention compliance, readability
Phase 3: ship-check:test-auditor          -> test design, assertion quality, coverage gaps
Phase 4: ship-check:bug-checker           -> description-vs-code, SQL, type coercion, boundary
Phase 5: pr-monitor (inline)              -> CI status, bot comment resolution, loop until ready
```

## Attribution

Every piece of text the pipeline posts to a PR — inline review comments, review
bodies, PR-level comments, thread replies — MUST include the attribution footer.
This applies in ALL modes (default and comment), to ALL participants (phase agents,
orchestrator triage, pr-monitor replies).

**Footer format**: `\n\n---\n*🔍 ship-check · <component> · <model-id>*`

- `<component>` is the phase or role: `pr-review`, `code-quality`, `test-audit`,
  `bug-check`, `pr-monitor`, or `triage` (for orchestrator inter-phase triage posts).
- `<model-id>` is the poster's own model ID, read from the system prompt ("You are
  powered by the model named..."). Agents self-identify — the orchestrator does not
  look up or pass model IDs for them.
- **The orchestrator's own PR-level comments** (non-inline findings, deferred items
  posted via `gh pr comment`) use the orchestrator's own model ID with component
  `triage` or `ship-check`.

A comment posted without a footer is indistinguishable from the repo owner's manual
comments and misattributes automated output to a human. Every `gh api` and
`gh pr comment` call in the pipeline includes the footer — no exceptions.

## Before starting

1. Confirm a PR exists for the current branch (or that changes are committed and pushed).
   If not, ask the user whether to commit/push first.
2. Identify the base branch (usually `main`).
3. Get the PR number and branch name — agents need this context in their briefing.

## Comment mode (`--comment`)

When `--comment` is active, the entire pipeline switches from fix-and-push to
review-and-comment. Each phase posts findings as inline PR review comments via `gh api`
instead of editing files. Phase 5 (pr-monitor) is skipped entirely — the pipeline is
reviewing a PR it isn't responsible for.

### Behavior changes

| Aspect | Default mode | Comment mode |
|--------|-------------|--------------|
| Findings | Edit files, commit, push | Post as inline PR review comments |
| Phase 5 | Runs (monitoring loop) | Skipped |
| Phase sequencing | Sequential (each sees prior fixes) | Sequential (each sees prior findings to avoid duplicates) |
| Test-audit | Writes missing tests | Reports coverage gaps as comments |
| Inter-phase triage | Evaluates flagged findings, may fix | Evaluates flagged findings, may post additional comments |

### Dispatch prompt addition

When `--comment` is active, prepend this to every phase's dispatch prompt:

```
COMMENT MODE: Do NOT edit any files, commit, or push. Instead, collect all findings
and post them as a single GitHub PR review with inline comments. Follow the "Comment
mode" section in your preloaded skill for the gh api template. Only post a review if
you have findings — skip the API call for 0 findings.
Repo: OWNER_REPO
Append a footer to the review body AND every inline comment body using your own
model ID (from your system prompt):
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
mode, verify and post as part of Phase 5 (pr-monitoring); in comment mode (Phase 5
skipped), verify after Phase 4 triage and post anything missing before the final
summary. Post via `gh pr comment` /
`POST /repos/{owner}/{repo}/issues/{n}/comments` — include the attribution footer
(see Attribution section above). A finding that exists only in agent output is
invisible to anyone reading the PR.

### Orchestrator setup

Before dispatching Phase 1, resolve the **repo identifier** for `gh api` calls:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

Pass it as `Repo: owner/repo` in the dispatch prompt. In comment mode, agents
include their own model ID in the footer (they know it from their system prompt) —
the orchestrator does not need to look it up or pass it.

## Phase discipline

1. **All 5 phases run by default.** The orchestrator NEVER skips, refuses, or
   short-circuits phases based on its own assessment of the PR's content. This
   includes PRs that only change CI/CD workflows (`.yml`), IaC, Dockerfiles,
   configuration, or documentation — **CI/CD and IaC are reviewable code**, not
   boilerplate to wave through. Each phase determines its own scope and exits
   cleanly when nothing is applicable; the orchestrator dispatches unconditionally.
   Only the user can skip phases — via `--skip` or `--only`.

2. **Each phase handles its own scope.** If a phase detects nothing in scope, it reports
   "0 files in scope" and exits cleanly. The orchestrator reports this result, not its
   own judgment. A "0 findings" result from a dispatched agent is a valid outcome —
   it is never a reason to have skipped the dispatch.

3. **Phases run sequentially.** Each phase reviews the code *after* the previous phase's
   fixes are committed and pushed. Never parallelize review phases.

4. **The orchestrator never parrots sub-agent labels.** When a phase returns flagged
   findings, evaluate each one independently using inter-phase triage (below). A
   sub-agent's "low-risk" or "low-confidence" label is input to your assessment, not
   a disposition you relay.

## Inter-phase triage

After each of Phases 1-4 completes, triage any flagged findings BEFORE launching the
next phase. This is mandatory when flagged findings exist — skip only when a phase
reports all findings fixed.

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

Phases 1-4 review a snapshot, but the PR keeps moving after they finish — bot-response
fixes, scope growth, manual cleanups. On real PRs the majority of commits can land
after Phase 4 (observed: 11 of 19 commits over the 22 hours after the phases ran,
including a monitoring-cycle fix that introduced a real bug only an external bot
caught). Post-phase commits that no phase ever sees are the largest source of shipped
misses. This section closes that hole. Comment mode skips it (Phase 5 doesn't run and
the pipeline pushes nothing).

1. **Record the reviewed SHA.** When Phase 4 completes (including its triage fixes),
   note the branch head SHA — the high-water mark of what the phases have seen.
2. **Check the delta before every merge-ready verdict.** In Phase 5, before declaring
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
4. **Fixes written during monitoring are never exempt.** Code the orchestrator or
   pr-monitor itself authors in the bot-response cycle is unreviewed content like any
   other — it enters the next delta. Do not reason "the pipeline wrote it, so it's
   reviewed"; a monitoring-cycle fix has replaced byte-exact truncation with
   character-count truncation on a confidently wrong invariant claim, and no phase
   ever saw it.
5. **Advance the reviewed SHA** once a delta review (and its fixes) completes, then
   repeat step 2 on subsequent passes. Deltas shrink, so this converges.

## Execution

### Phase 1: PR Review

Dispatch the `pr-reviewer` agent type from the ship-check plugin:

```
Agent({
  subagent_type: "ship-check:pr-reviewer",
  description: "PR review — correctness, security, conditional checks",
  prompt: "Review the PR on branch <branch> (PR #<number>) against main. This is Phase 1 of the ship-check pipeline — focus on dimensions 1 (correctness), 4 (security/performance), and conditional dimensions 5-7 (TDQS, feature surface docs, stale path references). Skip dimensions 2 (conventions) and 3 (test quality) — dedicated agents handle those next. Fix all high/medium confidence findings directly. For low-confidence findings: fix if the change is trivial and safe (< 5 lines, no interface change); only flag when the fix itself is uncertain, risky, or needs a design decision. When flagging, categorize as: 'uncertain diagnosis', 'complex fix', or 'needs design decision'. Commit and push."
})
```

Wait for the agent to complete. Read its findings. **Run inter-phase triage** on any
flagged findings (see procedure above) before launching Phase 2. Then compose the
Phase 2 dispatch prompt — append a one-line prior-phase context summarizing what
Phase 1 fixed (or commented on, in comment mode) and what remains deferred.

### Phase 2: Code Quality

Dispatch the `code-quality-reviewer` agent type:

```
Agent({
  subagent_type: "ship-check:code-quality-reviewer",
  description: "Code quality — conventions, readability",
  prompt: "Run a code quality pass on branch <branch> (PR #<number>) against main. Review all changed files (source, CI/CD, IaC, config — everything except test files) for naming, structure, comments, simplicity, and module conventions; changed markdown docs get the docs & comment concision dimension. Fix every finding, commit, and push. Prior-phase context: <summarize what Phase 1 fixed and any deferred findings>."
})
```

Wait for the agent to complete. Read its findings. **Run inter-phase triage** on any
flagged findings. Then compose the Phase 3 dispatch prompt with prior-phase context.

### Phase 3: Test Audit

Dispatch the `test-auditor` agent type:

```
Agent({
  subagent_type: "ship-check:test-auditor",
  description: "Test audit — quality + coverage gaps",
  prompt: "Audit tests on branch <branch> (PR #<number>) against main. Audit all changed test files against convention dimensions AND run coverage gap analysis on changed non-test files. Write missing tests for coverage gaps. Fix test quality issues. Commit and push. Prior-phase context: <summarize what Phases 1-2 fixed and any deferred findings>."
})
```

Wait for the agent to complete. Read its findings. **Run inter-phase triage** on any
flagged findings. Then compose the Phase 4 dispatch prompt with prior-phase context.

### Phase 4: Bug Check

Dispatch the `bug-checker` agent type:

```
Agent({
  subagent_type: "ship-check:bug-checker",
  description: "Bug check — 7-dimension systematic hunt",
  prompt: "Run a systematic bug check on branch <branch> (PR #<number>) against main. Read every changed file in full (source, CI/CD, IaC, config — all non-test files). Apply all 7 dimensions — especially dimension 1 (description-vs-implementation, quote verbatim). Fix high-confidence bugs directly. For medium/low-confidence findings: fix if the change is trivial and safe (< 5 lines, no interface change); only flag when the fix itself is uncertain, risky, or needs a design decision. When flagging, categorize as: 'uncertain diagnosis', 'complex fix', or 'needs design decision'. Commit and push. Prior-phase context: <summarize what Phases 1-3 fixed and any deferred findings>."
})
```

Wait for the agent to complete. Read its findings. **Run inter-phase triage** on any
flagged findings.

### Phase 5: PR Monitor (inline — does not end)

**Skip this phase entirely in comment mode.** The pipeline is reviewing a PR it isn't
responsible for — there are no pushed fixes to monitor, no bot comments to resolve, and
no CI to watch. After Phase 4 completes, output the summary report and stop.

Run /pr-monitor inline (not as an agent). This phase stays inline because it needs
ScheduleWakeup, user interaction for human comments, and continuous monitoring.

**Phase 5 does not end.** Phases 1-4 are "complete and move on" steps. Phase 5 is a
continuous monitoring loop that outlives the pipeline. The pipeline "completes" when
Phases 1-4 are done, but Phase 5 runs until the user says stop or the PR merges.

**Invoke the pr-monitor skill** (call the Skill tool with `skill: "pr-monitor"`) and
follow ALL steps through Step 5, including:
- **Step 3**: Reply to every bot comment BEFORE resolving the thread
- **Step 4**: Follow-up check after pushing fixes — **ScheduleWakeup is mandatory**.
  Do NOT reason about why monitoring can be skipped. If fixes were pushed, schedule the
  wakeup: `ScheduleWakeup(delaySeconds: 180, reason: "waiting for bot reviews after
  push", prompt: "/pr-monitor")`
- **Step 5**: Continue monitoring — never auto-terminate

As part of this phase, the primary agent also ensures PR visibility for non-inline
findings: any deferred finding or beyond-diff issue not already visible on the PR
(inline comment or review body) gets a PR-level comment (`gh pr comment`) so the
decision trail lives on the PR, not only in the chat transcript.

Phase 5 also owns the **pre-merge delta review** (see the section above): before any
merge-ready verdict, diff the current head against the last phase-reviewed SHA and
dispatch a delta review if the difference is substantive.

## Reporting

### Default mode

Output the summary below as a **status snapshot** during Phase 5 monitoring — not as a
pipeline conclusion. Update it on each monitoring pass as PR status evolves.

```
Ship check complete:
- Reviewed at:  <last phase-reviewed SHA; delta since then checked in Phase 5>
- PR Review:    N findings, M fixed (correctness, security, conditional)
- Code Quality: N findings, M fixed (conventions, readability)
- Test Audit:   N findings, M fixed (test quality); K coverage gaps, J tests written
- Bug Check:    N findings, M fixed (by dimension)
- Triage:       N flagged findings triaged across all phases — M fixed, K deferred (L pre-existing gaps)
- PR Monitor:   CI status, N bot comments resolved
- Deferred:     <list each with flag category, or "none">
- Dismissed:    N across phases (roll up the phases' proof-of-dismissal lines — or "none")
- Verdict:      ship / ship-with-minor-fixes / needs-changes
```

If any findings remain deferred at the end of Phases 1-4, present them to the user with
their flag category and ask for a decision before declaring the verdict.

After outputting this report, **continue the Phase 5 monitoring loop** — the report is a
status update, not a termination signal.

### Comment mode

Output the final summary after Phase 4 completes — this is the pipeline conclusion.

```
Ship check complete (comment mode):
- Reviewed at:  <PR head SHA the phases reviewed>
- PR Review:    N findings commented (correctness, security, conditional)
- Code Quality: N findings commented (conventions, readability)
- Test Audit:   N findings commented (test quality); K coverage gaps reported
- Bug Check:    N findings commented (by dimension)
- Triage:       N flagged findings triaged across all phases — M commented, K deferred
- PR Monitor:   skipped (comment mode)
- Deferred:     <list each with flag category, or "none">
- Dismissed:    N across phases (roll up the phases' proof-of-dismissal lines — or "none")
- Verdict:      ship / ship-with-minor-fixes / needs-changes
- Reviews posted: N (one per phase with findings)
```

Present deferred findings to the user with their flag category. The pipeline ends here
— no Phase 5 monitoring loop.

## Options

The user can customize the pipeline:

- `/ship-check --skip code-quality` — skip a phase
- `/ship-check --only pr-review,test-audit` — run specific phases
- `/ship-check --no-fix` — report only, don't apply fixes (findings in agent output only)
- `/ship-check --comment` — post findings as inline PR review comments instead of fixing.
  Implies --no-fix. Phase 5 (pr-monitor) is skipped — the pipeline is reviewing a PR it
  isn't responsible for. Composable with --skip, --only, --inline, --fork.
- `/ship-check --inline` — run all phases in the current context (no agents, no fresh
  eyes — useful when context from prior work is actually helpful)
- `/ship-check --fork` — use forks instead of agents (legacy behavior — spawns forks
  that call Skill to load each review skill)

If the user doesn't specify options, run all five phases with agents (the default).
