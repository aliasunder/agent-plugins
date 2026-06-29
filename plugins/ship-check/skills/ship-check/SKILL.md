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
   finding as: `uncertain diagnosis`, `complex fix`, or `needs design decision`.
2. **Apply the triage matrix**:

   | Diagnosis | Fix | Action |
   |-----------|-----|--------|
   | Uncertain | Trivial (< 5 lines, no interface change) | Fix — safe even if diagnosis is wrong |
   | Uncertain | Complex or risky | Defer to user |
   | Certain | Trivial | Fix |
   | Certain | Complex (> 10 lines or interface changes) | Defer to user |
   | Any | Needs design decision | Always defer to user |

3. **For fixes**: read the relevant code, apply the edit, run tests, commit and push.
4. **Record results**: track triage fixes separately from phase fixes in the summary.

### Key principle: risk vs. confidence

"Low-risk" (the fix is safe to apply) is a reason TO fix, not to defer. "Low-confidence"
(uncertain whether the issue exists) calls for caution — but when the fix is trivial and
safe, apply it anyway. The cost of a no-op 3-line fix is near zero; the cost of leaving
a real bug is not.

Only defer when the **fix itself** is uncertain, risky, or requires a design decision.

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
Phase 1 fixed and what remains deferred.

### Phase 2: Code Quality

Dispatch the `code-quality-reviewer` agent type:

```
Agent({
  subagent_type: "ship-check:code-quality-reviewer",
  description: "Code quality — conventions, readability",
  prompt: "Run a code quality pass on branch <branch> (PR #<number>) against main. Review all changed production files for naming, structure, comments, simplicity, and module conventions. Skip test files. Fix every finding, commit, and push. Prior-phase context: <summarize what Phase 1 fixed and any deferred findings>."
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
  prompt: "Audit tests on branch <branch> (PR #<number>) against main. Audit all changed test files against convention dimensions AND run coverage gap analysis on changed production files. Write missing tests for coverage gaps. Fix test quality issues. Commit and push. Prior-phase context: <summarize what Phases 1-2 fixed and any deferred findings>."
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
  prompt: "Run a systematic bug check on branch <branch> (PR #<number>) against main. Read every changed production file in full. Apply all 7 dimensions — especially dimension 1 (description-vs-implementation, quote verbatim). Fix high-confidence bugs directly. For medium/low-confidence findings: fix if the change is trivial and safe (< 5 lines, no interface change); only flag when the fix itself is uncertain, risky, or needs a design decision. When flagging, categorize as: 'uncertain diagnosis', 'complex fix', or 'needs design decision'. Commit and push. Prior-phase context: <summarize what Phases 1-3 fixed and any deferred findings>."
})
```

Wait for the agent to complete. Read its findings. **Run inter-phase triage** on any
flagged findings.

### Phase 5: PR Monitor (inline — does not end)

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

## Reporting

Output the summary below as a **status snapshot** during Phase 5 monitoring — not as a
pipeline conclusion. Update it on each monitoring pass as PR status evolves.

```
Ship check complete:
- PR Review:    N findings, M fixed (correctness, security, conditional)
- Code Quality: N findings, M fixed (conventions, readability)
- Test Audit:   N findings, M fixed (test quality); K coverage gaps, J tests written
- Bug Check:    N findings, M fixed (by dimension)
- Triage:       N flagged findings triaged across all phases — M fixed, K deferred
- PR Monitor:   CI status, N bot comments resolved
- Deferred:     <list each with flag category, or "none">
- Verdict:      ship / ship-with-minor-fixes / needs-changes
```

If any findings remain deferred at the end of Phases 1-4, present them to the user with
their flag category and ask for a decision before declaring the verdict.

After outputting this report, **continue the Phase 5 monitoring loop** — the report is a
status update, not a termination signal.

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
