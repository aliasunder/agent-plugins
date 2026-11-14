# Changelog


## [1.2.1] — 2026-11-07

### Features

- **ship-check:** Deliver PR review-response rules at their moment
- **ship-check:** Run the project's live test as a conditional verification step
- **ship-check:** Add artifact-gate.ts, the verification step's change classifier
- **ship-check:** Fix defects, flag unevidenced new handling, cap no-impact fixes after review round 4
- **ship-check:** Fully review only the first tool-list file and proofread the rest
- **pr-monitor:** Self-arm adaptive OpenCode monitoring loops
- **ship-check:** Let the tool-definition re-review skip a reorder-only edit
- **ship-check:** The design pass reads shipped agent instructions as code
- **ship-check:** Run a whole-PR design pass after Phase 5 and before the first merge-ready verdict
- **ship-check:** Dimension 8 keeps guards whose message carries the recovery, and proposes ones another layer enforces
- **ship-check:** Dimension 8 proposes rare-and-cheap guards instead of weighing them away
- **ship-check:** Add code-quality dimension 8, a report-only whole-change design pass
- **ship-check:** Triage deferred findings as each phase defers them
- **ship-check:** Delta reviews send the test auditor when new commits change tests
- **ship-check:** Phases commit and the orchestrator pushes once after Phase 5
- **pr-monitor:** Post a merge-ready verdict to the user's inbox in the ship-check pipeline
- **ship-check:** Triage findings a PR won't fix with triage-finding when available
- **tool-definition-review:** Add a caller-use sweep that judges every sentence claim by claim
- **scripts:** Make headless runs wait for their agents and report any that did not finish
- **scripts:** Run a plugin from a checkout in a headless Claude Code session
- **tool-definition-review:** Ask whether the caller can act on each added sentence
- Choose review models and reasoning effort explicitly
- **ship-check:** Dispatch the tool-definition reviewer when a tool list changes
- **ship-check:** Surface-diff --plan turns changed tool lists into reviewer dispatches

### Bug Fixes

