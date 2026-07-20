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

2. **Code standards + preference recall**: Discover the standards notes first — the
   set grows and hardcoded lists go stale:
   `vault_search({ query: "code standards", filters: { tags: ["code-standards"], type: "reference", properties: { lifecycle: "living" } } })`
   Then `vault_read_note` the audit-relevant results (currently the testing note),
   plus any newer note matching this audit's focus or the repo's stack.
   Then recall the dated evidence trail for the change's domain — it surfaces
   preferences newer than the notes:
   `vault_memory_recall({ query: "testing conventions <change domain>" })`

## Scope

- **Default**: audit all test files changed in the current branch (vs main/base).
  Use `git diff --name-only main...HEAD` to find changed `.test.ts` / `.spec.ts` files.
- **If the user specifies files or "all tests"**: use that scope instead.
- **Same-pattern sweep**: when a D3 trigger fires on changed code, also scan the
  rest of the file for the same anti-pattern in unchanged tests. Pre-existing tests
  are often the source of the pattern (copy-paste inheritance) — fixing only the new
  instance leaves the original infection in place. This is a targeted expansion, not
  a full-file audit: only sweep for the specific anti-pattern that fired, not all
  dimensions.
- **Always run coverage gap analysis** on all changed files — production files need
  tests, and changed test files need review for coverage regressions (removed tests,
  weakened assertions, deleted branches). When no test files were changed, gap analysis
  on production files is the primary audit. Do NOT short-circuit with "0 findings."
- **Fast exit**: After identifying changed files, if there are 0 test files AND 0
  testable files in scope, report "0 test files, 0 testable files changed — nothing
  to audit" and exit. CI/CD workflows (`.yml`), IaC, Dockerfiles, and pure config
  files are not testable in the unit-test sense — a PR that only changes these is a
  valid fast exit. Do not report "0 findings" — report that nothing was in scope.
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
- **Wrong-item pass**: an assertion checks a property of the result (non-empty,
  defined, has length > 0, contains a substring) but doesn't verify the result is
  the EXPECTED item. Common in search/query tests where multiple seeded items could
  satisfy a loose assertion.
  The trigger: test seeds multiple items, queries for a specific one, but asserts only
  that "something was returned" — not "the right thing was returned." Trace the mock
  setup: if the mock returns controlled values that make the output deterministic,
  the test must assert the specific expected item (path, id, content), not just that
  a result exists.
  Wrong: `expect(results[0].snippet).toBeTruthy()` — passes even if the wrong
  note was ranked first.
  Right: `expect(results[0]).toMatchObject({ path: "expected.md", snippet: "exact text" })` — proves the intended item was returned.

### 3. Assertion quality
- Exact assertions (`toBe`, `toHaveLength(2)`) over loose matchers
  (`toBeGreaterThanOrEqual(1)`, `toBeDefined()`) when the expected value is known
- **No decomposed assertions — assert the whole object.** Multiple `expect()`
  calls picking off individual properties of the same result is weaker than one
  `toEqual` on the full shape. The decomposed form doesn't catch extra
  properties, structural drift, added fields, or formatting changes — each
  assertion passes in isolation while the overall object silently diverges from
  what the test intends.
  The trigger: two or more `expect()` calls in a test that reach into the same
  object (same root variable, same array element, or chained properties like
  `result.content[0]?.type` and `result.content[0]?.text`). When you see this,
  check whether the full object shape is deterministic — if it is, collapse
  into a single `toEqual` or `toMatchObject` (when only a subset of properties
  matters and the rest are tested elsewhere).
  Boundary: decomposition IS appropriate when (a) the properties come from
  different sources with different determinism (one controlled, one dynamic),
  (b) the assertion needs a different matcher per property (`toBeInstanceOf`
  on one, `toBe` on another) that `toEqual` can't express, or (c) the object
  is large and only a narrow slice is relevant to THIS test's concern — but
  even then, prefer `toMatchObject` with the relevant subset over individual
  property picks.
  Wrong:
  ```
  expect(result.isError).toBeUndefined()
  expect(result.content).toHaveLength(1)
  expect(result.content[0]?.type).toBe("text")
  expect(result.content[0]?.text).toBe("Hello PDF")
  ```
  — passes even if `result` gains an `error` field, `content[0]` gains extra
  properties, or `isError` is `null` instead of `undefined`.
  Right:
  ```
  expect(result).toEqual({
    content: [{ type: "text", text: "Hello PDF" }],
  })
  ```
  — locks the entire shape. Any structural drift fails the test.
