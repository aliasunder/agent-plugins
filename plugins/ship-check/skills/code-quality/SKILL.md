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

2. **User preferences**: Retrieve the `Code patterns` section from the Opinions
   memory file — contains the user's codified preferences from past review cycles:
   `vault_get_memory({ file: "Opinions", section: "Code patterns" })`

3. **Reference docs**: For TypeScript projects, read `~/.claude/references/typescript-standards.md`.

## Scope

- **Default**: sweep all files changed in the current branch (vs main/base branch).
  Use `git diff --name-only main...HEAD` to find them.
- **If the user specifies files or a scope**: use that instead.
- **Skip test files** — those have their own skill (/test-audit).
- **All code file types are in scope** — TypeScript, JavaScript, YAML, Dockerfile,
  JSON config, shell scripts, etc. CI/CD and IaC are reviewable code. Apply the
  dimensions below to whatever format the changed files use. For YAML (workflows,
  IaC, docker-compose), check naming (job/step IDs), structure (DRY via anchors,
  step ordering, logical grouping), comments (non-obvious conditions), and simplicity
  (unnecessary complexity in `if:` expressions, redundant steps). For Dockerfiles,
  check layer ordering, naming, and simplicity. If the applicable dimensions produce
  0 findings, report "0 findings" — that is a valid result, not a reason to skip.

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
- **Callback decomposition trigger**: when a `.map()` / `.flatMap()` / `.reduce()`
  callback spans more than a few lines, or contains its own intermediate variables
  or nested chains (`.filter().map()` inside `.map()`), extract the body into a
  named function. The parent then reads as a clean one-liner:
  `items.map(formatItem).join("\n")`. Concrete signs it needs extraction: the
  callback (a) builds multiple named intermediates then combines them, (b) contains
  its own `.filter().map()` pipeline, or (c) has ternaries inside `${}`
  template interpolation. Related smell: conditional spreads
  (`...(cond ? [item] : [])`) — prefer building the full array with conditional
  entries and calling `.filter(Boolean)`
- **Named params trigger**: functions with >2 args, or with adjacent same-typed
  args that could be silently transposed, should use a named-params object. Two
  adjacent `string` roots or two adjacent `number` limits are a swap hazard —
  the call compiles fine with args reversed but does the wrong thing
- **Verbose null/undefined guards trigger**: when a conditional checks
  `!== undefined`, `!== null`, or both — check whether the falsy set (0,
  `false`, `""`) matters for the variable's type. If the variable holds an
  optional object, array, string ID, regex result, or config value where
  0/`false`/`""` are not valid values, flag: replace with truthy/falsy check
  (`if (x)` / `if (!x)` / `Boolean(x)`). Regex `.exec()` results are always
  replaceable — they return `null` on no-match, never 0 or `false`. Only keep
  explicit null/undefined checks when 0, `false`, or `""` are legitimate values
  that must not be treated as absent (e.g., `if (count !== 0)`)
- **Optional chaining trigger**: when an undefined/null guard is immediately
  followed by property access or method call on the guarded value, collapse to
  optional chaining: `value?.prop ?? fallback` over
  `value === undefined ? fallback : value.prop`. Applies to array indexing too:
  `arr[i]?.trim()` over
  `const x = arr[i]; if (x === undefined) break; x.trim()`. Also applies to
  ternary access patterns:
  `nearestHeading?.text ?? null` over
  `nearestHeading === undefined ? null : nearestHeading.text`
- **Type predicates on `.filter()` trigger**: when `.filter()` removes
  `undefined` or `null` from a typed array, use a type predicate
  (`(x): x is T => x !== undefined`) so TypeScript narrows the downstream type.
  Without it, the filtered array retains `| undefined` and forces unnecessary
  guards or assertions downstream
- **Plain values over thunks trigger**: when a callback parameter (`() => T`)
  wraps a trivially cheap, side-effect-free computation that every call site
  has ready, flag: accept `T` directly. If every call site passes
  `() => alreadyComputedValue`, the thunk adds indirection without benefit
- **Layer-appropriate error messages trigger**: internal/data-layer functions
  must not reference API-surface names (tool names, route paths, CLI flags) or
  suggest caller-level remediation in their error messages. Error messages
  describe what went wrong in the function's own domain
  ("no done lane detected"), not how to fix the caller's input
  ("pass lane explicitly via the update call"). Remediation guidance belongs in
  the API surface (tool description, route docs, CLI help text). Related: error
  messages should use the module's own naming convention (camelCase in TS
  modules), not the API surface's convention (snake_case, kebab-case, etc.)

### 3. Error handling hygiene
- **No silent catches**: `.catch(() => {})` and `catch (e) {}` swallow errors
  with no trace. Every catch must log or re-throw — never swallow silently.
- When fixing a catch block, always include a log call with the error and enough
  context (path, operation) to diagnose from the log alone

### 4. Comments
- Comments earn their place by clarifying non-obvious domain context
- Never restate self-documenting names
- If a long comment is needed, consider simplifying the code instead
- Regex constants get doc comments explaining what they match

### 5. Simplicity
- Simple code over clever code — fewer moving parts, fewer lines when achievable
- Each line should say what it does on its own
- Working is the floor, not the bar — ask whether a simpler structure exists
- A reader should not need to pause to understand what the code does

### 6. Module conventions (if project has module layering rules)
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

## Comment mode

When the dispatch prompt says **COMMENT MODE**, do not edit files, commit, or push.
Instead, collect all findings and post them as a single GitHub PR review with inline
comments.

### Procedure

1. **Review normally** — check all dimensions (naming, structure, error handling,
   comments, simplicity, module conventions). The only difference is the output path.
2. **Collect findings** as you go. Each finding needs: file path (relative to repo root),
   line number, category tag, and description with the suggested fix.
3. **Post a single PR review** with all findings as inline comments:

```bash
gh api "repos/OWNER_REPO/pulls/PR_NUMBER/reviews" \
  --method POST --input - <<'REVIEW'
{
  "event": "COMMENT",
  "body": "## Phase 2: Code Quality\n\nN findings across M files.\n\n---\n*🔍 ship-check · code-quality · MODEL_ID*",
  "comments": [
    {
      "path": "src/file.ts",
      "line": 42,
      "body": "**[naming]** `searchText` not `needle`\n\n```suggestion\nconst searchText = ...;\n```\n\n---\n*🔍 ship-check · code-quality · MODEL_ID*"
    }
  ]
}
REVIEW
```

Replace `OWNER_REPO`, `PR_NUMBER`, and `MODEL_ID` with values from the dispatch prompt.

4. **If 0 findings**, skip the API call — report "0 findings" to the orchestrator only.
5. **Footer on every comment.** Append `\n\n---\n*🔍 ship-check · code-quality · MODEL_ID*`
   to the review body AND each inline comment body.
6. **Format each inline comment body** as:
   - Bold category tag: `**[naming]**`, `**[structure]**`, etc.
   - One-line description of the issue
   - Suggested fix as a code snippet (use GitHub's `suggestion` fence when the fix is
     a direct replacement — this gives the PR author a one-click "Apply suggestion" button)
   - Footer (see above)
