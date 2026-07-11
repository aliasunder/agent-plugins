---
name: pr-monitor
description: >
  Monitor PR status — CI checks, review bot findings, unresolved conversations — and
  address + resolve bot comments. After pushing fixes, waits for and handles new bot
  review comments before declaring merge-ready.
  Use when asked to "check PR status", "monitor this PR", "check CI", "resolve PR
  comments", "address review comments", "mark conversations resolved", or when waiting
  on a PR to be merge-ready.
  NOT for: initial code review (use pr-review), post-merge testing (use verify), or
  reviewing the diff itself.
skills:
  - fable-mode
tools:
  - mcp__sequential-thinking__sequentialthinking
---

# PR Monitor

Follow Steps 1-5 in order. **You may NOT report merge-ready or "ship" until Step 5,
and Step 5 has prerequisites that reference every prior step.** Skipping ahead means
the prerequisites fail and you must go back.

This skill ALWAYS evaluates, replies to, and resolves bot review threads (qodo,
CodeRabbit) as part of the workflow. That is core, not optional.

## Step 1: Determine the PR

- If a PR number or URL is given, use that.
- If on a feature branch:
  ```
  gh pr view --json number,title,url,state,statusCheckRollup,reviewDecision,comments
  ```
- If no PR exists, say so and stop.

Record `owner`, `repo`, and PR `number` for API calls below.

## Step 2: Run a full status pass

Run all five checks. You re-run this exact step during follow-up (Step 4), so be
consistent.

### 2a. CI checks
```
gh pr checks <number>
```
Report: passed / failed / pending. For failures: `gh run view <run-id> --log-failed`.

### 2b. Review decision
```
gh pr view <number> --json reviewDecision,reviews,latestReviews
```
Report: approved / changes-requested / pending. List reviewers.

### 2c. Unresolved review threads
```
gh api graphql -f query='{
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: NUMBER) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved
          comments(first: 5) {
            nodes { author { login } body path position createdAt }
          }
        }
      }
    }
  }
}'
```
List each UNRESOLVED thread: author, file/line, summary, and classify as one of:
- **Bot** -- author is a known review bot (qodo-merge-pro, coderabbitai, etc.)
- **Claude** -- author is a human account but the comment body contains a Claude
  footer (see classification rules below)
- **Human** -- everything else

**Record the unresolved count** -- you compare it after follow-up in Step 4.

#### Claude comment detection

A comment is from another Claude instance if its body contains any of these strings
(case-insensitive, typically in the last few lines):
- `Claude Code`
- `Co-Authored-By: Claude`
- `Generated with Claude`

These comments come from human-owned GitHub accounts but were authored by a Claude
agent. They are classified separately so they can be auto-handled like bot comments.

### 2d. Bot findings outside inline threads

Inline threads are not the only surface bots use: Sourcery puts "Overall
Comments" in the review BODY, and qodo and others post PR-level issue
comments. Neither appears in `reviewThreads`, so a thread-only pass silently
misses them. Check both:

```
gh api repos/OWNER/REPO/pulls/NUMBER/reviews --jq '.[] | {id, user: .user.login, submitted_at, body}'
gh api repos/OWNER/REPO/issues/NUMBER/comments --jq '.[] | {id, user: .user.login, created_at, body}'
```

Identify bot-authored bodies that contain findings (issues, suggestions,
"Overall Comments") as opposed to pure summaries or status boilerplate.
Dedupe against 2c — a finding that also exists as an inline thread is
handled once, in the thread flow. Skip items already handled: compare
against the review/comment IDs recorded on prior passes and against your
own footer-marked replies. **Record the IDs of items you handle** so
follow-up passes don't re-litigate them.

### 2e. Merge readiness
Summarize blockers: failing CI, missing approvals, unresolved threads,
unanswered non-thread bot findings, conflicts.

## Step 3: Handle findings

### Bot threads (qodo, CodeRabbit, etc.)

For each unresolved bot thread, do ALL of these in order:

