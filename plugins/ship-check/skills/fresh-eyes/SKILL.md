---
name: fresh-eyes
description: >
  Read code as someone who has never seen the codebase — no conventions, no
  history, no attachment — and report every place a newcomer pauses: a name that
  had to be traced, a loop or branch with no stated reason, a term never
  introduced, a comparison that had to be reasoned about, a comment that promised
  something the code did not do. Report only; never edits. Use when asked to
  "read this as a stranger", "fresh eyes on this", "would a newcomer understand
  this", or to compare two candidate versions of a function on readability.
  NOT for: convention compliance (use code-quality), correctness or bug hunting
  (use pr-review / bug-check), or test review (use test-audit).
---

# Fresh Eyes

A readability read with no review apparatus. The other review skills load the
project's conventions and standards before they read a line; this one deliberately
does not. Its output is what a newcomer experiences, so the people who hold the
conventions can decide what to do about it.

## Scope

- **The dispatcher names the files.** Read each named file **whole**, not the diff
  hunks — a newcomer reads the file, and without a diff you cannot tell which
  functions changed anyway. A narrower scope in the dispatch (one file, one
  function, two versions of a function) overrides.
- **No file list → ask.** Never guess the scope from the directory tree, and never
  run the diff yourself; you have no shell.
- **One level of callee, on need.** When a function cannot be understood without
  opening something it calls, open that one thing, and record that you had to.
  Do not keep following the chain — that you needed the chain is the finding.
- **Test files are out of scope** unless the dispatcher names them.

## Set conventions aside

Instruction files for the project may have been shown to you before this skill.
They describe what the project wants. Your job is to report what a stranger
experiences, so:

- Do not open AGENTS.md, CLAUDE.local.md, standards notes, or memory.
- Do not cite a convention in a finding, for or against.
- Do not decide whether a pause is "allowed" by the project. Report it.
- Do not read commit messages, PR descriptions, or tests to learn what the author
  meant. What the code says is all you have, which is the point.

## How to read

For each function in scope, read it once, top to bottom, and write down each pause
**as it happens**, not after you have finished and understood everything. A pause is
any point where you stopped to work something out. The kinds that recur:

| Pause | Example |
| --- | --- |
| A name whose value you had to trace to know what it holds | `stem` holding `Projects/deep`, a whole path minus its extension |
| A loop, retry, bound, or branch whose reason is not stated where it sits | a `for` loop up to 100 with no comment saying why it exists or what happens at 101 |
| A term used in a comment or name that you were never given | "collision-free", "free name" |
| A comparison or guard you had to reason about to trust | `> 0` on the result of `lastIndexOf` |
| A manual computation where you wondered whether a built-in already does it | splitting a file path with `lastIndexOf(".")` and two `slice` calls |
| A comment or name that promised something the code did not do | a doc comment saying a fallback is not cached when the code caches it |
| A value built two different ways for the same purpose | one branch interpolates a prefix, another joins it |

Boundary: a pause is something that stopped **you**, reading cold. If you only
notice a thing because you know a rule about it, that is not a pause.

## What to record

Per function, in order:

1. **Each pause:** the line, what stopped you, what you assumed or opened to get
   past it, and one line on what would have helped — a comment, a name, a split.
   A pointer, not a rewrite.
2. **A verdict:** could you change this function safely from what you read? Yes or
   no, one sentence why.

A function with **no pauses is still listed**, as read, so a clean report is
distinguishable from an unread one.

## What not to do

- No edits. You have no Edit, Write, or shell tools; do not work around that.
- No severity beyond **stopped** (had to leave the line to continue) and
  **slowed** (worked it out in place).
- No rewrites, no proposed diffs.
- No correctness hunting. If you trip over what looks like a bug, say so in one
  line and move on; someone else owns that.
- No convention judgments, no test review.

## Report format

```
Fresh eyes complete:
- Reviewed at: <SHA or "working tree">
- Files read: <list>
- Functions read: N (M with pauses)
- Callees opened to understand a function: <list or none>

Per function:
<file>:<function> — L<n> stopped: <what stopped me> · assumed: <…> · would help: <…>
<file>:<function> — L<n> slowed: <…> · assumed: <…> · would help: <…>
<file>:<function> — no pauses

Verdicts:
<function>: safe to change / not safe — <why>
```

When comparing two versions of a function, produce the per-function block for
each, then one line saying which version produced fewer and lighter pauses. Do not
pick a winner on any other basis.

## Comment mode

None. This skill never posts to a PR. When it runs inside a pipeline, the
dispatcher owns what happens to the pauses, including any PR posting and its
attribution footer.
