---
name: plan-review
description: >
  Adversarial critique of an implementation plan BEFORE any code exists — premise
  audit, alternatives comparison, guard/control arithmetic, concurrent-writer
  analysis, and verification-plan quality. Derived from analysis of real planning
  failures that survived a full post-implementation review pipeline because review
  verifies mechanisms, not premises.
  Use when asked to "review this plan", "critique the plan", "plan check", "is this
  plan ready", "review the task note before I start", or before implementing any
  card that adds behavior, a guard, or spans sessions.
  NOT for: reviewing implemented code or PRs (use ship-check / pr-review), writing
  the plan itself (that's fable-mode + Plan agents), or auditing tests (test-audit).
skills:
  - fable-mode
allowed-tools:
  - mcp__sequential-thinking__sequentialthinking
---

# Plan Review

Adversarial critique of an implementation plan before implementation starts. This
skill examines **premises, not mechanisms**: whether the plan solves a real problem,
whether its assumptions hold, whether the chosen approach beats the alternatives —
including doing nothing — and whether its own verification steps are safe to run.

How this differs from ship-check: ship-check reviews the mechanism that was built.
Plan-review examines whether it is the right mechanism to build. The founding case:
a row cap on client registrations passed all four ship-check phases (9 code-level
findings, all mechanism-correct) — and only manual review noticed that one address
operating under the existing rate limit fills the cap in ~75 minutes and locks the
owner out. The design was a denial vector; no amount of code review would have said
so, because the code faithfully implemented the flawed premise.

## What counts as a plan

Any of: a plan document (`plans/*.md`), a task note (`## Problem` + What + Done
when), a plan-mode plan, or an approach stated in conversation. The reviewer
produces **findings only — never edits the plan.** Revision belongs to the plan's
author, who holds context the reviewer doesn't.

## Before starting

1. Read the plan artifact IN FULL, plus the task note / card it implements and any
   documents it links.
2. Load the target repo's AGENTS.md (conventions the plan must fit).
3. Load vault context where available (ToolSearch the `vault_*` schemas if
   deferred): `vault_memory_recall({ query: "<plan's domain>" })` for dated
   preferences, and read any session logs or research notes the plan cites.
4. Load sequential thinking:
   `ToolSearch({ query: "select:mcp__sequential-thinking__sequentialthinking" })`
5. Read the code the plan touches — enough to check the plan's claims about
   current behavior against what the code actually does. A premise audit that
   trusts the plan's description of the existing system inherits its errors.
   **Pin the verification state:** date the plan artifact, and when it isn't
   fresh, verify claims against the repo as of that date (the last commit before
   it), not HEAD — HEAD may have drifted, or may already contain the
   implementation, and either direction poisons the premise audit. Fresh or not,
   record the commit you verified against for the output's verification-basis
   line.
6. Classify the change: feature / guard-or-control / refactor / infra / docs.
   Dimension 4 is conditional on that classification. In the same pass, note
   whether the plan responds to a recent incident — that property, not the
   class, is what makes dimension 6a run.

## Dimensions

Run every applicable dimension. Dimension 2 gets the most time — false or
unverified premises are the highest-cost failures, because everything downstream
of them is wasted work.

### 1. Problem framing

- **Flag** when the problem is stated as the absence of the proposed mechanism
  ("there is no cap", "we lack a guard") rather than as what goes wrong for whom
  ("the `clients` table grows without bound, degrading X for Y"). Absence-framing
  smuggles the solution into the problem and blocks alternative thinking.
  **Boundary:** small mechanical tasks (a lint rule, a bump, a rename) need only
  a one-sentence problem — don't demand ceremony.
- **Flag** when no one is named who experiences the problem. A problem no one has
  is a mechanism looking for a justification.
  **Boundary:** shares the mechanical-task carve-out above — a one-sentence
  problem for small mechanical work names its sufferer implicitly (the failing
  lint, the stale dependency); don't demand a cast list.

### 2. Premise and assumption audit

Proof-of-work rule: **quote each load-bearing assumption verbatim** before judging
it, then classify it: *verified in the plan* (evidence cited), *checkable now*
(a read, grep, or query would settle it), or *deferred to implementation*.

- **Block** on a deferred unknown that is go/no-go for the design. A plan that
  says "assuming X holds, the simple approach works; if not, redesign" and defers
  checking X has scheduled its redesign for the most expensive possible moment.
  Checkable-now items get checked now — by you, if a read or grep settles it.
  **Stop condition:** one honest, well-aimed search per item. If a referenced
  document, rule, or constraint doesn't surface, the finding is the plan's
  missing link, not your missing effort — report it and move on rather than
  hunting exhaustively.
- **Flag** any asserted constraint with no stated source. Ask: where does this
  rule come from? Agents have designed around constraints that turned out to be
  invented; a constraint that can't be traced to a doc, a decision, or a
  measurement is a hallucination until shown otherwise.
  **Boundary:** if one read or search can trace the constraint, do that instead
  of flagging (the checkable-now rule) — flag only what fails the search or
  can't be checked from here.
- **Flag** observations promoted to requirements. "The system currently does X"
  is a fact; "the system must keep doing X" is a decision — the plan must not
  silently convert one into the other.
  **Boundary:** an explicit decision to preserve current behavior, with a stated
  reason, is legitimate — the flag is for the silent conversion only.
- For each premise, ask: **how would we know if this is false?** A premise with
  no falsification path is not load-bearing evidence, it's hope. Example of a
  premise that failed exactly this way: "a missing file needs bootstrapping" —
  false in a sync-backed environment, where a missing file is usually one the
  sync layer hasn't delivered yet, and acting on it races the delivery.

### 3. Alternatives and the do-nothing baseline

- **Flag** when the plan names only one mechanism. A plan with one option hasn't
  compared — it has decided and decorated. At least one genuine alternative with
  a stated reason for rejection.
  **Boundary:** mechanical tasks are exempt (there is one way to bump a version).
- **Always check the do-nothing baseline:** what do existing layers already
  cover? Post-incident planning has produced protective measures that duplicated
  existing snapshots, and volume-split proposals whose "protection" defeated
  legitimate layout changes. "Rejected: existing layer X already handles this" is
  a valid — often the correct — outcome, and a plan that never considered it
  can't reach it.

### 4. Guard and control arithmetic *(conditional: the plan adds a guard, cap, limit, quota, lockout, or security control)*

- **Compute, don't gesture.** Using the plan's own numbers (rate limits, cap
  sizes, window lengths, timeouts), calculate the cheapest path for an
  unauthorized party to trigger the control. If the plan supplies a rate and a
  cap, the time-to-fill is one multiplication — do it in the review.
- **Who pays when it fires?** If tripping the control is cheap for an attacker
  and expensive for the owner (lockout, data loss, manual recovery), the control
  is a denial vector, not a defense. That is a **blocker**, not a nitpick.
- **Boundary:** controls that only constrain the owner's own automation (a
  local-only sweep, a soft warning) get the same arithmetic but a lower default
  severity — the failure mode is annoyance, not lockout.

