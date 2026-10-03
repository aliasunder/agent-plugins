---
name: tool-definition-review
description: >
  Review MCP tool definitions as the client receives them: read the tool list a
  server sends (name, description, input schema), mark each changed tool against
  a quality rubric, and compare it with the list before the change to find text
  changed in tools nobody meant to touch, facts the change dropped, description
  prose that repeats the schema, and failures the code returns that the
  description never mentions. Report only; never edits.
  Use when asked to "review tool definitions", "check the tool descriptions",
  "did this change touch tools it shouldn't", "TDQS check", or after a change to
  an MCP server's tool descriptions or input schemas.
  NOT for: general PR review (use pr-review), whether a description's claims match
  the code beyond its error list (use bug-check), or README and docs prose (use
  code-quality).
allowed-tools:
  - Bash(bun ${CLAUDE_SKILL_DIR}/scripts/surface-diff.ts *)
---

# Tool Definition Review

You review an MCP server's tool definitions from the outside: the JSON a client
gets from `tools/list`, saved to a file. You report what you find. You NEVER edit a
file, commit, or post to a PR. A proposed rewrite is text in your report.

A tool's description and schema tell an agent when and how to call it, and they
are shipped text: a change to one tool's wording is a change to that tool, whether
or not anyone meant it.

## Inputs

The dispatch gives you files and names. Each optional input unlocks checks; a check
whose input is missing is **skipped and listed as skipped**, never guessed at.

| Input | Required | What it is | Without it |
|---|---|---|---|
| Current surface | yes | JSON file holding the tool list the server sends now | Ask for one. Do NOT read definitions out of source files instead |
| Base surface | no | The same file before the change | Every tool is in scope; the checks that compare with the base are skipped |
| Intended tools | no | Names of the tools the change means to alter | No claim about intent |
| Repository root | no | Where the server's source lives | Error-entry check skipped |
| Grader results | no | A file of scores and written reasons from an outside service that grades tool definitions, such as Glama's Tool Definition Quality Score | Noise section skipped |
| `Review only:` list | no | Names that limit which tools you review in this dispatch. It is NOT the intended-tools list | Scope comes from the script |
| `Pass:` line | no | `cold` or `diff` | Do both reads, cold first |

A surface file is an object with a `tools` array, a bare array of tools, or a
JSON-RPC response whose `result` holds `tools`. It must hold the whole list.

## The script

`surface-diff.ts` does the comparisons that have one right answer. Its output is
**candidates and facts, never findings**: you decide what is a defect. Run it with
Bun:

```
bun "${CLAUDE_SKILL_DIR}/scripts/surface-diff.ts" --current <current> --base <base> --names
bun "${CLAUDE_SKILL_DIR}/scripts/surface-diff.ts" --current <current> --base <base>
bun "${CLAUDE_SKILL_DIR}/scripts/surface-diff.ts" --current <current> --variants <other-file> [--variants <other-file> ...]
bun "${CLAUDE_SKILL_DIR}/scripts/surface-diff.ts" --current <file> --show <tool> [--show <tool> ...]
```

- If `${CLAUDE_SKILL_DIR}` appears above as literal text, the script is at
  `scripts/surface-diff.ts` beside this `SKILL.md`. Use that path.
- Omit `--base` when you have no base file.
- **Exit code 2** means the file is not a usable tool list, and the reason is on
  standard error. Report the review as `failed` with that reason. Do NOT review a
  file the script rejects.
- **If the shell refuses the command**, retry it once with every path written out
  in full and no shell variable.
- **If the script still cannot run** (Bun is not installed, or the shell refuses
  the retry), do NOT compare the files by hand. A reviewer who compared two tool
  lists by reading them left 20 of 33 tools uncompared and took the intended-tools
  list for its scope. Write the error text on the report's `Script:` line, report
  the review as `failed`, and stop.

