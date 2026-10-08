# Changelog


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
