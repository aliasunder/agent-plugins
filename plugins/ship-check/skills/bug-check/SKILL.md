---
name: bug-check
description: >
  Systematic bug hunt focused on patterns that survive code review and test audit —
  description-vs-implementation mismatches, SQL correctness, type coercion bugs,
  boundary/off-by-one errors, behavioral asymmetry, and input validation gaps.
  Derived from analysis of 40+ bugs found by Qodo and CodeRabbit that the ship-check
  pipeline (pr-review, code-quality, test-audit) missed.
  Use when asked to "bug check", "check for bugs", "deep correctness check", "look
  for subtle bugs", or as part of the ship-check pipeline.
  NOT for: code style (use code-quality), test design (use test-audit), security
  review (use security-review), or high-level correctness review (use pr-review).
skills:
  - fable-mode
tools:
  - mcp__sequential-thinking__sequentialthinking
---

# Bug Check

Systematic hunt for bugs that survive intuitive code review. This skill applies
**pattern-based checks** derived from what Qodo and CodeRabbit consistently find that
human and AI reviewers miss.

How this differs from pr-review: pr-review reads the diff holistically and reasons
about what could go wrong. Bug-check applies a **checklist of known miss patterns**
to every changed file. It is systematic where pr-review is intuitive.

## Before starting

1. Load AGENTS.md for project conventions.
2. Load vault memory preferences via `vault_get_memory`.
3. Identify all files changed in the branch vs main:
   ```
   git diff main --name-only
   ```
4. **Scope check**: Production code (`.ts`, `.js`), infrastructure (`.yml`, `.yaml`,
   `Dockerfile`, `docker-compose*`), and config files (`sst.config.*`, `*.json`) are
   in scope. CI/workflow files ARE in scope — dimension 1
   (description-vs-implementation) applies to workflow step descriptions, job names,
   and conditional logic. Pure documentation changes (only `.md` files) are out of
   scope — report "0 checkable files changed — docs only" and exit. This keeps the
   ship-check pipeline summary accurate (the phase ran and assessed the diff, rather
   than being skipped by the orchestrator).
5. Skip test files — test-audit handles those.
6. **Read each changed file in full** — not just the diff. Bugs hide in how new
   code interacts with surrounding context.

## Dimensions

Run each dimension against every changed production file. Dimension 1 gets the most
time — it is the highest-yield check (40%+ of bot findings fall here).

### 1. Description-vs-implementation verification

The #1 source of missed bugs. The description says one thing; the code does another.

**For every function, tool definition, or doc comment in changed files:**

1. **Quote each sentence of the description verbatim** before checking it. This is
   mandatory proof-of-work — it surfaces truncated, garbled, or incomplete text that
   looks fine at a glance but fails on close read. A sentence like "even if a folder
   can't be." is obviously incomplete when quoted, but easy to skip over when skimming.
2. Extract every **factual claim** from the quoted sentences:
   - "Returns results sorted by X" → requires ORDER BY X
   - "Detectable via tool_Y" → tool_Y must actually do that
   - "Creates X if not found" → creation logic must exist
   - "Requires parameter Z" → Z must be validated as required
   - "Returns empty array, not an error" → verify no throw on empty
3. **Trace each claim to the implementation.** Read the actual code path.
4. **Flag any mismatch**: claim not implemented, implemented differently,
   references the wrong function/tool/concept, or is truncated/garbled text.

**Cross-references are a known hot spot.** When a description mentions another tool
or function by name:
1. **Read the referenced tool/function's description and implementation** — don't
   just check the name exists. Confirm it actually does what the referencing
   description claims it does.
2. **Verify directionality** — the most common error is naming the wrong sibling
   (e.g., "use vault_find_orphans to find notes with broken links" when orphans
   are notes with no *incoming* links, not notes with broken *outgoing* links;
   or "use vault_get_outgoing_links" when vault_get_backlinks is correct).
3. **Verify workflows end-to-end** — when a description prescribes a multi-step
   procedure ("after doing X, use Y to find Z"), trace the full workflow. Each
   step must produce the output the next step expects. A cross-reference that is
   individually correct can still be wrong in context if the workflow logic is
   flawed.

**Stale claims:** Check that descriptions still match after refactoring. A renamed
function, moved parameter, or changed return type can leave the description accurate
for the old code but wrong for the new.

**CI/workflow files** (`.yml`): Apply dimension 1 to step names, job names, and
conditional logic. A step named "Configure Tailscale" that is always skipped due to
an `if:` scoping bug is a description-vs-implementation mismatch. Also check:
- `if:` conditions reference variables that are actually visible at evaluation time
  (GitHub evaluates `if:` before the step runs — step-level `env:` is not visible)
- Secrets are scoped to the narrowest level (step, not job) to limit exposure
- `persist-credentials: false` on checkout steps
- Deploy workflows have `concurrency:` blocks to prevent overlapping runs

### 2. SQL correctness

**For every SQL query in changed files:**

1. **Description-query alignment**: Does the query implement what the tool description
   promises? "Sorted by modification date" needs `ORDER BY mtime DESC`.
2. **Aggregation accuracy**: COUNT(*) vs COUNT(DISTINCT column) — overcounting is
   common when JOINs multiply rows.
