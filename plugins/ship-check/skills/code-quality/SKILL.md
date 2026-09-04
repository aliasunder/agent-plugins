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

2. **Code standards + preference recall**: Discover the standards notes first — the
   set grows and hardcoded lists go stale:
   `vault_search({ query: "code standards", filters: { tags: ["code-standards"], type: "reference", properties: { lifecycle: "living" } } })`
   Then `vault_read_note` the pass-relevant results (currently typescript and
   logging-observability), plus any newer note matching the repo's language/stack.
   When the diff includes markdown docs or substantial comment changes, also read
   the docs standards note (currently `Reference/code-standards-docs`) — it grounds
   dimension 7.
   Then recall the dated evidence trail for the change's domain — it surfaces
   preferences newer than the notes: `vault_memory_recall({ query: "<change domain>" })`

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
- **Markdown docs are in scope for dimension 7 only** — changed `.md` files (README,
  guides, ARCHITECTURE, env templates) get the concision pass, not the code dimensions.
- **Same-pattern sweep**: when a trigger fires on changed code, scan the rest of the
  file — and grep for sibling call sites — for other instances of the same pattern,
  including pre-existing ones. Copy-paste inheritance and partial manual cleanups both
  leave siblings behind (observed: an author's own fix of a flagged pattern corrected
  1 of 3 identical sites). This is a targeted expansion: sweep only the specific
  pattern that fired, not all dimensions.

## What to check

Work through the changed files. For each, check these dimensions in order:

### 1. Naming
- Variables describe what the value IS, not shorthand (`availableHeadings` not
  `available`, `searchText` not `needle`)
- Function names state what they DO specifically (`collectWikilinksFrom` not `collect`)
- Callback params are explicit (`orphan` not `o`, `entry` not `e`)
- SQL aliases are descriptive (`element` not `je`)
- Booleans named for the affirmative state (`hardLinksSupported` not `hardLinksUnsupported`)
- **No side-effect prefixes on value-returning functions.** When callers consume the
  return value (`const engine = await ensurePdfEngine()`), a prefix like `ensure*`,
  `check*`, `init*`, or `setup*` misstates the point — name the return
  (`getPdfEngine`, `resolveConfig`, `loadIndex`). Boundary: keep the side-effect name
  when every call site ignores the return — a true ensure-invariant function

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
- **State the why once, tersely.** Keep the context that makes a non-obvious helper
  or constraint make sense; flag restated justification chains, padding with
  derivable detail, and facts already documented elsewhere (PR description, platform
  docs, AGENTS.md). One statement of the why, then stop. Trim-safety boundary: see
  dimension 7 — compression must never merge two distinct claims into one
- **Durable rationale only.** Transition history ("renamed from X") and design
  narratives arguing rejected alternatives age badly — comments state the
  forward-looking constraints a future editor needs (why this shape, what breaks if
  changed); migration context and the design argument belong in the PR description
- **Inline dense regex → named constant.** A regex with character classes,
  alternation, or quoting semantics sitting inline in a function body gets hoisted
  to a module-level named constant with a doc comment stating what it matches
  (e.g. `/for="?([^";,]+)"?/i` inline → `FORWARDED_FOR_CLIENT` with a comment on
  its capture-stop semantics). Boundary: trivial single-use patterns (`/^\d+$/`)
  stay inline
- Comments sit directly above the line they explain and lead with the claim about
  that line, mechanism second