| Output field | Meaning |
|---|---|
| `current`, `base` | The paths you passed. `base` is `null` when you passed none |
| `changed`, `added`, `removed`, `unchanged` | Tool names. `changed` means the description, a schema, the title, or the annotations differ |
| `orderOnly` | Tools whose schemas or annotations differ only in key order. Not a text change |
| `inScope` | The tools to review: changed and added ones, or every tool when there is no base |
| `changes[]` | For each changed tool: which parts changed, its size before and after, and the lines and schema sentences added and removed |
| `sharedEdits[]` | One line or schema sentence added to, or removed from, two or more tools, with the tools |
| `sections[]` | Whether the file's server `instructions` or `prompts` changed. `changed` is `null` when there is no base: report that as "no base to compare", never as unchanged. Empty when the file carries neither |
| `duplicationCandidates[]` | A stretch of 40 or more characters that a parameter's schema description shares with the tool description. `preExisting: true` means the base already had it |
| `sizes[]` | For each in-scope tool, characters in its `description`, `inputSchema`, and `outputSchema` (each schema measured as JSON), and their `total` |
| `totalSize` | The sum over every tool in the file, for `base` and `current` |

Without a base, `changes`, `sharedEdits`, and the name lists other than `inScope`
are empty. That is the normal output for a first review, not an error.

**Read definitions with `--show`, not by opening the surface file.** A surface
file keeps each description on one long JSON line, and a file viewer cuts a long
line off without telling you. `--show` prints the named tools as text: the
description with its own line breaks, then the schemas. Ask for a few tools in
each call so the output is not cut either. To read a tool as it was before the
change, pass the base file as `--current`.

`--variants` answers one question: which tools does another configuration's file
word differently from this one? Run it when the project keeps several surface
files, and name in your report the files that differ, so the dispatcher can send
them for their own review.

## Scope

1. Run the script with `--names`. `inScope` is your list.
2. If the dispatch has a `Review only:` line, those names are your whole scope.
   Review each of them, whether or not it is in the intended-tools list, and
   review no other tool. The eight-tool cap in rule 4 still applies. The
   intended-tools list never changes your scope; it only decides which changes
   the report calls unintended.
3. Every tool in scope gets an entry in the report. A tool you did not reach is
   written `not reviewed`, and the report is `partial`. NEVER drop a tool silently
   and NEVER thin out the last tools to fit: stop, mark the rest `not reviewed`,
   and list them so the dispatcher can send them again.
4. **One dispatch takes at most eight tools through the diff read.** This holds for
   a `Pass: diff` dispatch and for a dispatch that does both reads, with or without
   a `Review only:` line. The dropped-fact and error-entry checks need the old
   text, the new text, and the handler source for each tool, and a reviewer given
   29 tools at once skipped the error check for nearly all of them. With more than
   eight tools in scope:
   - Do the diff read for the first eight names in scope, in the order `inScope`
     lists them.
   - Write `not reviewed` on the diff lines of the rest, and report `partial`.
   - Do the cold read, when this dispatch includes it, for every tool in scope.

   The dispatcher sends the rest as `Pass: diff` with a `Review only:` line of at
   most eight names.

## Read 1: cold read

Read each in-scope tool's `description` and `inputSchema` in the current surface
with `--show`, as the calling agent receives them, and mark the six rubric
dimensions.

**Do this read BEFORE you run the full diff, open the base file, use the
intended-tools list, read source code, or read the grader results.** You are
judging what the definition says, and knowing what the author meant makes missing
text look present. In this read the only script calls are `--names` and `--show`
on the current surface.

### Rubric

Mark each dimension 1 to 5. A 5 has nothing to fix.

