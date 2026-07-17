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
2. Load code standards + preference recall — discover the standards notes first
   (the set grows; hardcoded lists go stale), read the pass-relevant results,
   then recall the dated evidence trail for the change's domain (surfaces
   preferences newer than the notes):
   - `vault_search_by_tag({ tag: "code-standards" })`
   - `vault_read_note` the results (currently typescript and docs), plus any newer
     note matching the repo's language/stack
   - `vault_memory_recall({ query: "<change domain>" })`
3. Identify all files changed in the branch vs main:
   ```
   git diff main --name-only
   ```
4. **Scope check**: Production code (`.ts`, `.js`), infrastructure (`.yml`, `.yaml`,
   `Dockerfile`, `docker-compose*`), environment config (`.env`, `.env.*`,
   `.env.example`), and config files (`sst.config.*`, `*.json`) are in scope. CI/workflow files ARE in scope — dimension 1
   (description-vs-implementation) applies to workflow step descriptions, job names,
   and conditional logic. User-facing documentation (`.md` guides, READMEs) is in
   scope for dimension 1 when the docs make factual claims about the system —
   privacy/security guarantees, architecture, data flow, storage locations, capability
   claims, or tool categorization. Verify each claim against the implementation. Pure
   formatting/prose changes to docs are out of scope — but a docs PR that
   says "no external communication" when the system has an outbound sync service is a
   D1 bug, not a style issue. Structural changes (reordering sections, changing which
   method leads, folding content into asides) are NOT out of scope: they trigger the
   D1 structural self-reference check and the D5 alternative-command-path check.
   Only report "docs only — nothing to check" when no factual claims about the
   system are present AND no doc was restructured.
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
   (e.g., "use findOrphans to find broken links" when orphans are nodes with no
   *incoming* links, not nodes with broken *outgoing* links; or referencing
   `getOutgoingLinks` when `getBacklinks` is the correct direction).
3. **Verify workflows end-to-end** — when a description prescribes a multi-step
   procedure ("after doing X, use Y to find Z"), trace the full workflow. Each
   step must produce the output the next step expects. A cross-reference that is
   individually correct can still be wrong in context if the workflow logic is
   flawed.