### 5. Simplicity
- Simple code over clever code — fewer moving parts, fewer lines when achievable
- Each line should say what it does on its own
- Working is the floor, not the bar — ask whether a simpler structure exists
- A reader should not need to pause to understand what the code does
- **No imperative collection-building where a declarative expression works.**
  A for-loop that pushes into an array, sets on a Map, or adds to a Set is the
  mutable version of `.map()`, `new Map(arr.map(...))`, or `new Set(arr.map(...))`.
  When the loop body is a straight transform — no early exits, no conditional
  pushes, no accumulator logic beyond the single output — the declarative form
  is shorter, immutable, and harder to misread.
  The trigger: a `for` loop whose body's only side effect is `.push()`,
  `.set()`, or `.add()` on a collection declared immediately before the loop.
  Check whether the loop has conditional logic (if/continue/break) — if it
  doesn't, or if the only conditional is a filter, the loop is a `.map()` or
  `.filter().map()`.
  Boundary: the imperative form IS appropriate when (a) the loop body has early
  exits or conditional pushes that don't map to a single `.filter().map()`
  chain, (b) the accumulator is more complex than append (e.g. dedup-by-key
  with a seen set), or (c) the loop mutates external state beyond the
  collection being built.
  Wrong:
  ```
  const levels = new Map()
  for (let i = 0; i < sizes.length; i++) {
    levels.set(sizes[i], i + 1)
  }
  return levels
  ```
  Right:
  ```
  return new Map(sizes.map((size, index) => [size, index + 1]))
  ```
- **No index-based iteration when `for...of` works.** `for (let i = 0; ...)`
  with `arr[i]` access is justified when the index is used for something beyond
  element access — positional output, adjacent-element comparison by offset, or
  subarray slicing. When the index only serves to access the current element,
  `for...of` is cleaner and eliminates array-bounds guards the type checker
  forces on `arr[i]`.
  The trigger: a `for (let i = ...)` loop where `i` appears only in `arr[i]`
  expressions (or `arr[i - 1]` for adjacent comparison). If the adjacent
  comparison can be replaced by a state variable (e.g. `let lastY = prev.y`),
  `for...of` with the state variable is simpler.
  Boundary: index-based IS appropriate when (a) the index is used in the output
  (position labels, offset calculations), (b) the loop skips or jumps indices
  (`i += 2`, `i = nextIndex`), or (c) the loop needs simultaneous access to
  more than two adjacent elements.
- **Built-ins over manual string surgery.** When code splits, slices, or indexes a
  string that has a formal structure — URL, file path, query string, header, date —
  check the runtime's stdlib for a parser of that structure (`URL.parse`,
  `URLSearchParams`, `path.*`, date libraries) and flag the manual version.
  Delimiter surgery silently mishandles edge inputs the parser already covers
  (fragments, encoding, empty segments).
  Wrong: `req.originalUrl.split("?")[0] ?? req.originalUrl`
  Right: `URL.parse(req.originalUrl, "http://localhost")?.pathname ?? req.originalUrl`
  Boundary: don't flag genuinely lexical operations (a delimiter the format defines
  as flat, e.g. splitting a CSV cell) or formats with no stdlib parser — there a
  documented regex is the floor.
- **Fallbacks that exist only to satisfy the type checker are a smell.** When a
  `?? fallback` or guard protects a state the runtime cannot produce (e.g.
  `split(...)[0] ?? x` under `noUncheckedIndexedAccess` — `split` never returns an
  empty array), the construct is wrong, not the guard: look for an API whose types
  match reality. Boundary: keep the guard — with a comment saying so — when the
  impossible state is only conventionally impossible (depends on a remote contract
  or unvalidated input).
- **Hand-rolled conversion beside an established helper.** When changed code
  performs a conversion or formatting inline (`String(error)`, manual message
  assembly), grep for an existing codebase helper covering it; 3+ existing call
  sites make it the idiom — flag alignment (`describeError(error)` over
  `String(error)` when the codebase converts errors that way everywhere else).
  Boundary: skip when the helper's semantics genuinely differ from what the site
  needs.

### 6. Module conventions (if project has module layering rules)
- Dependency direction respected
- Exports match the project's style (namespace objects vs named exports)
- Utils/ admission bars met

### 7. Docs & comment concision

Applies to changed markdown docs (README, guides, ARCHITECTURE, env templates) and
to doc comments in code. Correct-but-padded prose is a finding: verbosity that ships
gets trimmed manually in follow-up commits, at real cost.

**Trim-safety boundary — applies to every trigger in this dimension: compression
must never merge two distinct claims into one.** Verify each compressed sentence
against the code before proposing it — a trim that collapses "A self-heals; B does
not" into "self-heals" is a correctness bug, not a style win. When unsure whether a
clause is load-bearing, keep it and flag the uncertainty instead of trimming.