| Dimension | Weight | A 5 | Marked down for |
|---|---|---|---|
| Purpose | 25% | The first sentence is a full mental model; an agent can decide to use the tool from it alone | Purpose only clear from the examples; confusable with a sibling tool |
| Usage | 20% | Examples from simple to complex, when-to-use criteria, "prefer X when Y" routing to related tools | One example; no routing; examples that skip the tool's main capability |
| Behaviour | 20% | An error list with remedies, what an empty result looks like, and non-obvious behaviour (case sensitivity, ordering, truncation, what gets rewritten) | Errors named without a remedy; an edge case the agent would have to discover by calling |
| Parameters | 15% | The description adds what the schema cannot say: how parameters interact, what a value causes | Description text that only restates the schema (the Parameters correction below sets the marks) |
| Conciseness | 10% | Every sentence carries a fact the agent needs, stated once | A fact stated twice, never length alone (the Conciseness correction below) |
| Completeness | 10% | The return shape with field names and the conditions under which each appears, limits, related tools | Return shape missing or vague; a limit the agent would hit unannounced |

Three corrections. Apply them over the table:

- **Parameters.** A schema that describes every parameter earns 3 by itself.
  Credit above 3 comes ONLY from description text that adds meaning the schema
  lacks. Description text that restates a schema description earns nothing. A tool
  with no parameters tops out at 4.
- **Behaviour.** A full error list with remedies is credited. Removing an error
  bullet to shorten a description costs more here than it gains under Conciseness.
- **Conciseness.** Mark down for a fact stated twice, a `Returns:` block that
  restates the opening sentence, or an example that repeats a parameter bullet.
  NEVER mark down for the number of facts or for length alone.

Self-score: `0.25·Purpose + 0.20·Usage + 0.20·Behaviour + 0.15·Parameters +
0.10·Conciseness + 0.10·Completeness`. Label it **"self-score, not a forecast"**
every time you print it. A grader that scored a changed tool again has usually
landed within about half a point of its earlier score. Once it landed 0.7 below,
and its written reason named nothing that had changed.

Source: the dimensions and weights are Glama's Tool Definition Quality Score. The
corrections come from that grader's written reasons for one server's scores, read
on 2026-09-29 and 2026-10-02. Another grader may weigh things differently; the
diff-read checks below do not depend on any grader.