3. **Determinism**: Any `LIMIT` without `ORDER BY` returns nondeterministic results.
   If the function's contract implies stable ordering, this is a bug.
4. **WHERE completeness**: Could rows leak through that shouldn't? Check that all
   documented filter conditions appear in the query.
5. **GROUP BY correctness**: Every non-aggregated SELECT column must be in GROUP BY
   (SQLite is lenient here, but the results are undefined for missing columns).

### 3. Type safety and coercion

**Look for these patterns in changed code:**

- **Truthiness bugs**: `if (!x)` where `x` could legitimately be `0`, `""`, or
  `false`. Replace with `x === undefined` or `x === null` for absence checks.
- **Loose equality**: `== 0` or `== ""` almost always wants strict `===`.
- **Type assertions**: `as` casts and `!` non-null assertions bypass the compiler.
  Verify each is safe, or replace with a runtime guard.
- **Missing narrowing**: After a type check (`typeof x === 'string'`), using `x`
  outside the narrowed block where it is still the union type.

### 4. Boundary and off-by-one

**For each function with numeric parameters (limit, offset, index, count):**

1. **Empty input**: What happens with an empty array, string, or result set?
2. **Truncation indicators**: If showing "N+" for overflow, does the code fetch
   `limit + 1` to detect truncation? Showing "5+" when exactly 5 results exist
   is a known bug pattern.
3. **Inclusive vs exclusive**: Is the range `[start, end]` or `[start, end)`?
   Off-by-one in slice, substring, and SQL LIMIT/OFFSET.
4. **Zero and one**: These values expose special-case bugs. Does the function
   handle `limit: 0` or `offset: 0` correctly?

### 5. Behavioral consistency

**Look for asymmetric handling of similar constructs:**

1. **Parallel code paths**: If function A handles wikilinks one way and markdown
   links another way, verify the difference is intentional, not an oversight.
   Common: one path handles an edge case that the other path misses.
2. **Overly broad transformations**: An operation applied everywhere when it should
   be scoped to a specific context (e.g., stripping escape characters globally
   instead of only in table cells where they appear).
3. **Shared helpers not used**: If a helper exists for IP extraction, timezone
   conversion, or error formatting, verify all call sites use it. A new call site
   that reimplements the logic instead of calling the helper will drift.
4. **Inconsistent defaults**: Same parameter with different defaults in different
   functions — one uses `true`, another uses `false`, with no documented reason.

### 6. Input validation and error paths

**For each function that accepts parameters:**

1. **Parameter combinations**: What happens with unexpected combos? (e.g.,
   `section` without `file`, `heading_level` without `heading`). Look for silent
   fallthrough where an error or early return is needed.
2. **Input normalization**: Case-sensitive comparisons on user input that could
   arrive in mixed case (URLs, file extensions, header values).
3. **Error message safety**: Do error messages include vault paths, internal state,
   or implementation details that shouldn't reach clients?
4. **Guard correctness**: Is a guard condition (`if (value !== "")`) the right
   check? Could it be unconditional, or does it need a different condition?

### 7. Platform and encoding

**Check for assumptions that break on real-world input:**

- **CRLF**: Does text processing assume `\n`? Content from Windows or mixed
  sources may contain `\r\n`. Check line splitting, blank-line detection, and
  regex anchors.
- **Timezone**: Are date operations consistent? Hardcoded UTC when the rest of the
  codebase uses local time (or vice versa) is a subtle bug.
- **Unicode**: String length/slice operations on multi-byte characters. Regex
  patterns that assume ASCII.

## Procedure

1. **For each changed production file**, read the full file content (not just the
   diff). Log that you read it — cite what you checked as proof of work:
   ```
   vault-crud-tools.ts (650 lines) — 3 tool defs, 5 cross-refs, 0 SQL, 2 guards
   ```
   "0 findings" after 60 seconds across multiple files means the checks were
   skipped, not that the code is clean.
2. **Weight effort by dimension yield**: dimension 1 (description-vs-code) gets
   the most scrutiny. For each description, quote every sentence verbatim (step 1 of
   dimension 1) then extract and trace claims. This is not optional — it's the
   mechanism that catches truncated text and garbled prose that skimming misses.
   Dimensions 6-7 are quicker but still require reading the code.
3. **One line per finding, then fix it:**
   ```
   [D1] file.ts:612 — description refs vault_find_orphans, should be vault_get_backlinks → fixed
   [D4] file.ts:88 — off-by-one in LIMIT, fetches N not N+1 for truncation → flagged (medium)
   ```
   Don't describe the planned fix — the diff speaks for itself. For medium/low
   confidence, add brief reasoning after "flagged." Don't fix low-confidence
   findings without asking the user.
4. Stage, commit, and push all fixes.
5. Report:

```
Bug check complete:
- Files checked: N
- Bugs found: N (M fixed, K flagged for review)
- By dimension:
  - Description mismatch: A
  - SQL correctness: B
  - Type safety: C
  - Boundary/off-by-one: D
  - Behavioral consistency: E
  - Input validation: F
  - Platform/encoding: G
- Confidence: N high, M medium, K low
```