- **ship-check:** Keep the stand-in audit and reuse records out of public PR bodies
- **pr-monitor:** Merge a moved base only when the PR needs it
- **tool-definition-review:** Let the reviewer redirect the diff script's output to a scratch file
- **ship-check:** Check both lockfile sides for off-registry entries and refuse any import attribute before parsing
- **ship-check:** Keep off-registry lockfile entries, SHA action bumps and any macro mention as artifact changes
- **ship-check:** Refuse macro imports before parsing, match directives by line, reach scripts by name
- **ship-check:** Stop the artifact gate running PR macros and closing false exemptions
- **ship-check:** Follow npm run from lifecycle scripts and pre/post variants too
- **ship-check:** Check both sides of a dependency spec and read a live-test package through its alias
- **ship-check:** Close the gate gaps the paired reviews found
- **review:** Artifact gate catches lockfile bumps, deletions, aliases and npm ci hooks
- **ship-check:** Compare a nested override by value when checking a dependency bump
- **ship-check:** Treat an added or removed package.json override as a dependency bump
- **review:** Low-cost evidenced handling is flagged too; post-cap reply form, round definition and override record
- **ship-check:** Keep security findings out of the unevidenced re-categorization
- **review:** Align plan-reviewer exception, sibling category claim and cap size wording
- Pr-review's test step no longer says fixes change no behavior
- Correct category count and handling-approval rules in review skills
- **review:** Align review-cap gate, report field and triage wording
- **tool-definition-review:** Fail absence, implied-consequence and mechanism clauses on sight
- **fresh-eyes:** Scope metadata checks to Node reads
- **fresh-eyes:** Support scoped Codex source reads
- Preserve monitor state and readiness checks
- **opencode:** Use native reviewer dispatch controls
- **triage:** Design-pass final pass under --report with a PR, --only lists, a trigger that ignores its own fixes and base merges
- Design pass re-checks edits after its continuation, keeps cut and kept pieces decided
- **triage:** A protective piece is the user's decision even when it predates the change; restores go to the user only with new evidence
- **review:** Design pass runs once in pr-monitor, cut list format and scope
- **ship-check:** Dimension 8 never calls a publish, release or delete that is hard to undo a cheap failure
- **ship-check:** Dimension 8 runs option experiments in /tmp by absolute path, never cd
- **triage:** Report-only runs list triage results, Pending holds the verdict, local mode reads commit messages
- Close re-ask and never-routed paths in ship-check triage
- **triage:** Settle reserved findings' results and Pending's effect on the verdict
- **review:** Route every triage-finding result and keep user-only findings unfixed
- **ship-check:** Correct which regression tests a delta review audits, and quote-safe pr-monitor replies
- **ship-check:** Stale --local claim, regression tests on triage-finding fixes, sibling gaps
- **ship-check:** No last-tag fallback on a branch, and fresh-eyes skips deleted files
- **review:** Route a failing gap test to the production-bug report
- **test-audit:** Report production bugs to triage without writing a failing test
- **ship-check:** Triage Phase 5's flags — complex fix drops the risk clause, proposals carry categories
- Push-step gaps, stale fix-or-flag summaries, and narrow test-file searches
- **ship-check:** One fix-or-flag rule for every reviewer, and Phase 4 flags its production bugs
- **review:** Push-failure path, local-mode wording, safe .filter(Boolean) fix, HEAD SHA reports
- **code-quality:** Flag redundant .filter() type predicates instead of asking for them
- **test-audit:** Match test-auditor's exit to the skill's fast exit, and give named-file audits a coverage range
- **ship-check:** Local mode reviews unpushed commits before falling back to the last tag
- **tool-definition-review:** Cap sweeps at four tools and keep contrast sentences
- **ship-check:** Standalone runs on the default branch ask for a base; correct merge-base and dispatch claims
- **review:** Resolve local-mode bases with merge-base and carry Base into inline/fork runs
- **ship-check:** Diff every phase against the PR's merge base, not local main
- Match the Phase 3 pause rules to the skill and keep the headless note to what the run knows
- **scripts:** Remove --out again whenever <out>.stderr cannot be created
- **review:** Keep comment moves that dimension 4 asks for
- **review:** Name a cut fact the way the Facts line names it
- **review:** Leave no empty output when a headless run cannot start
- **code-quality:** Let a project format rule justify reshaping a comment
- **tool-definition-review:** Judge caller use against the definition without the sentence
- **code-quality:** Treat a comment that repeats the file's own text as restating
- **code-quality:** Judge each fresh-eyes pause before editing for it
- Apply only user-stated constraints to model selection
- Preserve guidance selection and inherited review controls
- **review:** Refuse a plan whose copies differ only in letter case
- **review:** Report --since removals the review never saw, and name a missing repository as one
- **review:** Pair renamed tool lists in --since plans and read from the repository top

### Refactoring

- **ship-check:** One old commit for the gate's file list and reads; widen the macro guard
- **review:** Write only the tool lists the printed plan names
- **review:** Stop copying --since tool lists that nothing reads
- **ship-check:** Pr-review hands tool definitions to the tool-definition step

### Documentation

- **ship-check:** With no Confirm-before line, the verification step deploys without asking
- **tool-definition-review:** Say the redirect allowance in the summary, lead and trace text too
- **ship-check:** Settle the verification step's read-only run point, judged exemptions and audit paths
- **ship-check:** Name the design pass in both READMEs
- **ship-check:** Give every tool-definition dispatch the same intended-tools list
- **ship-check:** Settle the tool-definition step's open points from a dry run
- **ship-check:** Describe the tool-definition reviewer as a pipeline step

### CI / Infrastructure