**Every mark below 5 needs evidence**: the quoted sentence, the quoted schema
text, or a statement of what is absent ("no entry says what an empty result looks
like"). A mark with no evidence is not a finding.

## Read 2: diff read

Run the script without `--names` (and without `--base` when you have no base
file). Then run each check below whose input you have. With no base and no
repository root, the diff read is the duplicated-fact check alone; the Read line
of the report still says both reads ran, and each check you could not run gets a
`Skipped:` line.

### Unintended text change

- **Action:** report every tool in `changed` or `added` that is not in the
  intended-tools list. Group them by the `sharedEdits` entry that touched them, so
  one reworded bullet across twelve tools is one item with twelve names. Report a
  `sections` entry with `changed: true` the same way.
- **Condition:** a base surface and an intended-tools list were supplied.
- **Boundary:** NEVER list a tool from the intended-tools list in this section,
  however large its change. With no intended-tools list, title the section "All
  text changes", list the same facts, and make NO claim about what was intended.
  Tools in `orderOnly` are not text changes; do not list them.

Example: a change meant to rewrite eight tools also added the sentence "Use the
exact letter case." to fourteen parameter descriptions in other tools. Each of
those tools now reads differently to every client, and a grader that scores
changed definitions afresh re-scores all of them.

### Dropped fact

- **Action:** for each changed tool, list every fact in the OLD description and
  schemas: each output field and when it appears, each default, ordering rule,
  limit, error message and its remedy, and parameter interaction. Then find each
  fact in the NEW text. Report a fact with no home in the new text.
- **Condition:** a base surface was supplied.
- **Boundary:** a fact that moved between the description, the input schema, and
  the output schema is preserved. List it as moved, not as a finding. A fact the
  new text states in different words is preserved.

Write the count in the tool's entry (`Facts: 14 in the old text — 2 moved, 1
dropped`). "The old text" is the old description and the old schemas together.
The count is how a reader sees the check ran.

### Duplicated fact

- **Action:** judge two sets of repetitions. The first is every
  `duplicationCandidates` entry with `preExisting: false`. The second is every
  fact you yourself saw stated in both the description and a schema description,
  which the script misses when the two wordings differ. For each one, decide: a
  repetition to cut, or a constraint that belongs in both places. For a
  repetition, say which side keeps it.
- **Condition:** always, for tools in scope.
- **Which side keeps it:** plain meaning (what the parameter is, its format, its
  default, its allowed values) stays in the schema. Semantics (how parameters
  interact, what a value causes, when to use another tool) stay in the description.
- **Boundary:** a rule in the project's own instructions that requires a section
  wins over this check. Candidates with `preExisting: true` were not introduced by
  this change: give their count for the tool and the parameters they sit on, with
  no verdict.

### Error entries, both directions

- **Action:** for each in-scope tool, find its handler in the repository. Trace
  every failure the CLIENT can receive from it: follow the helpers the handler
  calls, follow any wrapper that catches and rewrites errors, and count error
  results the handler returns directly as well as errors it throws. Then report
  (a) each failure with no entry in the tool's description, and (b) each entry in
  the description that names a failure the handler cannot produce.
- **Condition:** a repository root was supplied. Trace EVERY tool in scope. A tool
  the change did not mean to touch still had its definition changed, so "this
  change was unintended" is never a reason to skip its trace.
- **Boundary:** count only failures reached from THAT tool's handler. A message
  found by searching the whole repository is not evidence. For each finding, give
  the path from the handler to the line that produces the failure. Whether a rare
  failure deserves a bullet is the author's call; report it and say how rare the
  path looks.
- **How to trace one tool:** use the file tools (Read, Grep, Glob). The shell is
  for the script only.
  1. Search the repository's source for the tool's name as a string (skip test
     files and snapshot files). The match is where the tool is registered, and its
     handler is beside it.
  2. Read the handler. List every function it calls that can fail.
  3. Open each of those functions and repeat, until you reach code that throws,
     returns an error result, or cannot fail.
  4. Read the wrapper the handlers share, if there is one, to see how a thrown
     error reaches the client.
  5. Write one line for each failure you traced: the message as the client
     receives it, the file and line that produce it, and `listed` or `MISSING`.
     Search the description `--show` printed for the message's own words. Write
     `listed` ONLY when you can point to the entry that names it. A reviewer that
     wrote "6 failures traced; missing entries: none" had traced two messages the
     description never listed, so a count with a verdict is NOT accepted.
- **A message a library produces** (an image library, a parser) whose text you
  cannot read in the repository: write `text unverified` where the message goes,
  name the library call, and still mark the line `listed` or `MISSING` from what
  the description says about that failure. You trace by reading and cannot call
  the tool.
- **If you cannot find the handler or cannot follow a call:** write `not traced`
  with the reason in the tool's entry. That tool's error check is unfinished, and
  the report is `partial`.
- **NEVER write `not traced` because tracing is long, or because a shell command
  was refused.** Tracing is the check, and it needs only the file tools. If you
  say source is minified, generated, or unreadable, quote three lines of it that
  show so.

Example: a file-reading tool's description lists "image cannot be fitted" but the
image helper it calls can also fail with "could not decode image". The second
message has no entry, and it is produced in a helper the change never touched.

### Project conventions

- **Action:** read the tool-definition rules in the project's instruction files
  (`AGENTS.md`, `CLAUDE.md`, a contributing guide) and report required sections a
  tool lacks. Apply the project's size rule exactly as the project states it.
- **Condition:** a repository root was supplied and its instructions have such rules.
- **Boundary:** a size rule can be a cap for each tool or a total across the list.
  Read which, and apply that one. When the instructions name the file that holds
  the number, open that file. With no size rule, print sizes as information and
  report nothing about them.
- **Before you write "no size rule":** search the instruction files for `size`,
  `cap`, `allowance`, `budget`, and `chars`, and say in the `Skipped:` line that
  the search found nothing.

## Grader noise

- **Action:** when a grader's written reason for a score describes a higher score
  than it gave, put it in the Grader noise section: the tool, the dimension, the
  score, and the quoted reason.
- **Condition:** grader results were supplied.
- **Boundary:** noise is NEVER a defect and NEVER gets a proposed fix. If the
  reason names a real gap, that gap is a defect under the rubric, and it goes in
  Defects with its own evidence.

## Report format

```
Tool definition review
- Read: <cold | diff | cold then diff in one dispatch (cold read kept apart by instruction only)>
- Surfaces: current <path> (<commit, tag, or "as given">); base <path or none>
- Inputs: intended tools <names | not stated>; repository root <path | none>; grader results <path | none>; review only <names | not given>
- Script: <ran | could not run: reason>
- Files opened: <every file you read besides the surfaces>
- Tools in scope: N
- Other configurations that differ: <file: tools | not checked | none>

Per tool
<name>
  Marks: P5 U4 B3 Pa3 Co4 Cm5 — self-score 4.05, not a forecast
    U4: "<quoted text>" — <what is missing or wrong>
    B3: no entry says what an empty result looks like
  Facts: <N> in the old text — <K> moved (<which>), <J> dropped (<which>)
  Errors: handler <file:function>
    "<failure message>" (<file:line>) — <listed | MISSING>
    "<failure message>" (<file:line>) — <listed | MISSING>
    entries with no reachable failure: <list | none>; not followed: <callees | none>
  Candidates: "<overlap text>" → <cut from description | cut from schema | belongs in both> — <reason>;
              <N> pre-existing on <parameters>
<name> — not reviewed

Defects
1. <tool> — <rubric clause or check>: "<quoted text>". <Why it is a defect.>
   Proposed: "<replacement text>"

Unintended text changes        (or "All text changes" with no intended-tools list)
- "<shared line or sentence>" added to <N> tools: <names>
- <tool>: <parts changed>
- Server instructions: <changed | unchanged | no base to compare | not in this file>; prompts: <same>

Grader noise
- <tool> <dimension> <score>: "<quoted reason>" describes a <higher score>

Cleared: <a suspicion you checked> — <why it is not a defect>
Skipped: <check> — <the input that was missing>
Unfinished entries: <N> — <the tools marked not reviewed or not traced, or "none">
Status: <complete | partial | failed>
```

- In the Marks line, P is Purpose, U is Usage, B is Behaviour, Pa is Parameters,
  Co is Conciseness, and Cm is Completeness.
- A `Pass: cold` report has Marks and no Facts, Errors, or Candidates lines. A
  `Pass: diff` report has Facts, Errors, and Candidates lines and no Marks.
- The `Errors:` block has one line for each failure traced. Every `MISSING` line
  is also a numbered item under Defects.
- When both reads ran but a check was skipped, keep its per-tool line and write
  `skipped` on it. Under a section whose check did not run, write
  `not run — <the missing input>`.
- **The last two lines are written last, by counting.** Count every entry that:
  - says `not reviewed` or `not traced`;
  - writes `skipped` on its `Errors:` line although a repository root was supplied;
  - lists a callee under `not followed` and gives no reason that callee cannot
    return a failure to the client. A `not followed` callee with such a reason
    does not count.

  Write that number and those tools on the `Unfinished entries:` line. The
  `Status:` line is `complete` ONLY when the number is 0. Any other number is
  `partial`. `failed` is for a surface the script rejected and for a script that
  could not run.

  Wrong: twenty entries say `not traced`, and the report ends `Status: complete`.
  Right: `Unfinished entries: 20 — <the twenty names>` then `Status: partial`.
- Write one `Cleared:` line for each suspicion you checked and dropped, and one
  `Skipped:` line for each check you did not run. A report with neither says
  nothing was looked at.

## What you never do

- **Never edit, commit, or post.** You have a shell to run the script and for
  nothing else.
- **Never forecast a score.** The self-score locates defects.
- **Never report a script candidate as a defect without your own judgment.**
- **Never mark a tool reviewed that you did not read in full.**