1. **Evaluate**: valid finding or false positive? Check against AGENTS.md conventions.

   **There are only two outcomes: valid or false positive.** Do NOT invent a third
   category. In particular:
   - **"False positive" means the finding is factually wrong** — the code pattern it
     describes does not actually exist, or the behavior it warns about cannot happen.
     "The code was already like this" is NOT a false positive — it's a valid finding on
     pre-existing code. If the finding describes a real issue (unsafe cast, missing
     validation, incorrect type), it is valid regardless of when the code was written or
     why it appears in the diff.
   - **"Pre-existing" is not a reason to skip.** If the PR touches the code path a
     finding describes — even if the underlying pattern existed before — it is in scope.
     A PR that widens a filter or adds a code path inherits the obligations of that path.
   - **Formatter-exposed code is in scope.** When prettier, eslint --fix, or any
     formatter brings pre-existing lines into the diff, and a bot flags something real
     about those lines, that is a valid finding — not a false positive. The formatter
     created an opportunity to fix it. Evaluate fix effort the same way you would for any
     valid finding: if the fix is straightforward, fix it now.
   - **"Out of scope" is not yours to declare.** Only the user decides scope. If a
     finding is valid and the fix is reasonable effort, fix it. If it's genuinely high
     lift (major refactor, new async boundary, architectural change), describe the effort
     and ask the user — don't defer it unilaterally.
   - **"Belongs in a separate PR" is not a valid disposition.** Assess the lift. If
     it's a few lines, fix it now. If it's large, present the tradeoff to the user.

2. **Report as a one-liner** before acting:
   ```
   Thread 1 (callback naming): Valid — AGENTS.md requires descriptive params → fixed
   Thread 2 (broken-link guidance): Valid — vault_find_orphans is wrong tool → fixed
   Thread 3 (truncated sentence): False positive — line 621 is complete
   ```

3. If valid: **make the code fix**. If the lift is unclear, assess it first (how many
   lines? does it need tests? does it change an interface?) and state it in the one-liner.
   Fix anything that's reasonable effort; only escalate to the user when the fix is
   genuinely high lift.

