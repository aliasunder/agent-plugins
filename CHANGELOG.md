# Changelog


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
