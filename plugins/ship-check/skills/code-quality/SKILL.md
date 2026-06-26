---
name: code-quality
description: >
  Readability and convention compliance pass on production code, grounded in the
  project's AGENTS.md and the user's vault memory preferences. Use when asked to
  "do a readability pass", "code quality pass", "make more readable", "review code
  quality", "clean up against conventions", "simplify with my preferences", or
  "review against AGENTS.md". Different from the built-in /simplify (which is generic)
  — this loads project-specific conventions and personal preferences.
  NOT for: test file audits (use test-audit), full PR review (use pr-review), or
  generic simplification without convention grounding (use /simplify).
skills:
  - fable-mode
tools:
  - mcp__sequential-thinking__sequentialthinking
---

# Code Quality Pass

Readability and convention compliance sweep grounded in the project's own rules and the
user's codified preferences — not generic best practices.

## Review mindset

Approach this review as a skeptical outsider seeing the code for the first time:

- **Don't trust existing code.** Code that "is already there" or "was just written"
  is not assumed correct. Every line is under review — not just new additions.
- **Default to thorough.** Review every item individually. No shortcuts, no skimming,
  no "looks fine." If you'd need to pause to verify something, verify it.
- **Report everything.** Flag every finding, even marginal ones. Mark uncertain findings
  with "Uncertain:" so the user can decide. Missing a genuine issue is worse than
  flagging a borderline one.
- **Follow fable-mode discipline.** Write a stage map before starting. Verify each
  stage with a check that can fail. Self-critique before delivering findings.

## Before starting

Load these sources fresh — do not rely on what is already in context:

1. **Project conventions**: Read `AGENTS.md` (or `CLAUDE.md`) from the project root.
   Focus on the code style section — naming, immutability, early returns, comment
   philosophy, module layering, export style.

2. **User preferences**: Retrieve vault memory via `vault_get_memory` — the Opinions
   file (especially Code patterns section) and Principles. These contain the user's
   codified preferences from past review cycles.

3. **Reference docs**: For TypeScript projects, read `~/.claude/references/typescript-standards.md`.

## Scope

- **Default**: sweep all files changed in the current branch (vs main/base branch).
  Use `git diff --name-only main...HEAD` to find them.
- **If the user specifies files or a scope**: use that instead.
- **Skip test files** — those have their own skill (/test-audit).

## What to check

Work through the changed files. For each, check these dimensions in order:

### 1. Naming
- Variables describe what the value IS, not shorthand (`availableHeadings` not
  `available`, `searchText` not `needle`)
- Function names state what they DO specifically (`collectWikilinksFrom` not `collect`)
- Callback params are explicit (`orphan` not `o`, `entry` not `e`)
- SQL aliases are descriptive (`element` not `je`)
- Booleans named for the affirmative state (`hardLinksSupported` not `hardLinksUnsupported`)

### 2. Structure
- Early returns over nested if/else
- Immutable by default — no unjustified `let`
- No disguised-mutation folds (reduce that mutates its accumulator)
- Named records over positional tuples where it aids readability
- Named locals over inline expressions where it helps a line read on its own

### 3. Comments
- Comments earn their place by clarifying non-obvious domain context
- Never restate self-documenting names
- If a long comment is needed, consider simplifying the code instead
- Regex constants get doc comments explaining what they match

### 4. Simplicity
- Simple code over clever code — fewer moving parts, fewer lines when achievable
- Each line should say what it does on its own
- Working is the floor, not the bar — ask whether a simpler structure exists
- A reader should not need to pause to understand what the code does

### 5. Module conventions (if project has module layering rules)
- Dependency direction respected
- Exports match the project's style (namespace objects vs named exports)
- Utils/ admission bars met

## How to report and fix

**One line per finding, then fix it.** Keep reports compact — the diff shows the fix:

```
[naming] file.ts:42 — `searchText` not `needle` → fixed
[structure] file.ts:88 — nested if/else, should early-return → fixed
```

1. **Report each finding** as a one-liner: `[category] file:line — what's wrong → fixed`.
   Group by category when multiple findings exist. Don't describe the planned fix —
   the diff speaks for itself.
2. **Fix** every finding directly — this is a "pass", not just a review.
3. **Run tests** after all fixes to confirm no behavior change.
4. **Summarize**: files touched, count by category, test status.