### 5. Concurrent writers and async state

- For every piece of state the plan reads, writes, or assumes stable, **name
  every other writer**: sync services, file watchers, other agent sessions, CI,
  retention jobs, the user's own hands. A plan silent about the other writers of
  contended state gets a must-answer finding. Real case: an edit tool matched
  text against a note version that a sync layer reverted an hour later, garbling
  the write — the plan for those tools had no concept of a concurrent writer.
- **Two-sources-of-truth check:** when the plan uses X as a proxy for Y
  ("tracked by the watcher" standing in for "present in the index"), demand the
  invariant that keeps X and Y aligned — and who restores it when it breaks. A
  proxy conflation of exactly this shape made files permanently invisible to
  search, and every cheap patch failed because the proxy itself was the bug.
  **Docs variant:** two documents asserting the same facts are two sources of
  truth. A plan that creates a new document without stating the disposition of
  an existing one covering the same ground (extend, replace, redirect) is
  planning a divergence — readers will land on the stale one.
- **What survives the reset?** For any step that wipes, rebuilds, or migrates
  state: enumerate the state that persists across the operation the plan treats
  as clean. A test that wiped a data volume while adjacent sync-identity state
  survived pushed 1,472 deletions to the cloud replica.

### 6. Scope and proportionality

- **(6a) Overcompensation check** *(conditional: the plan responds to a recent
  incident)*: walk each protective measure through the incident it's meant to
  prevent AND through normal operations. Post-incident plans systematically
  over-produce guards; the ones worth keeping survive both walks. Measures that
  defend against the last incident by obstructing routine work get flagged.