4. **Reply to the comment** -- do this BEFORE resolving, for EVERY bot comment.

   Since `gh` posts as the user's account, every reply MUST include an attribution
   footer. Read your model ID from your system context ("You are powered by the model
   named..."). The footer format is: `\n\n---\n*🔍 ship-check · pr-monitor · <model-id>*`

   ```
   gh api graphql -f query='mutation {
     addPullRequestReviewThreadReply(input: {
       pullRequestReviewThreadId: "THREAD_ID",
       body: "YOUR_REPLY\n\n---\n*🔍 ship-check · pr-monitor · MODEL_ID*"
     }) { comment { id } }
   }'
   ```
   - **Valid finding** -- reply explaining what you fixed:
     *"Fixed -- [brief description of the change and why].\n\n---\n🔍 ship-check · pr-monitor · MODEL_ID"*
   - **False positive** -- reply explaining why:
     *"This is intentional -- [reasoning].\n\n---\n🔍 ship-check · pr-monitor · MODEL_ID"*

5. **Resolve the thread** (AFTER replying):
   ```
   gh api graphql -f query='mutation {
     resolveReviewThread(input: {threadId: "THREAD_ID"}) {
       thread { isResolved }
     }
   }'
   ```

> **Never resolve a thread without replying first.** A silently resolved thread looks
> like the feedback was dismissed without reading. The reply provides context for anyone
> reviewing the PR history and is how the reviewer (human or bot) knows their comment
> was addressed.

### Claude threads (human account with Claude footer)

Handle the same way as bot threads -- evaluate, reply, fix if valid, resolve. These are
from another Claude instance and do not require user approval. Include in your reply
that you're addressing feedback from another Claude session, e.g.:
*"Addressed -- [description]. (Responding to Claude-authored review.)\n\n---\n🔍 ship-check · pr-monitor · MODEL_ID"*

### Bot findings without a thread (review bodies, PR-level comments — from 2d)

Evaluate each finding exactly like a bot thread — same valid/false-positive
rules, same fix-or-escalate bar. There is no thread to resolve, so the
disposition must land on the PR as a reply instead: post one `gh pr comment`
covering the findings you handled — name each finding, state
fixed/intentional with the reasoning, include the same attribution footer.
A finding answered nowhere on the PR is indistinguishable from one that was
never read.

### Human threads

Present each to the user. Do NOT auto-resolve human comments without explicit approval.
If the user provides a response, reply on their behalf and resolve.

### After handling all threads

If you fixed any code: stage, commit, push. Then **go to Step 4** -- this is mandatory.

If no fixes were needed and no code was pushed: **go to Step 5.**

## Step 4: Follow-up check after pushing (MANDATORY)

> **You are NOT done.** Bot review tools re-analyze the entire PR after every push.
> New comments arrive within 2-5 minutes. If you skip this step, those new comments go
> unresolved and you have failed the task.

"CI is green right now" means nothing if you just pushed -- bots haven't run yet.
Do NOT go to Step 5 without completing at least one follow-up pass after the last push.

### Procedure

1. Tell the user: *"Pushed fix(es). Waiting for bot reviews (~3 min)..."*

2. **Schedule a follow-up check.** ScheduleWakeup is available in all Claude Code
   sessions — `/loop` context is NOT a prerequisite. Call it:
   ```
   ScheduleWakeup(delaySeconds: 180, reason: "waiting for bot reviews after push",
     prompt: "/pr-monitor")
   ```

3. On wake: **re-run Step 2** (all five checks). Compare the unresolved thread count
   to what it was before pushing, and compare 2d's review/comment IDs against the
   ones you've already handled.

4. **New unresolved threads or new non-thread bot findings exist** -- go to Step 3
   (reply, fix, resolve, push). If Step 3 pushes more code, return here and repeat
   Step 4 from the top.

5. **Nothing new** -- go to Step 5.

### If ScheduleWakeup is not available

ScheduleWakeup is available in all Claude Code sessions. The fallback below applies
**only when the ScheduleWakeup tool call itself returns an error** — not when you
reason it "shouldn't be needed" or "the pipeline is finishing." If in doubt, call it —
a rejected tool call is cheap, a missed bot comment is not.

Never substitute your own judgment for this step. "CI was already green before I pushed"
and "bots already commented" are not reasons to skip — bots re-analyze the entire PR
after every push.

If `ScheduleWakeup` genuinely errors (tool not found, permission denied):
- Run an **immediate re-check** (Step 2) right after pushing -- this catches fast bots.
- If no new comments yet, tell the user: *"Bot reviews typically take 2-5 minutes. Run
  `/loop /pr-monitor` for continuous monitoring, or say 'check' when you want me to
  look again."*
- When the user responds, re-run Step 2.

## Step 5: Final report

**Prerequisites -- ALL must be true before you may report:**
- All CI checks passing (or only known-flaky / unrelated failures)
- All bot threads resolved (each one replied to before resolving)
- All non-thread bot findings (2d: review bodies, PR-level comments) evaluated and
  replied to on the PR
- If code was pushed during this run: at least one follow-up check (Step 4) completed
  after the most recent push with no new unresolved threads
- No new unresolved threads in the most recent status pass

If any prerequisite is not met, go back to the relevant step.

Report:
```
PR #<number> status:
- CI: all passing / N failing (names)
- Reviews: approved / pending / changes-requested
- Bot threads: all resolved (N handled, all replied to)
- Non-thread bot findings: N handled (review bodies / PR comments, all replied to)
- Claude threads: all resolved (N handled, all replied to)
- Human threads: N unresolved (listed above)
- Verdict: merge-ready / blocked by [specific blocker]
```

After reporting, **continue monitoring** — do not stop. "Merge-ready" is a status
report, not a termination signal. The user will say stop when they're done. If the
user doesn't respond, keep the monitoring loop running.

## Continuous monitoring

Continue monitoring after Step 5 — whether invoked via `/loop` or not:
- Call `ScheduleWakeup` with `delaySeconds: 240` (stays in prompt cache).
- On each wake, run Step 2. If new findings, handle via Steps 3-4.
- **Stop the loop only when:**
  - The user explicitly says stop (or said "check once" / "one-shot" at invocation)
  - The PR is merged or closed
- **Never auto-terminate** for any other reason — not after clean checks, not after
  silence, not because the user hasn't responded. The user may be away and expects
  monitoring to keep running until they return.

### Pipeline context

When invoked as part of a pipeline (e.g., ship-check Phase 5), the pipeline's other
phases being complete does NOT mean monitoring is done. Phase 5 outlives the pipeline.
Continue monitoring until the user explicitly says stop or the PR is merged/closed.

If you feel pressure to "wrap up" because a reporting template exists — that template
is a status snapshot, not a termination signal. Output the report, then continue the
monitoring loop.
