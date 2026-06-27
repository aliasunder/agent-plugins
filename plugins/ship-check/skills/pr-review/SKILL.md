---
name: pr-review
description: >
  Project-aware PR review grounded in AGENTS.md conventions and vault memory. Runs a
  multi-dimension review: correctness, convention compliance, test quality, security,
  performance, and conditional checks (TDQS scoring, feature surface docs). Use when
  asked to "review this PR", "review PR #X", "do a thorough review", "review against
  AGENTS.md", or "review with my preferences in mind". Complements the built-in
  /code-review (which is generic) by loading project-specific conventions and personal
  preferences.
  NOT for: quick CI failure diagnosis (use pr-monitor), post-merge testing (use verify),
  or code simplification without a PR context (use code-quality).
skills:
  - fable-mode
tools:
  - mcp__sequential-thinking__sequentialthinking
---

# PR Review

Multi-dimension, project-aware PR review. This skill orchestrates the review — the
knowledge lives in the project's AGENTS.md and the user's vault memory.

## Review mindset

Approach this review as a skeptical outsider seeing the code for the first time:

- **Don't trust existing code.** Code that "is already there" or "was just written"
  is not assumed correct. Every line in the diff is under review.
- **Default to thorough.** No shortcuts, no skimming. If you'd need to pause to
  verify something, verify it.
- **Follow fable-mode discipline.** Write a stage map before starting. Verify each
  stage with a check that can fail. Self-critique before delivering findings.

## Before reviewing

Load these sources fresh every time — do not rely on what is already in context:

1. **Project conventions**: Read the project's `AGENTS.md` (or `CLAUDE.md` if no
   AGENTS.md exists) from the repo root. Pay attention to: code style, test conventions,
   module layering, naming rules, logging conventions, MCP tool description conventions.

2. **User preferences**: Retrieve vault memory via `vault_get_memory` — specifically
   the Opinions (especially Code patterns) and Principles files. These contain codified
   preferences like naming rules, immutability requirements, comment philosophy, and
   the two-bar test convention.

3. **Reference docs**: If the project is TypeScript, read the three reference docs at
   `~/.claude/references/` (typescript-standards.md, testing-patterns.md,
   logging-security.md).

4. **The diff**: Read the full diff and all source files touched by the PR. For large
   PRs, read file-by-file rather than just the diff — context around changes matters.

## Review dimensions

Structure the review by dimension. Use sequential thinking to organize findings.

### 1. Correctness
- Logic errors, edge cases, off-by-one, null handling
- Error paths exercised, not just happy path
- Race conditions, concurrency issues
- API contract violations

### 2. Convention compliance (high-level scan)
- Scan for obvious convention violations — naming, structure, module layering
- Focus on what /code-quality won't catch: module boundary violations (wrong
  dependency direction), logging convention mismatches (info vs debug boundary,
  two-arg pattern), MCP wire format issues (snake_case vs camelCase)
- **For thorough convention review, follow up with /code-quality**

### 3. Test quality (high-level scan)
- Confirm tests exist for new behavior and error paths
- Spot-check for obvious two-bar violations (silent no-op, wrong-error pass)
- Check test naming matches what tests actually assert
- **For thorough test audit, follow up with /test-audit**

### 4. Security and performance
- OWASP top 10 (injection, XSS, auth issues)
- No committed secrets, even in tests (use fake fixtures)
- Performance: unnecessary allocations, N+1 queries, unbounded loops
- Logging security: no PII, credentials, or sensitive data in logs
- **CI/workflow security** (when `.yml` workflow files changed):
  - Secrets scoped to the narrowest level — job-level `env:` exposes secrets to
    every step; prefer step-level `env:` or `${{ secrets.X }}` inline
  - `persist-credentials: false` on `actions/checkout` — prevents the token from
    leaking to subsequent steps
  - Deploy workflows need `concurrency:` blocks to prevent overlapping deploys
  - `if:` conditions can't see step-level `env:` — GitHub evaluates `if:` before
    the step runs on the runner
- **Filesystem security** (when code reads/writes/indexes files from a directory tree):
  - Path traversal: are user-controlled or externally-sourced paths validated with
    `realpath()` containment checks, not just lexical prefix matching? A symlink
    or `../` sequence can escape a root directory that passes a string-prefix check
  - Symlink safety: does code that accepts symlinks verify the target is within
    bounds, is the expected type (file vs directory), and exists (not dangling)?
  - Defense in depth: are containment checks applied at every entry point (root,
    folder, individual file), not just the innermost level? Per-entry validation
    is bypassed if the search root itself is a symlink pointing outside the
    allowed tree
  - Widened eligibility: when a filter is broadened (e.g., `isFile()` →
    `isFile() || isSymbolicLink()`), check that validation covers the guarantees
    the old filter implicitly provided

### 5. TDQS scoring (conditional)
- **Only when tool descriptions changed.** If the PR modifies MCP tool descriptions
  in `tool-definitions.ts` (or equivalent), self-score against the TDQS rubric.
- Check the project's CLAUDE.local.md or AGENTS.md for links to the TDQS rubric
  and scoring references.

### 6. Feature surface docs (conditional)
- **Only when the PR changes feature surface.** Check the "Files that track feature
  surface" table in AGENTS.md (if it exists) for which docs need updating alongside
  the code change.

### 7. Stale path references (conditional)
- **When files are moved, renamed, or directories created/removed.** Grep AGENTS.md
  (and ARCHITECTURE.md if it exists) for the old path or directory name. The structure
  tree, module layering prose, logger chain, and naming convention sections all reference
  specific file paths — a refactor that moves code without updating these references
  leaves the docs contradicting the codebase. Check every path mentioned in the diff's
  renamed/added/deleted files against the docs.

## How to report and fix

**Default is fix, not report-only.** Always apply fixes unless the user explicitly asks
for review-only. For review-only mode, post findings as inline PR comments via `gh api`.

**One line per finding, then fix it.** Keep reports compact — the diff shows the fix:

```
[D1] file.ts:42 — issue description → fixed
[D4] file.ts:88 — issue description → flagged (low confidence)
```

1. **Report each finding** as a one-liner: `[dimension] file:line — what's wrong → fixed / flagged`.
   Group by dimension when multiple findings exist. Don't describe the planned fix —
   the diff speaks for itself.
2. **Fix** all high and medium confidence findings directly. Flag low-confidence
   findings with brief reasoning — don't fix without asking.
3. **Run tests** after all fixes to confirm no behavior change.
4. **Summarize**: count by dimension and severity, test status, verdict
   (ship / ship-with-minor-fixes / needs-changes).
