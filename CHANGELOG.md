# Changelog

## [Unreleased]

### Documentation

- Public-release prep: rewritten README with personal-workflow caveats, LICENSE (MIT), SECURITY.md, this changelog

### CI / Infrastructure

- Release workflows ported from the agent-skills repo (marketplace-era version): tag-driven auto release with version validation, manual release with patch/minor/major bump

## [1.0.0] — 2026-06-26

### Features

- **ship-check:** Plugin with four fresh-eyes review agents (pr-reviewer, code-quality-reviewer, test-auditor, bug-checker) and six pipeline skills (ship-check orchestrator, pr-review, code-quality, test-audit, bug-check, pr-monitor)
- Marketplace manifest with directory-source registration