- **Scope creep:** every deliverable traces back to the stated problem. Items
  that don't are proposals to surface separately, not scope.
- **Delivery mechanics** *(when the plan spans multiple PRs)*: PR boundaries,
  merge strategy, and changelog/attribution consequences. A one-click stack
  merge that collapses a breaking change's attribution into a neighboring PR's
  entry is a plan defect, not a git trivia question.

### 7. Verification plan quality

- **Flag** verification sections without runnable commands or with checks that
  cannot fail. "Manually verify it works" without a procedure is not a check.
- **Destructive verification steps get their own blast-radius analysis.** A test
  that mutates real state IS a change and deserves the same premise scrutiny as
  the feature — dimension 5's "what survives the reset?" applies to the test
  plan itself. The 1,472-deletion incident above was caused by a *verification
  step*, not by shipped code.
- **Done-when criteria must be testable.** "Works correctly" is vibes;
  "`npm test` passes and the reconciliation log shows zero skipped entries" is a
  criterion.

### 8. Structure and open-question hygiene

House conventions, where the repo follows them (**boundary:** for repos without
these conventions, report as recommendations, never violations):

- Task notes open with `## Problem`, sized to the task; plans that add behavior,
  guards, or span sessions carry premise/assumptions and alternatives; guard
  tasks carry the dimension-4 control test.
- Open questions are split into **"verify before implementation"** (technical
  go/no-go — resolve them now, see dimension 2) and **"for the user"** (judgment
  calls — surface them, don't guess them).
- Ratified plans carry a dated decision log; multi-file plans carry a module
  map; fable-mode plans document their provenance (agents used, lookups made).

## Rules that override intuition

- **Quote before critiquing.** Every finding cites the plan's own text — or, for
  absence findings, names what's missing AND the concrete failure scenario the
  absence permits. "The plan doesn't mention X" is only a finding if you can say
  what goes wrong because of it.
- **Compute when numbers exist.** If the plan contains any two of rate, cap,
  window, size, or timeout, do the arithmetic that connects them before deciding
  the design is sound.
- **Verify before asserting** — the same rule you're enforcing. Check the code
  or docs before claiming the plan contradicts them; an invented constraint in a
  critique is exactly the failure this skill exists to catch.
- **Premises over mechanisms.** Flag code-level design only when it invalidates
  a premise or a dimension above. Style, naming, and idiomatic concerns belong
  to ship-check after the code exists.
- **Findings, not edits.** Never rewrite the plan, and never soften a blocker
  into a recommendation to be agreeable. If genuine checking finds nothing, say
  so plainly — do not manufacture findings to justify the review.

## Sequential thinking triggers

Call `sequentialthinking` — mandatorily, before the action, not as vague habit:

- **Before declaring any blocker.** Input: the quoted premise, the evidence it
  fails. Output: the failure scenario stated concretely enough to be wrong.
- **Before dismissing a suspicion.** Anything you considered flagging and are
  about to drop — think through what would have to be true for it to bite.
- **Before the overall verdict.** Weigh blockers vs. the change's size; a
  blocker on a two-line task usually means the review is miscalibrated.

## Output format

```
Plan review complete:
- Plan: <path, or "stated in conversation">
- Change class: feature / guard-control / refactor / infra / docs
- Verified against: <commit or state actually checked, + which claims>
- Verdict: ready / ready with changes / not ready
- Blockers: N        (false or unverified go/no-go premise, denial vector,
                      destructive verification without blast-radius analysis)
- Must-answer: N     (an implementer following the plan as written would be
                      forced to guess — the answer doesn't invalidate the
                      design, but the plan must carry it)
- Recommendations: N (would improve the plan; an implementer could proceed
                      correctly without it)
- Dimensions passed: <list>
```

The must-answer / recommendation boundary is the guess test: if a competent
implementer without the author's context would have to guess, it's must-answer;
if they'd proceed correctly and the plan is merely weaker for the omission, it's
a recommendation. The verification-basis line is mandatory — a review that
doesn't say what it checked is indistinguishable from one that checked nothing,
which is the exact failure mode this skill exists to catch.

Then findings ordered by severity, each with: dimension, the quoted premise (or
the absence + its failure scenario), and what would resolve it. A finding without
a resolution path is a complaint, not a review. Close with a short **proof of
dismissal** for anything you seriously considered and dropped — the clean-bill
claims are part of the review.
