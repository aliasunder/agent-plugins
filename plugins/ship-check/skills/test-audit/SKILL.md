---
name: test-audit
description: >
  Audit test files against the project's AGENTS.md test conventions, ensuring tests
  meet the bar for high-quality behavioral specs. Also checks whether production code
  changes have adequate test coverage (coverage gap analysis). Use when asked to "audit
  tests", "check test quality", "review tests against AGENTS.md", "do a test pass",
  "check test conventions", "ensure tests are high quality", or "are there missing
  tests". Focuses on test design, assertion quality, and coverage gaps — not code
  coverage metrics.
  NOT for: production code quality (use code-quality) or full PR review (use pr-review).
skills:
  - fable-mode
tools:
  - mcp__sequential-thinking__sequentialthinking
---

# Test Audit

Systematic audit of test files against the project's test conventions and the user's
codified test quality standards.

## Review mindset

Approach each test as potentially wrong — not as a passing artifact to skim:

- **Don't assume correctness.** A test that exists and passes is not assumed correct.
  Every test is under audit — evaluate whether it actually proves what it claims.
- **Review every test individually.** Not per-file patterns — per-test. Each `it()`
  block gets its own evaluation against the audit dimensions below.
- **Default to thorough.** No shortcuts, no skimming, no "the rest look fine."
  If a test's reliability is in question, mutation-test it.
- **Follow fable-mode discipline.** Write a stage map before starting. Verify each
  stage with a check that can fail. Self-critique before delivering findings.

## Before starting

Load these sources fresh:

1. **Project test conventions**: Read `AGENTS.md` (or `CLAUDE.md`) from the project
   root. Focus on the test conventions section.

2. **User preferences**: Retrieve vault memory via `vault_get_memory` — the Opinions
   file (Code patterns section) contains codified test rules from past review cycles.

3. **Reference docs**: For TypeScript projects, read
   `~/.claude/references/testing-patterns.md`.

## Scope

- **Default**: audit all test files changed in the current branch (vs main/base).
  Use `git diff --name-only main...HEAD` to find changed `.test.ts` / `.spec.ts` files.
- **If the user specifies files or "all tests"**: use that scope instead.
- **Always run coverage gap analysis** on all changed files — production files need
  tests, and changed test files need review for coverage regressions (removed tests,
  weakened assertions, deleted branches). When no test files were changed, gap analysis
  on production files is the primary audit. Do NOT short-circuit with "0 findings."
- **Fast exit**: After identifying changed files, if there are 0 test files AND 0
  production files in scope, report "0 test files, 0 production files changed — nothing
  to audit" and exit. Do not report "0 findings" — report that nothing was in scope.
  This keeps the ship-check pipeline summary accurate (the phase ran and assessed the
  diff, rather than being skipped by the orchestrator).

## Audit dimensions

For each test file, check these in order:

### 1. Behavioral spec structure
- Each `it()` tests ONE focused behavior
- A failing test name should identify which behavior regressed without reading the body
- Test names match what they assert (a test asserting 1 result is not named
  "returns multiple results")

### 2. Two-bar rule
Every test must satisfy BOTH bars:

**Bar 1 — Fails when behavior breaks:**
- If removing the tested behavior, would this test fail?
- Tests that assert preserved state must also assert the trigger happened (no silent
  no-op pass)

**Bar 2 — Passes only for the intended reason:**
- **Silent no-op**: a test asserting "state is preserved" passes even if the operation
  never ran. Assert a side effect that proves the operation executed.
- **Wrong-error pass**: `rejects.toThrow()` with no argument matches ANY error. Assert
  the specific message, and set up fixtures so the intended rejection is the only one
  possible.
