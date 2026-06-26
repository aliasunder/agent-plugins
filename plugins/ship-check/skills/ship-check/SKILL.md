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

## Before starting

1. Confirm a PR exists for the current branch (or that changes are committed and pushed).
   If not, ask the user whether to commit/push first.
2. Identify the base branch (usually `main`).
3. Get the PR number and branch name — agents need this context in their briefing.

## Phase discipline

1. **All 5 phases run by default.** The orchestrator never skips phases based on its own
   assessment of the PR's content. Only the user can skip phases — via `--skip` or `--only`.

2. **Each phase handles its own scope.** If a phase detects nothing in scope, it reports
   "0 files in scope" and exits cleanly. The orchestrator reports this result, not its
   own judgment.

3. **Phases run sequentially.** Each phase reviews the code *after* the previous phase's
   fixes are committed and pushed. Never parallelize review phases.

## Execution

### Phase 1: PR Review

Dispatch the `pr-reviewer` agent type from the ship-check plugin:

```
Agent({
  subagent_type: "ship-check:pr-reviewer",
  description: "PR review — correctness, security, conditional checks",
  prompt: "Review the PR on branch <branch> (PR #<number>) against main. This is Phase 1 of the ship-check pipeline — focus on dimensions 1 (correctness), 4 (security/performance), and conditional dimensions 5-7 (TDQS, feature surface docs, stale path references). Skip dimensions 2 (conventions) and 3 (test quality) — dedicated agents handle those next. Fix all high/medium confidence findings, commit, and push."
})
```

Wait for the agent to complete. Read its findings.

### Phase 2: Code Quality

Dispatch the `code-quality-reviewer` agent type:

```
Agent({
  subagent_type: "ship-check:code-quality-reviewer",
  description: "Code quality — conventions, readability",
  prompt: "Run a code quality pass on branch <branch> (PR #<number>) against main. Review all changed production files for naming, structure, comments, simplicity, and module conventions. Skip test files. Fix every finding, commit, and push."
})
```

Wait for the agent to complete. Read its findings.

### Phase 3: Test Audit

Dispatch the `test-auditor` agent type:

```
Agent({
  subagent_type: "ship-check:test-auditor",
  description: "Test audit — quality + coverage gaps",
  prompt: "Audit tests on branch <branch> (PR #<number>) against main. Audit all changed test files against convention dimensions AND run coverage gap analysis on changed production files. Write missing tests for coverage gaps. Fix test quality issues. Commit and push."
})
```

Wait for the agent to complete. Read its findings.

### Phase 4: Bug Check

Dispatch the `bug-checker` agent type:

```
Agent({
  subagent_type: "ship-check:bug-checker",
  description: "Bug check — 7-dimension systematic hunt",
  prompt: "Run a systematic bug check on branch <branch> (PR #<number>) against main. Read every changed production file in full. Apply all 7 dimensions — especially dimension 1 (description-vs-implementation, quote verbatim). Fix high-confidence bugs, flag medium/low. Commit and push."
})
```

Wait for the agent to complete. Read its findings.

### Phase 5: PR Monitor (inline)

Run /pr-monitor inline (not as an agent). This phase stays inline because it needs
ScheduleWakeup, user interaction for human comments, and continuous monitoring.

**Invoke the pr-monitor skill** (call the Skill tool with `skill: "pr-monitor"`) and
follow ALL steps through Step 5, including:
- **Step 3**: Reply to every bot comment BEFORE resolving the thread
- **Step 4**: Follow-up check after pushing fixes
- **Step 5**: Continue monitoring — never auto-terminate

## Reporting

After all phases complete, output a summary:

```
Ship check complete:
- PR Review:    <N findings, M fixed> (correctness, security, conditional)
- Code Quality: <N findings, M fixed> (conventions, readability)
- Test Audit:   <N findings, M fixed> (test quality); <K coverage gaps, J tests written>
- Bug Check:    <N findings, M fixed, K flagged> (by dimension)
- PR Monitor:   <CI status, N bot comments resolved>
- Verdict:      ship / ship-with-minor-fixes / needs-changes
```

## Options

The user can customize the pipeline:

- `/ship-check --skip code-quality` — skip a phase
- `/ship-check --only pr-review,test-audit` — run specific phases
- `/ship-check --no-fix` — report only, don't apply fixes
- `/ship-check --inline` — run all phases in the current context (no agents, no fresh
  eyes — useful when context from prior work is actually helpful)
- `/ship-check --fork` — use forks instead of agents (legacy behavior — spawns forks
  that call Skill to load each review skill)

If the user doesn't specify options, run all five phases with agents (the default).