- Bump umm-actually to v0.4.11 (#36)
- Pin the test workflow to the Bun the tests run with locally

### Maintenance

- **deps:** Bump actions/create-github-app-token from 3.2.0 to 3.3.0 (#35)

### Other Changes

- Pin whole artifact-gate results, split multi-case tests and cover untested branches
- Clarify the artifact gate and the verification step's skill text
- Clarify defect vs new-handling wording across review skills
- Clarify monitoring coverage and scheduling state
- Clarify PR monitoring instructions and mode boundaries
- Resolve design-pass referents, triggers and cut-list rules
- Resolve referents and routing gaps in ship-check triage steps
- **ship-check:** Carry the test-audit wording fixes to the other phase agents and skills
- Resolve fresh-eyes pauses in test-audit and ship-check instructions
- **ship-check:** Define undefined terms, fix forward references and report slots
- **ship-check:** One name per review range value and stated reasons for each base
- **scripts:** Cover the headless runner's input errors, signal exit and model passthrough
- Resolve fresh-eyes pauses in the headless runner and reviewer skills
- **scripts:** Run every command-line test against the stub claude
- **review:** Pin the --plan branches that no test could fail on
- Name the plan's commits, path maps, and outputs; spell out the tool-definition step's lookups


## [1.2.0] — 2026-10-08

### Features

- **ship-check:** Tool-definition reviewer saves its report to a temp file
- **ship-check:** Tool-definition reviewer checks list structure and referents
- **ship-check:** Tool-definition reviewer loads fable-mode and sequential thinking
- **ship-check:** Tool-definition reviewer agent, skill, and surface-diff script (#33)
- **ship-check:** Require a repo-wide sweep receipt on pr-monitor fixes
- **ship-check:** Pr-monitor sweeps the finding's class before each push
- **ship-check:** Dispatchable persona for fresh-eyes
- **ship-check:** Code-quality always loads response-style + docs standards
- **ship-check:** Behavior-preservation contract for fix-mode phases
- **ship-check:** Parameterized-test titles must name the case, not dump values
- **ship-check:** Flag prefixed destructuring renames in code-quality
- **ship-check:** Explicit readability responsibility + spacing and local-extraction triggers
- **ship-check:** --report, --local, --diff modes + commit attribution + audience-aware review
- **ship-check:** Code-quality prose-correctness triggers + response-style
- **ship-check:** Wire fresh-eyes into pipeline as Phase 2
- **plan-check:** Price the accepted mechanism, not just the rejected alternatives (#19)
- **ship-check:** Default all phase agents to opus (#18)
- **ship-check:** Add fresh-eyes, an on-demand stranger read with no review apparatus
- **ship-check:** Bug-check decides which side of a D1 mismatch is wrong
- **ship-check:** Code-quality reads as a stranger before the checklist
- **ship-check:** Add --model flag, default agents to inherit session model (#14)

### Bug Fixes

- **ship-check:** Name where a body file goes before posting it
- **ship-check:** Tool-definition reviewer searches through the shell when Grep is missing and returns report files inline
- **ship-check:** The orchestrator's PR-level comments follow the plain-command rule
- **ship-check:** Pr-monitor names the reply shapes a sandboxed session refuses
- **pr-review:** The feature-surface section is a list
- **pr-review:** Accept a feature-surface list as well as a table
- **ship-check:** Keep Codex PR monitoring active
- **ship-check:** Pass model in comment mode
- **ship-check:** Harden attribution dispatch
- **ship-check:** Pass Codex attribution model
- **ship-check:** Name the review bots where the sweep misses are described
- **ship-check:** Keep the sweep receipt in the run output, not the PR reply
- **ship-check:** Scope the pass-fix contract to out-of-repo surfaces
- **ship-check:** Drop correction residue from code-quality's style-core step
- **ship-check:** Code-quality reads style-core, not the dialogue skill
- **ship-check:** Restructuring rule constrains expected behavior, not assertion form
- **ship-check:** Invert destructuring trigger — renames carry the source, bare keys lose it
- **ship-check:** Scope exact model ids to Codex
- **ship-check:** Require exact model ids in attribution
- **ship-check:** Anti-narrowing enforcement for pr-monitor + anti-dismissal discipline for code-quality fresh-eyes pauses
- **ship-check:** Restore original prompt-cache parenthetical
- **ship-check:** Restore prompt-cache rationale with expansion
- **ship-check:** Four findings from the fresh-eyes pipeline test run
- **ship-check:** Pr-monitor steady-state loop must query all 2d endpoints
- **ship-check:** Drop the model placeholder from dispatch templates

### Documentation

- **ship-check:** Fix README skill path, extend --model rule to delta reviews

### CI / Infrastructure

- Bump umm-actually to v0.4.10 (#32)
- Wire the phases review-dispatch input to the UMM_PHASES repo variable (#20)
- Expose diff_exclude_paths and respect_linguist_generated in umm_review.yml (#16)

### Maintenance

- **ci:** Bump umm-actually to v0.4.9 (#31)
- **ci:** Bump umm-actually to v0.4.8 (#30)
- Bump umm-actually to v0.4.7 (#28)
- **ci:** Bump umm-actually to v0.4.6 (#26)
- **ci:** Bump umm-actually to v0.4.5 (#24)
- Bump umm-actually to v0.4.4 (#22)
- Bump umm-actually to v0.4.3, add timeout-minutes: 30 (#21)
- Bump umm-actually to v0.4.1 (#15)


## [1.1.1] — 2026-09-06

### Bug Fixes

- **pr-monitor:** Decide comment new-ness by id and timestamp, not body text (#13)
- **plan-check:** Unpin plan-reviewer from opus, inherit session model (#11)

### Maintenance

- **deps:** Bump umm-actually to v0.4.0 (#12)


## [1.1.0] — 2026-09-04

### Features

- **ship-check:** Carry Reviewed-at and Dismissed into the pipeline snapshot (#10)
- **ship-check:** Port output-honesty contracts from plan-review (#9)
- **plan-check:** Pre-implementation plan review agent + skill (#3)
- **ship-check:** Attribution enforcement + review body finding parsing
- **test-audit:** Mock-call-log provenance + derivable-exact-value triggers
- **code-quality:** Docs & comment concision dimension + simplification triggers
- **pr-monitor:** Delta-review prerequisite + cross-cutting-requires-a-count rule
- **ship-check:** Pre-merge delta review of post-phase commits

### Bug Fixes

- **ship-check:** Give phase agents the Grep and Glob tools (#4)
- **ship-check:** Comment footer model ID comes from agent frontmatter, not orchestrator
- **ship-check:** Add local vault-cortex tool names to agent allowlists

### Refactoring

- **ship-check:** Agents self-identify model ID in comment footers

### CI / Infrastructure

- Bump umm-actually to v0.3.14 (#8)
- Add umm-actually review workflow (#5)
- Add dependabot config for GitHub Actions bumps (#6)

### Maintenance

- **deps:** Bump actions/checkout from 5 to 7 (#7)


## [1.0.3] — 2026-08-06

### Features

- **ship-check:** Simplicity triggers + same-pattern sweep scope

### Bug Fixes

- **ship-check:** Add local vault-cortex tool names to agent allowlists (#2)
- **ship-check:** Replace soft assertion preferences with procedural triggers

### CI / Infrastructure

- Scope app token to contents:write only
- Use GitHub App token for release workflows and add CodeRabbit config

### Maintenance

- Expand .gitignore with common exclusions


## [1.0.2] — 2026-07-18

### Features

- **ship-check:** Discover standards notes by tag before reading
- **ship-check:** Load code standards from vault instead of local reference files
- **ship-check:** Add CI/CD and IaC as reviewable code across all phases
- **ship-check:** Add phase/model footer to comment-mode PR reviews
- **ship-check:** Add --comment mode for review-only PR commenting

### Bug Fixes

- **ship-check:** Anchor standards discovery on property triple, not tag alone
- **ship-check:** Add docs-coherence triggers from vault-cortex PR #339 review gaps
- **ship-check:** Generalize layer-appropriate error messages trigger
- **ship-check:** Add 6 idiomatic-TS triggers from vault-cortex PR #321 review
- **ship-check:** Pr-monitor also sweeps review bodies and PR-level bot comments
- **ship-check:** Surface deferrals immediately, PR-visibility + clean-tree guards
- **ship-check:** Embed footer in pr-monitor reply templates
- **ship-check:** Add ?./?? carve-outs to test-audit, footer to pr-monitor replies
- **ship-check:** Make model ID dynamic in comment-mode dispatch

### Refactoring

- **ship-check:** Generalize domain-specific language in rule text

### Documentation

- **agents:** Generalize skill authoring section beyond ship-check
- **agents:** Add skill authoring conventions — trigger structure, generalization, PR-derived triggers

### Maintenance

- **ship-check:** Set all agents to model: opus

## [1.0.1] — 2026-07-02

### Features

- **ship-check:** Add pipeline skills to plugin
- Add ship-check plugin with fresh-eyes review agents

### Bug Fixes

- **ship-check:** Add callback decomposition trigger to code-quality D2
- **ship-check:** Add false-positive misuse and formatter-exposed code triggers to pr-monitor
- **ship-check:** Add mechanism mischaracterization trigger to bug-check D1
- **ship-check:** Target memory bootstrap to Opinions → Code patterns section
- **ship-check:** Strengthen D6 feature surface docs trigger in pr-review
- **ship-check:** Add wrong-item pass trigger, merge/fusion asymmetry example
- **ship-check:** Add Buffer/ArrayBuffer view aliasing trigger to D3
- **ship-check:** Add concrete trigger patterns for assertion quality and test hygiene
- **ship-check:** Add .env files to scope, broaden config surface check
- **ship-check:** Bug-checker fixes must follow project AGENTS.md conventions
- **ship-check:** Add vault_get_memory to agent tool allowlists
- **ship-check:** Add sequentialthinking to agent allowlists, add CodeRabbit-derived patterns
- **ship-check:** Add concrete sequential thinking triggers to all agents
- **ship-check:** Add universal effort assessment rule for orchestrator
- **ship-check:** Add environment-aware triage, ban silent catches
- **ship-check:** Ban silent skipping, require effort verification, add pre-existing gap category
- **ship-check:** Add inter-phase triage, dual-axis confidence, monitoring enforcement
- **ship-check:** Sharpen helper-reuse trigger and ban decomposed assertions
- **ship-check:** Add named-params trigger, ban ! in tests, concrete two-bar example
- **ship-check:** Verify factual claims in docs PRs, not just code PRs
- **ship-check:** Add filesystem security checks and close pre-existing deferral loophole

### Documentation

- Link external dependencies (fable-mode, sequential-thinking, vault-cortex)
- Remove local install/cache specifics from AGENTS.md
- Rewrite README for public release, correct AGENTS.md marketplace mechanics

### CI / Infrastructure

- Port release workflows from agent-skills marketplace era

### Maintenance

- Add package.json for repo-level versioning
- Add LICENSE (MIT), SECURITY.md, and CHANGELOG.md for public release
- Add AGENTS.md, CLAUDE.md, and .gitignore
- Add marketplace manifest

### Other Changes

- First commit
## [1.0.0] — 2026-06-26

### Features

- **ship-check:** Plugin with four fresh-eyes review agents (pr-reviewer, code-quality-reviewer, test-auditor, bug-checker) and six pipeline skills (ship-check orchestrator, pr-review, code-quality, test-audit, bug-check, pr-monitor)
- Marketplace manifest with directory-source registration