- **Early-return pass**: a returned `0`/empty/`false` can come from the guard you're
  testing OR from the function bailing out early. Assert a side effect unique to the
  intended path. Concrete example: `expect(listNotes(escapingDir)).toEqual([])` passes
  both when the containment guard fires AND when the directory is simply empty — add a
  sentinel (spy on the warn log, or call `listNotes(vaultRoot)` and assert `length > 0`)
  to prove the guard is the reason for the empty result.

### 3. Assertion quality
- Exact assertions (`toBe`, `toHaveLength(2)`) over loose matchers
  (`toBeGreaterThanOrEqual(1)`, `toBeDefined()`) when the expected value is known
- Full object/output match (`toBe` on the whole value) over `contains`/substring
  when output is deterministic and inputs are controlled
- **No decomposed assertions**: `toHaveLength(1)` + `results[0].path === "foo"`
  is weaker than `expect(results.map(r => r.path)).toEqual(["foo"])` — the
  decomposed form doesn't catch extra items, ordering changes, or unexpected
  properties. When you can assert the whole shape in one statement, do it.
  The trigger: any time you see `toHaveLength` followed by index-based property
  checks, collapse into a single `toEqual`
- Reserve `contains` for when only a fragment is genuinely under test
- **No position-agnostic assertions on ordered collections.** When an API returns
  results in a deterministic order (`Promise.allSettled` preserves input order,
  `Array.map` preserves index, `Object.entries` preserves insertion order), assert
  the exact positional shape — not "some element matches."
  The trigger: `arrayContaining` or `.filter(r => r.status === ...)` on results
  from `Promise.allSettled`, `Promise.all`, or any ordered collection where the
  test description claims positional behavior ("the second call rejects", "first
  result succeeds"). When you see this pattern, check whether the test name claims
  a specific position — if it does, the assertion must verify that position.
  Wrong: `expect(results).toEqual(expect.arrayContaining([expect.objectContaining({status: "rejected"})]))` — proves *some* call rejected, not *which* call.
  Right: `expect(results).toEqual([expect.objectContaining({status: "fulfilled"}), expect.objectContaining({status: "rejected", reason: ...})])` — proves the first succeeded and the second rejected.
- **No substring matching on deterministic error messages.** When the error message
  is a hardcoded string literal in the source code (not interpolated, not dynamic),
  assert the exact message — not a substring.
  The trigger: `stringContaining("...")` or `toThrow("...")` (substring match) on
  an error whose message text is a fixed literal. Read the production code to check
  — if the `throw` or `reject` uses a template literal with variables, substring is
  fine; if it's a plain string like `"concurrent write in progress"`, match exactly.
  Wrong: `expect.stringContaining("concurrent write")` — matches any error that
  happens to contain that substring.
  Right: `message: "concurrent write in progress"` — matches only the intended error.

### 4. Test hygiene
- `const` per test over `let` + `beforeEach` when possible
- `beforeEach` justified only for shared setup all tests in a `describe` need
- Explicit callback parameter names (`orphan` not `o`, `entry` not `e`)
- No `!` non-null assertions — banned in production AND test code. Use a guard
  (`if (!x) throw`) or restructure the assertion (`toEqual([expect.objectContaining(...)])`)
  instead of `results[0]!.path`
- Use vitest helpers (`onTestFinished`, `vi.mocked`, `vi.each`) before hand-rolling
- **No trailing cleanup that gets skipped on failure.** When a test creates
  resources (temp directories, files, servers, connections), cleanup code at the
  END of the test body is skipped if any assertion or `await` throws.
  The trigger: `rm(...)`, `cleanup()`, `close()`, or any teardown call that appears
  AFTER assertions in the same test body, without a corresponding `afterEach` or
  `onTestFinished` registration.
  Wrong: `await mkdir(dir); /* ...assertions... */ await rm(dir)` — `rm` never
  runs if an assertion fails, leaving artifacts behind.
  Right: `await mkdir(dir); onTestFinished(() => rm(dir, {recursive: true, force: true})); /* ...assertions... */` — cleanup runs regardless of test outcome.

### 5. Completeness
- Error paths tested, not just happy path
- Boundary conditions covered
- Folder/tag/property filter tests include data BOTH inside and outside the filter
  to confirm exclusion works

## Coverage gap analysis

Always runs alongside the audit dimensions above. When no test files were changed, this
is the primary audit. It answers: "should there be tests for what changed?"

1. **List all changed files**: `git diff --name-only main...HEAD`. Separate into two
   lists: test files (`.test.ts` / `.spec.ts`) and non-test files. Exclude docs (`.md`)
   and generated files from the non-test list. Don't categorically exclude config files
   (`.config.ts`, `sst.config.ts`, etc.) — check whether existing tests cover them
   first (`grep -rn "config" --include="*.test.ts"`). If a config file has tests,
   it's in scope.

2. **For each changed non-test file**, read the diff (`git diff main...HEAD -- <file>`)
   and classify each change:
   - **New exported function/method** — needs tests unless trivially thin (a re-export,
     a one-line delegation to an already-tested function)
   - **New branch/condition** — an `if`, `switch` case, early return, or error path
     that didn't exist before — needs a test exercising that branch
   - **Changed behavior** — modified return value, different error message, reordered
     logic — existing tests should have been updated to reflect the new behavior
   - **Refactor-only** — renamed variable, extracted helper with identical behavior,
     moved code — no new tests needed IF existing tests still cover it (verify they do)
   - **Bug fix** — should have a regression test proving the fix works (and that
     reverting it would fail)

3. **Check for existing coverage**: for each gap candidate, search for existing tests
   that cover it (`grep -rn "functionName\|describe.*ModuleName" --include="*.test.ts"`).
   A function may already be tested even if its test file wasn't changed.

4. **Report each gap as a one-liner, then write the test:**

   ```
   [hard gap] file.ts:42 newFunction — no coverage → wrote file.test.ts: "does X when Y"
   [soft gap] file.ts:88 errorBranch — happy path covered, new branch not → wrote: "rejects when Z"
   ```

   For each gap: add tests to the existing test file for that module (create one if
   none exists). Follow the audit dimensions above — don't write tests that would fail
   your own audit. For bug fixes, mutation-test the new test (verify it fails when the
   fix is reverted). Run the suite after all tests are written.

5. **Coverage regression check** (changed test files): For each changed test file, read
   the diff and look for:
   - **Removed `it()` blocks** — was the coverage they provided replaced or is it gone?
   - **Weakened assertions** — `toBe` → `toBeDefined`, exact match → `toContain`,
     specific error message → bare `toThrow()`
   - **Removed error/edge-case tests** — a refactor that keeps happy-path tests but
     drops boundary tests is a coverage regression
   - **Commented-out or `.skip`'d tests** — these are silent coverage holes

   Report as:
   ```
   [regression] file.test.ts:42 — removed "rejects when path escapes vault" → restored
   [weakened] file.test.ts:88 — toBe → toBeDefined, expected value is known → fixed
   ```

## Mutation testing

For each finding where a test's reliability is in question, verify by mutation:

1. Temporarily break the specific behavior the test claims to verify
2. Run the test — it MUST fail, and fail for the right reason (not a compile error
   or unrelated assertion)
3. Restore the code

This proves the test is load-bearing, not decorative.

## How to report and fix

**One line per finding, then fix it:**

```
[two-bar] file.test.ts:42 — silent no-op, no side-effect assert → fixed
[assertion] file.test.ts:88 — toBeDefined, expected value is known → fixed
[mutation] file.test.ts:42 — verified: broke behavior, test catches it
```

- **Fix** directly — rewrite the test to meet conventions.
- **Run the test suite** after fixes to confirm all tests still pass.
- Coverage gap reporting uses the one-liner format in the gap analysis section above
  — don't repeat it here.
- **Summarize**: files audited, count by category, tests mutation-verified,
  coverage gaps found and tests written.