- **No substring matching on deterministic output.** When the production code
  returns a fixed or fully-controlled string (hardcoded literal, template with
  all-controlled variables, mock/fixture-supplied text), assert the exact value
  — not a substring.
  The trigger: `toContain("...")`, `toMatch(...)`, `stringContaining("...")`, or
  any partial-match assertion on a string value. Trace the value to its source:
  if every variable in the string is controlled by the test (fixture data, mock
  return value, hardcoded constant), the output is deterministic and the
  assertion must be exact. This applies to ALL string outputs — content text,
  formatted messages, rendered output, file contents — not only error messages.
  Boundary: substring matching IS appropriate when (a) the output includes
  genuinely non-deterministic segments (timestamps, UUIDs, random IDs, system
  paths), (b) the test intentionally checks only a fragment because the rest is
  tested elsewhere, or (c) the format is explicitly unstable (e.g. a
  human-readable summary that may gain preamble text). When in doubt, check
  whether the test controls the full input — if it does, the output is
  deterministic and `toBe` is correct.
  Wrong: `expect(result.content[0]?.text).toContain("Hello PDF")` — passes if
  the text is `"Hello PDF world"`, `"Error: Hello PDF not found"`, or anything
  containing the substring.
  Right: `expect(result.content[0]?.text).toBe("Hello PDF content extracted successfully")` — proves the exact expected output.
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

### 4. Test hygiene
- `const` per test over `let` + `beforeEach` when possible
- `beforeEach` justified only for shared setup all tests in a `describe` need
- Explicit callback parameter names (`orphan` not `o`, `entry` not `e`)
- No `!` non-null assertions — banned in production AND test code. Use a guard
  (`if (!x) throw`) or restructure the assertion (`toEqual([expect.objectContaining(...)])`)
  instead of `results[0]!.path`
- **`?.` is not `!` — don't conflate them.** The `!` ban targets non-null assertions
  (`results[0]!.path`) that lie to the compiler. Optional chaining (`results[0]?.path`)
  is the opposite — it safely handles undefined at array boundaries. Do not rewrite
  `?.` array access into extracted variables with throw guards; that's verbosity without
  improved test quality. Similarly, `?? fallback` in comparisons
  (`toBeGreaterThan(x?.length ?? 0)`) is type narrowing, not a loose matcher — the
  assertion still fails if the value doesn't meet the threshold.
- **`continue` in a verification loop is not a silent no-op.** A `for` loop checking
  ordering (`each count >= next count`) with a guard
  `if (prev === undefined || curr === undefined) continue` is defending against array
  index bounds, not silently skipping the operation under test. The two-bar "silent
  no-op" rule targets tests where the *tested behavior* never executed — not TypeScript
  narrowing guards on loop indices. Don't convert these to `throw`.
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

## Comment mode

When the dispatch prompt says **COMMENT MODE**, do not edit files, write tests, commit,
or push. Instead, collect all findings and post them as a single GitHub PR review with
inline comments.

### Behavior changes from default

- **Test quality findings**: posted as inline comments on the test file/line, with the
  suggested fix as a code snippet.
- **Coverage gaps**: posted as inline comments on the production file where the gap
  exists (the new function, branch, or error path that lacks tests). Describe what test
  is needed — don't write the test code.
- **Mutation testing**: still run to verify your findings, but only as a diagnostic step.
  The mutation result supports your comment's confidence level.

### Procedure

1. **Audit normally** — run all dimensions and coverage gap analysis. The only difference
   is the output path.
2. **Collect findings** as you go. Each finding needs: file path, line number, category
   tag, and description.
3. **Post a single PR review** with all findings as inline comments:

```bash
gh api "repos/OWNER_REPO/pulls/PR_NUMBER/reviews" \
  --method POST --input - <<'REVIEW'
{
  "event": "COMMENT",
  "body": "## Phase 3: Test Audit\n\nN test quality findings, K coverage gaps across M files.\n\n---\n*🔍 ship-check · test-audit · MODEL_ID*",
  "comments": [
    {
      "path": "src/file.test.ts",
      "line": 42,
      "body": "**[two-bar]** Silent no-op — asserts state preserved but doesn't prove the operation ran\n\nAdd a side-effect assertion (spy on the log call, or assert a counter incremented).\n\n---\n*🔍 ship-check · test-audit · MODEL_ID*"
    },
    {
      "path": "src/module.ts",
      "line": 88,
      "body": "**[coverage gap]** New error branch has no test\n\nNeeds a test that triggers this rejection and asserts the specific error message.\n\n---\n*🔍 ship-check · test-audit · MODEL_ID*"
    }
  ]
}
REVIEW
```

Replace `OWNER_REPO`, `PR_NUMBER`, and `MODEL_ID` with values from the dispatch prompt.

4. **If 0 findings**, skip the API call — report "0 findings" to the orchestrator only.
5. **Footer on every comment.** Append `\n\n---\n*🔍 ship-check · test-audit · MODEL_ID*`
   to the review body AND each inline comment body.
6. **Format each inline comment body** as:
   - Bold category tag: `**[two-bar]**`, `**[assertion]**`, `**[coverage gap]**`, etc.
   - One-line description of the issue
   - What to fix (for test quality) or what test to write (for coverage gaps)
   - Footer (see above)