- **Rationale duplication across artifacts** — a comment or doc section restating
  design narrative that already lives in the PR description, commit message, or
  another doc. Keep the load-bearing constraint; cut the justification story.
- **Doc-comment padding** — sentences restating what the signature or adjacent code
  already shows ("Returns the raw string unchanged"), or explaining the benign case
  at length. Boundary: a one-line gloss of genuinely non-obvious behavior stays.
- **Use-case narration in config templates** — env/template comments narrating
  scenarios ("useful when X is off or you use plugin Y") instead of stating the
  setting's behavior, default chain, and value shape. Scenarios belong in the
  user-facing guide.
- **Sibling-doc depth duplication** — the same mechanics explained at full depth in
  multiple docs (README + deploy guide + template + architecture doc). One canonical
  home carries the depth; siblings get a one-sentence concept + link. Boundary: a
  short restatement is fine where the audience can't follow a link (offline
  templates, generated output).
- **Repeated chain or caveat** — a precedence chain or caveat spelled out in full at
  every mention (tool-description opener AND parameter doc AND README). State it
  once per artifact; later mentions reference it.
- **Filler lead-ins** — scaffolding sentences that add nothing ("What this looks
  like in practice:"). Delete them; start with the content.
- **Wall paragraphs** — one paragraph carrying multiple topics (feature list + edge
  case + mechanism + config). One topic per paragraph; use a list for enumerable
  facts. Boundary: a paragraph is not a wall for being long — the trigger is
  multiple topics, not line count.
- **Wrong-level rationale** — prose justifying a decision by incidental mechanics
  ("its dependency profile is compatible with the folder's lint rules") instead of
  the conceptual reason ("the two modules are a unit"). The facts are correct but
  explain the wrong why — flag for the conceptual framing.

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

**Output honesty (both modes):**

- **State what you reviewed.** The summary names the PR head SHA actually
  reviewed — a review that doesn't say what it checked is indistinguishable
  from one that checked nothing. It also lets the orchestrator cross-check
  what this phase actually saw against the delta-review baseline it records
  itself at Phase 4 close.
- **Close with proof of dismissal.** One line per suspicion you seriously
  considered and dropped, with the reason it doesn't bite — or "none". The
  clean-bill claims are part of the review: without them, "no findings" could
  mean a clean diff or an unexamined one, and the reader can't tell which.

## Comment mode

When the dispatch prompt says **COMMENT MODE**, do not edit files, commit, or push.
Instead, collect all findings and post them as a single GitHub PR review with inline
comments.

### Procedure

1. **Review normally** — check all dimensions (naming, structure, error handling,
   comments, simplicity, module conventions, docs & comment concision). The only
   difference is the output path.
2. **Collect findings** as you go. Each finding needs: file path (relative to repo root),
   line number, category tag, and description with the suggested fix.
3. **Post a single PR review** with all findings as inline comments:

```bash
gh api "repos/OWNER_REPO/pulls/PR_NUMBER/reviews" \
  --method POST --input - <<'REVIEW'
{
  "event": "COMMENT",
  "body": "## Phase 2: Code Quality\n\nN findings across M files. Reviewed at <HEAD_SHA>.\n\nDismissed: <proof-of-dismissal one-liners — or \"none\">\n\n---\n*🔍 ship-check · code-quality · MODEL_ID*",
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

Replace `OWNER_REPO` and `PR_NUMBER` with values from the dispatch prompt. Replace
`MODEL_ID` with your own model ID (from your system prompt).

4. **If 0 findings and no dismissals**, skip the API call — report "0 findings"
   to the orchestrator only. With 0 findings but cleared suspicions, post a
   body-only review carrying the dismissal list — that is the artifact that lets
   a PR reader tell a clean diff from an unexamined one.
5. **Footer on every comment.** Append `\n\n---\n*🔍 ship-check · code-quality · MODEL_ID*`
   to the review body AND each inline comment body.
6. **Format each inline comment body** as:
   - Bold category tag: `**[naming]**`, `**[structure]**`, etc.
   - One-line description of the issue
   - Suggested fix as a code snippet (use GitHub's `suggestion` fence when the fix is
     a direct replacement — this gives the PR author a one-click "Apply suggestion" button)
   - Footer (see above)