**Conditional capabilities described unconditionally**: When a description claims a
capability (e.g., "Hybrid search combining FTS and vector similarity"), check whether
that capability is gated behind a feature flag, env var, or optional dependency
(embedder, API key, external service). If it is, the description must either qualify
the claim ("when embeddings are enabled") or describe the degraded mode ("falls back
to keyword-only search"). A description that presents a conditional capability as
always-available is a D1 bug — the LLM reading it will instruct users about features
that may not exist in their deployment. This applies to tool descriptions, README
capability lists, and API documentation. Trace the code path: if there's an early
return or `if (!dependency)` guard that skips the advertised behavior, the description
is wrong for that branch.

**Mechanism mischaracterization**: When a description uses lifecycle or state language
— "starts X then switches to Y", "caches results", "batches requests", "streams
results", "lazy-loads on first use", "queues work" — verify the code actually
implements that mechanism, not just the outcome. A per-query fallback is not a state
transition. A synchronous call is not a queue. The behavior may be correct (users get
the right result) but the mechanism claim teaches a false mental model that misleads
debugging and integration. Signal words to check: "starts", "transitions", "switches",
"initializes once" in descriptions of stateless per-call logic; "batches", "queues",
"pools" in descriptions of sequential per-item processing. Example: a README that says
"search starts FTS-only while the vector index builds, then switches to hybrid
automatically" when the code actually checks `vectorHits.length === 0` per-query with
no global mode state — the fallback is stateless, not a one-time transition.

**Stale claims:** Check that descriptions still match after refactoring. A renamed
function, moved parameter, or changed return type can leave the description accurate
for the old code but wrong for the new.

**Structural self-references in docs**: prose that references the document's own
structure — "shown below", "the manual setup above", "the following section", "as
described earlier" — is a claim about the document, and restructuring breaks it the
same way refactoring breaks code claims. For each such reference in a changed doc,
resolve it against the CURRENT document: the target content must still exist, still
sit in the stated position, and still be what the sentence says it is. A reference
to content that was replaced, moved, or demoted into a collapsible aside is a D1
bug even when every command in the document still works. References that still
resolve correctly need no change.

**CI/workflow files** (`.yml`): Apply dimension 1 to step names, job names, and
conditional logic. A step named "Configure Tailscale" that is always skipped due to
an `if:` scoping bug is a description-vs-implementation mismatch. Also check:
- **Multi-trigger event guards**: when a workflow has multiple triggers in `on:`
  (e.g., `pull_request` + `issue_comment`), check whether each job or step should
  run for ALL triggers or only specific ones. Steps that make sense only for PRs
  (review phases, diff analysis, CI checks) need `if: github.event_name ==
  'pull_request'` guards — otherwise a comment-triggered run executes them too.
  The trigger: a workflow with >1 event in `on:` and steps/jobs without `if:`
  guards on `github.event_name`. Trace each step's purpose and ask "does this
  make sense when triggered by [other event]?"
- `if:` conditions reference variables that are actually visible at evaluation time
  (GitHub evaluates `if:` before the step runs — step-level `env:` is not visible)
- **Action pinning inconsistency**: if some actions in the workflow are pinned to
  commit SHAs and others use mutable tags (`v2`, `@main`), the unpinned ones are
  a D1 mismatch — the workflow's security posture is inconsistent. Check all
  `uses:` lines; flag any third-party action on a tag when siblings are on SHAs
- **Permissions wider than usage**: compare `permissions:` grants against what the
  job's steps actually use. If every step authenticates via a GitHub App token and
  never uses `GITHUB_TOKEN` for writes, `contents: write` or `pull-requests: write`
  on the default token is unnecessary privilege
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
- **Buffer/ArrayBuffer view aliasing**: When code accesses `.buffer` on a
  `TypedArray` (Float32Array, Uint8Array, etc.) and passes it to `Buffer.from()`,
  `new DataView()`, or another constructor — check that `byteOffset` and
  `byteLength` are also passed. `typedArray.buffer` returns the *entire*
  backing `ArrayBuffer`, which is larger than the view when the typed array
  is a subarray or slice. The 1-arg form `Buffer.from(arr.buffer)` silently
  produces the wrong data with no error. Fix: use the 3-arg form
  `Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)`. This pattern is
  especially common in embedding/ML pipelines where providers may return
  Float32Array views over shared buffers.

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

1. **Parallel code paths**: If function A handles one input variant one way and
   a sibling variant another way, verify the difference is intentional.
   Common: one path handles an edge case that the other path misses. Also check
   **merge/fusion points** — when parallel data sources (e.g., FTS + vector
   search, cache + DB, local + remote) are combined into a single result set,
   verify that constraints (filters, access controls, limits) are applied
   equivalently to each source BEFORE the merge. Asymmetric filtering distorts
   the merged ranking — one source contributes unfiltered items that dilute or
   displace filtered results from the other source. Flag even if intentional —
   the reviewer decides scope, you decide what to report.
2. **Overly broad transformations**: An operation applied everywhere when it should
   be scoped to a specific context (e.g., stripping escape characters globally
   instead of only in table cells where they appear). Concrete instance:
   `trim()` vs `trimEnd()` — when only trailing whitespace cleanup is intended
   but leading whitespace carries semantic meaning (indentation, list nesting
   level), `trim()` silently destroys structure. Flag `trim()` on any string
   where leading whitespace encodes hierarchy or formatting.
3. **Shared helpers not used**: Before accepting a language primitive or stdlib
   call in new code, grep `src/utils/` and nearby modules for an existing helper
   that does the same job. This includes bounded alternatives to unbounded
   primitives — if `mapWithConcurrency` exists and new code uses bare
   `Promise.all` for the same fan-out pattern, that's a miss even though
   `Promise.all` isn't "reimplementing" the helper. The trigger is: new code does
   concurrent work, file manipulation, error formatting, or string processing →
   grep for helpers first, then justify why the primitive is correct if one exists.
4. **Inconsistent defaults**: Same parameter with different defaults in different
   functions — one uses `true`, another uses `false`, with no documented reason.
5. **Config default divergence across file types**: When a PR adds or modifies
   environment variables, check that defaults agree across all layers —
   docker-compose (`${VAR:-value}`), `.env.example`, CLI-generated `.env`
   templates (e.g., `env.ts`), and the config parser in code. Check ALL
   config surfaces — a var added to docker-compose and `.env.example` but
   missing from CLI templates means `npx <tool> init` users never see it.
   Also check that `.env.example` comments match their values: a comment
   saying "Disable X" with a value of `# X=true` is a D1 bug — uncommenting
   enables X, not disables it. A common trap: compose uses `${VAR:-}` (empty
   string when unset) but the config parser uses `.default("true")` which
   only applies when the var is absent, not when it's empty. Empty-string
   defaults bypass code-level defaults and can cause startup failures or
   silent misconfiguration.
6. **Alternative command paths in docs**: when documentation offers more than one
   literal command sequence for the same task (quick-start one-liner vs config
   file vs installer/CLI tool), treat them as parallel code paths. Compare the
   resource identifiers they create or reference — data volume/directory names,
   container/service names, project names, ports, generated file paths. Mismatched
   identifiers mean a user who switches methods silently loses access to existing
   data or state; either the identifiers must match across methods or the doc must
   state that the methods are not interchangeable. Also compare configuration
   flags: an alternative that silently omits behavior the other methods set up
   (health checks, restart policy, log limits) needs a note saying what it omits.
   Skip when the methods are explicitly documented as independent of each other.
   Example: a manual `docker run` one-liner mounting `-v vault_data:/vault` while
   the CLI and Compose paths both use the prefixed `vault-cortex_vault_data`
   volume — a user who starts with the one-liner and later runs the CLI gets
   empty volumes and a full re-sync.

### 6. Input validation and error paths

**For each function that accepts parameters:**

1. **Parameter combinations**: What happens with unexpected combos? (e.g.,
   `section` without `file`, `heading_level` without `heading`). Look for silent
   fallthrough where an error or early return is needed.
2. **Input normalization**: Case-sensitive comparisons on user input that could
   arrive in mixed case (URLs, file extensions, header values).
3. **Error message safety**: Do error messages include internal file paths,
   internal state, or implementation details that shouldn't reach clients?
4. **Guard correctness**: Is a guard condition (`if (value !== "")`) the right
   check? Could it be unconditional, or does it need a different condition?
6. **Silent catches**: `.catch(() => {})` and `catch (e) {}` swallow errors with
   no trace. Every catch must either log or re-throw. Catching without logging is
   worse than not catching — it actively hides failures that affect debuggability.
   When fixing a silent catch, always add a log call with the error and enough
   context (file path, operation name) to diagnose the failure from the log alone.
5. **Widened eligibility**: When a filter or eligibility check is broadened
   (new condition added via `||`, new file type accepted, new input source
   supported), trace what guarantees the old filter implicitly provided.
   The new branch must provide equivalent guarantees — or add explicit
   validation for the ones it loses. Common: `isFile()` → `isFile() ||
   isSymbolicLink()` without adding `realpath()` containment, `stat().isFile()`,
   or broken-symlink handling. Also: widening a query scope, accepting a new
   auth method, or supporting a new content type without corresponding validation.

### 7. Platform and encoding

**Check for assumptions that break on real-world input:**

- **CRLF**: Does text processing assume `\n`? Content from Windows or mixed
  sources may contain `\r\n`. Check line splitting, blank-line detection, and
  regex anchors.
- **Timezone**: Are date operations consistent? Hardcoded UTC when the rest of the
  codebase uses local time (or vice versa) is a subtle bug.
- **Unicode**: String length/slice operations on multi-byte characters. Regex
  patterns that assume ASCII.
- **Symlinks and filesystem indirection**: Does code that walks directories
  or reads files follow symlinks without validating targets? Check for:
  (a) containment — `realpath()` to resolve the target, then verify it stays
  within the allowed root (lexical prefix checks on the original path are
  insufficient); (b) type verification — after resolving, `stat().isFile()`
  to reject directories masquerading as files (e.g., a directory named `*.md`);
  (c) broken links — `realpath()` throws ENOENT for dangling symlinks, catch
  and skip gracefully; (d) defense in depth — validate at every entry point
  (search root, directory listing root, individual entries), not just the
  innermost level. A symlinked search root can bypass all per-entry checks.
- **TOCTOU (time-of-check-time-of-use)**: Is there a gap between checking a
  file's properties (stat, readdir) and acting on it (readFile, index)? In
  concurrent environments, the file can change between check and use.
- **Snapshot staleness in background tasks**: When a PR introduces background
  processing using a startup snapshot (e.g., "snapshot all notes, then embed
  them in the background"), check whether the live code path (file watcher,
  API handler) can invalidate entries in the snapshot while it's being consumed.
  Content-hash gating protects against stale updates (the hash won't match) but
  NOT against deletes — if an entry is deleted after the snapshot but before the
  background loop reaches it, the loop recreates stale data for a deleted entity.
  Check: does the background loop verify the entity still exists before writing?

## Rules that override intuition

These rules exist because agents consistently rationalize skipping findings that
turn out to be real and fixable. Each rule addresses a specific failure pattern.

### No silent skipping

Every finding must appear in the output — including pre-existing gaps discovered
during analysis. "Pre-existing, not introduced by this PR" is context for
categorization, not a reason to omit the finding. If you noticed it, report it.

The orchestrator and user cannot act on findings they never see. A bug you found
and silently dismissed is worse than a bug you missed — you confirmed the problem
exists and then hid it.

### Pre-existing analog gaps

When the PR correctly implements a pattern (e.g., adds `EMBEDDING_ENABLED` to all
6 docker-compose files), and you notice an analogous existing feature is missing
from those same files (e.g., `MEMORY_ENABLED` absent from all of them) — that is a
finding. Report it. The PR's correct implementation revealed the gap; the fix is
typically mechanical (copy the pattern the PR already established).

Categorize as: `pre-existing gap` with a note on whether the fix is trivial.
The orchestrator decides scope; you decide what to report.

### No environment-specific dismissals

Don't use one deployment's specs to dismiss resource, performance, or scaling
concerns. "On Lightsail with 4GB RAM and 772 notes, this is negligible" is not a
valid dismissal for an OSS project where users may have 10x the data on half the
RAM. Evaluate concerns against the worst reasonable use case for the project's
audience — not the maintainer's current setup.

And regardless of impact assessment: if the fix is trivial, fix it. A one-line
null-out after data is consumed costs nothing and eliminates the concern entirely.

### Verify effort before claiming it

Before calling any fix "high lift," "would change every call site," or "complex
refactor" — **grep for actual usages**. The difference between "every call site
across the codebase" and "one call site" is the difference between deferring a
finding and fixing it in 30 seconds. Never estimate effort from intuition when a
10-second grep gives the real answer.

### Your fixes must follow AGENTS.md

You loaded AGENTS.md in "Before starting." Apply it to the code you WRITE, not
just the code you review. If AGENTS.md bans `as` assertions, your fix uses a
runtime guard instead. If it requires early returns, your fix uses early returns.
Bug-check runs after code-quality in the pipeline — no convention pass follows
yours. Convention violations in your fixes ship unchecked.

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
   [D4] file.ts:88 — off-by-one in LIMIT, fetches N not N+1 for truncation → fixed (low confidence, trivial fix)
   [D5] file.ts:200 — async init race if called concurrently → flagged (complex fix — needs mutex or queue)
   ```
   Don't describe the planned fix — the diff speaks for itself.
   **Decide fix vs. flag on two axes** — diagnosis confidence and fix complexity.
   **Call `sequentialthinking` before each disposition decision** — input the finding,
   confidence level, and fix complexity; output which matrix cell it falls in and why:
   - **High/medium confidence** → fix directly.
   - **Low confidence + trivial fix** (< 5 lines, no interface change) → fix it.
     The cost of a safe no-op is near zero; the cost of missing a real bug is not.
     "Low-risk" is a reason TO fix, not a reason to defer.
   - **Low confidence + complex/risky fix** → flag with category.
   When flagging, categorize as: `uncertain diagnosis`, `complex fix`,
   `needs design decision`, or `pre-existing gap`. The orchestrator uses
   these categories to triage.
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

## Comment mode

When the dispatch prompt says **COMMENT MODE**, do not edit files, commit, or push.
Instead, collect all findings and post them as a single GitHub PR review with inline
comments.

### Procedure

1. **Hunt normally** — read every changed file in full, apply all 7 dimensions, use
   sequential thinking for disposition decisions. The only difference is the output path.
2. **Collect findings** as you go. Each finding needs: file path (relative to repo root),
   line number, dimension tag, confidence level, and description.
3. **Still categorize on two axes** — confidence × complexity. In comment mode, `fixed`
   becomes `would fix` (high/medium confidence, trivial change) and flagged findings keep
   their category.
4. **Post a single PR review** with all findings as inline comments:

```bash
gh api "repos/OWNER_REPO/pulls/PR_NUMBER/reviews" \
  --method POST --input - <<'REVIEW'
{
  "event": "COMMENT",
  "body": "## Phase 4: Bug Check\n\nN bugs found across M files.\nConfidence: A high, B medium, C low\n\n---\n*🔍 ship-check · bug-check · MODEL_ID*",
  "comments": [
    {
      "path": "src/file.ts",
      "line": 612,
      "body": "**[D1]** Description refs `vault_find_orphans`, should be `vault_get_backlinks`\n\nThe description says \"find notes with broken links\" but `vault_find_orphans` finds notes with no *incoming* links. `vault_get_backlinks` is the correct tool for outgoing link validation.\n\n*Would fix (trivial, high confidence)*\n\n---\n*🔍 ship-check · bug-check · MODEL_ID*"
    }
  ]
}
REVIEW
```

Replace `OWNER_REPO`, `PR_NUMBER`, and `MODEL_ID` with values from the dispatch prompt.

5. **If 0 findings**, skip the API call — report "0 findings" to the orchestrator only.
6. **Footer on every comment.** Append `\n\n---\n*🔍 ship-check · bug-check · MODEL_ID*`
   to the review body AND each inline comment body.
7. **Format each inline comment body** as:
   - Bold dimension tag: `**[D1]**`, `**[D3]**`, etc.
   - One-line description of the bug
   - Evidence: quote the description sentence, trace the code path, explain the mismatch
   - Suggested fix (code snippet when possible)
   - Disposition: `Would fix (trivial, <confidence>)` or `Flagged: <category>`
   - Footer (see above)
