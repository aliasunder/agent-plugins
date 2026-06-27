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

Run all four checks. You re-run this exact step during follow-up (Step 4), so be
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

### 2d. Merge readiness
Summarize blockers: failing CI, missing approvals, unresolved threads, conflicts.

## Step 3: Handle findings

### Bot threads (qodo, CodeRabbit, etc.)

For each unresolved bot thread, do ALL of these in order:

1. **Evaluate**: valid finding or false positive? Check against AGENTS.md conventions.

   **There are only two outcomes: valid or false positive.** Do NOT invent a third
   category. In particular:
   - **"Pre-existing" is not a reason to skip.** If the PR touches the code path a
     finding describes — even if the underlying pattern existed before — it is in scope.
     A PR that widens a filter or adds a code path inherits the obligations of that path.
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

4. **Reply to the comment** -- do this BEFORE resolving, for EVERY bot comment:
   ```
   gh api graphql -f query='mutation {
     addPullRequestReviewThreadReply(input: {
       pullRequestReviewThreadId: "THREAD_ID",
       body: "YOUR_REPLY"
     }) { comment { id } }
   }'
   ```
   - **Valid finding** -- reply explaining what you fixed:
     *"Fixed -- [brief description of the change and why]."*
   - **False positive** -- reply explaining why:
     *"This is intentional -- [reasoning, reference to AGENTS.md if relevant]."*

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
*"Addressed -- [description]. (Responding to Claude-authored review.)"*

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

2. **Schedule a follow-up check.** Call `ScheduleWakeup`:
   ```
   ScheduleWakeup(delaySeconds: 180, reason: "waiting for bot reviews after push",
     prompt: "<the /loop prompt>")
   ```

3. On wake: **re-run Step 2** (all four checks). Compare unresolved thread count to
   what it was before pushing.

4. **New unresolved threads exist** -- go to Step 3 (reply, fix, resolve, push). If
   Step 3 pushes more code, return here and repeat Step 4 from the top.

5. **No new unresolved threads** -- go to Step 5.

### If ScheduleWakeup is not available

If invoked standalone (without `/loop`) and `ScheduleWakeup` fails or is unavailable:
- Run an **immediate re-check** (Step 2) right after pushing -- this catches fast bots.
- If no new comments yet, tell the user: *"Bot reviews typically take 2-5 minutes. Run
  `/loop /pr-monitor` for continuous monitoring, or say 'check' when you want me to
  look again."*
- When the user responds, re-run Step 2.

## Step 5: Final report

**Prerequisites -- ALL must be true before you may report:**
- All CI checks passing (or only known-flaky / unrelated failures)
- All bot threads resolved (each one replied to before resolving)
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
