---
name: security-audit
description: >
  Run a whole-repository security audit to find vulnerabilities before outside
  researchers file advisories: make a clean checkout of the default branch,
  collect the known advisories and open security cards, run two ship-check:security-auditor
  agents in parallel (access: the network-facing sign-in and HTTP surface; data:
  what an authenticated caller or a crafted input file can do beyond its grant),
  merge and spot-check their reports into one ranked table, triage each finding,
  and keep every finding out of public channels until it is fixed. Works from
  Claude Code, Codex and OpenCode.
  Use when asked for a "security audit", to "audit this repo for
  vulnerabilities", "find vulnerabilities before researchers do", "I don't want
  to keep getting these advisories", or after a security advisory arrives.
  NOT for: ordinary PR/diff review (pr-review or security-review; ship-check
  owns its conditional security checkpoint), dependency CVE scanning, or
  testing systems the user does not own.
---

# Security Audit

You run the audit from the user's session. Two auditor agents do the reading
and local reproduction in parallel; you prepare their inputs, check their
evidence, and present one ranked result. The auditors' method is the
repo-security-review skill, which each auditor has preloaded.

Every finding this skill produces is an undisclosed vulnerability. From the
moment the auditors return until a fix ships, keep the findings in private
channels only (step 7).

## Step 1: Coordinate

When the project configures an available peer-coordination adapter, use it to
coordinate detached worktrees and local processes with other sessions in the same
repository. Otherwise proceed with owned per-profile checkouts and scratch paths.
NEVER put a finding in a peer message, except to the peer fixing that finding.

## Step 2: Pin the target

1. Name the repository and branch. The default is the current repository and
   its remote default branch:
   `gh repo view --json nameWithOwner,defaultBranchRef --jq '.nameWithOwner + " " + .defaultBranchRef.name'`
   Audit another branch only when the user names it.
2. Fetch it: `git fetch origin <branch>`.
3. Record the full SHA from git's own output, never typed from memory:
   `git rev-parse origin/<branch>`.
4. Pick the scratch directory: the scratchpad directory the system prompt
   names, or else a new one from `mktemp -d /tmp/probe-security-audit-XXXXXX`.
   Copy the printed path into later commands; shell variables do not survive
   between tool calls.
5. Make a separate clean detached checkout for each profile:
   `git worktree add --detach <scratch>/audit-access-<full SHA> <full SHA>` and
   `git worktree add --detach <scratch>/audit-data-<full SHA> <full SHA>`.
   Verify each with `git -C <checkout> rev-parse HEAD` and
   `git -C <checkout> status --porcelain`; require the recorded SHA and no output.
   Run this from the repository or from the session's own worktree. Do NOT use
   `git -C <another checkout>`: a worktree-isolated session refuses it.
6. Create one probe directory per auditor, outside the audit checkout:
   `mkdir -p <scratch>/security-audit-<full SHA>/access <scratch>/security-audit-<full SHA>/data`.

NEVER point an auditor at the user's working tree. The auditors install
dependencies and start processes in the checkout they are given, and only the
detached checkout is safe for that.

## Step 3: Collect the known issues

1. List the repository's security advisories in every state:
   `gh api repos/<owner>/<repo>/security-advisories --paginate --jq '.[] | "\(.ghsa_id) | \(.state) | \(.severity) | \(.summary)"'`
   Draft and triage advisories need admin or security-manager access. If the
   call fails, record the error text and pass it to the auditors in place of
   the list.
2. Use known issues and security context supplied by the caller. When the project
   configures an issue source, retrieve relevant issues through that source.
   Keep identifiers and descriptions for authentication, authorization, injection,
   leaks, limits, exposure and secrets. Record lookup errors verbatim; without
   supplied issues or a configured source, record `none supplied; no issue source configured`.
3. Pass both lists to each auditor, so it marks a matching finding as a
   duplicate instead of reporting it as new.

## Step 4: Dispatcher guidance

**Read this section BEFORE starting a `security-auditor`.** An already-running
auditor never relaunches itself or changes its model or effort.

1. **Model and effort.** Read the bundled ship-check skill's Execution section
   and resolve its **Adversarial review** class for the active runtime. Explicit
   user controls win. Use its dedicated-role controls, guidance lookup, portable
   fallback and unsupported-choice behavior; record the source or fallback.
2. **Tell the user the cost before starting.** A whole-profile audit can take
   roughly 15 minutes and a few hundred thousand tokens per auditor. State the
   selected profiles, model and effort in one line, and start within the audit
   the user authorized.
3. **Start one fresh dedicated auditor per selected profile.** Standalone audits
   select both `access` and `data`; start both before waiting on either. The
   ship-check checkpoint selects only affected profiles. Give each its own
   checkout and scratch directory, including when both run in parallel.

   | Runtime | Dedicated role |
   |---|---|
   | Claude Code | `Agent({ subagent_type: "ship-check:security-auditor", model, effort, description: "Security audit <profile> — <model> / <effort>", prompt: "<dispatch>" })` |
   | Codex | `spawn_agent({ agent_type: "ship-check:security-auditor", task_name: "security_audit_<profile>_<suffix>", fork_turns: "none", model: "<model>", reasoning_effort: "<effort>", message: "Security audit <profile> — <model> / <effort>\n<dispatch>" })` |
   | OpenCode | `subagent({ agent: "ship-check--security-auditor", description: "<label>", prompt: "<dispatch>", model: "<verified provider/model#variant>", background: false })` |

   Resolve the Codex task name to a unique lowercase name, including the selected
   profile and a suffix for this dispatch. Native Codex/OpenCode roles come from
   the user's maintained plugin translators.
   A missing dedicated role or a narrower instruction forbidding agents blocks
   independent coverage. Report the missing role or instruction and the next
   action; NEVER substitute a generic, inline or inherited-context reviewer.
4. **Give each auditor every field below.** The dispatch is its whole briefing.

```text
Profile: <access | data>
Audit checkout: <scratch>/audit-<access | data>-<full SHA>
SHA: <full SHA from git rev-parse>
Review base: <full review-base SHA for a checkpoint | none for standalone>
Selected surface: <complete security paths and dependencies | whole profile for standalone>
Scratch: <scratch>/security-audit-<full SHA>/<access | data>
Known advisories:
<one line per advisory: GHSA ID | state | severity | summary, or the error text from step 3>
Known cards:
<one line per card: ^block-id — description, or "none">
Project context: <supplied security contracts, grants and known-issue details | none supplied>
Other auditor's scope: <other profile and selected surface | no parallel auditor; unaudited: other profile and surfaces>
Audit your profile of this repository per your preloaded repo-security-review skill.
Reproduce only against processes you start from the audit checkout on 127.0.0.1.
Return the full report as your final message.
```

## Step 5: Merge, check and rank

When every selected auditor has returned:

1. Merge the selected reports. Where both report the same flaw, keep one entry with
   the stronger evidence and name both sources.
2. Dedupe against the known issues. A finding an auditor marked `Duplicate of`
   stays out of the ranked table; list it under the table with its ID. A finding
   marked as the uncovered half of a known item stays in the table.
3. **Spot-check every High or Critical finding yourself before you present it.**
   Open each `file:line` in the audit checkout and confirm the code does what
   the finding says. Read the auditor's probe script in its scratch directory,
   then re-run it when it targets only a local process it starts itself. A
   finding the check does not confirm is downgraded or dropped, and you say so
   with the reason.
4. Present one ranked table, most serious in practice first:

   | # | Finding | Severity (CVSS) | Precondition | Fix size | Duplicate of |
   |---|---|---|---|---|---|

   Under it, list the duplicates you removed, then the union of both reports'
   "Could not check" lines. A missing, unfinished or materially incomplete report
   blocks coverage; never turn unexamined scope into an audited result. Point to
   the full reports for "Checked and found sound", and give the probe directories.

## Step 6: Triage and record

1. Report findings privately in rank order with recommended fixes and unresolved
   decisions. When the project configures an available triage adapter, use it
   within the caller's authorized scope; create a task only when authorized.
2. When the project configures an available checkpoint adapter, record the
   repository, full SHA, model and effort, finding dispositions, issue IDs and
   retained probe paths there. Otherwise include that record in the private audit
   report; no external workflow adapter is required.

## Step 7: Keep findings private until fixed

**Condition:** any text that leaves the session while a finding is unfixed:
an issue, a PR title or body, a commit message, a review comment, a forum post,
a chat message in a public channel.

**Action:** keep each finding's attack path in private channels only: the audit
report, project-approved private issue records, or a draft repository security
advisory the user asks for. A fix PR and its commits describe the change and its
tests, never the attack.

**Boundary:** after the fix is released and its advisory is published, the
advisory carries the details. Never before.

Wrong (PR body for an unfixed timing leak in a webhook signature check):
"An attacker can recover a valid signature byte by byte by timing `POST /hooks`
requests, because the check compares with `==`."
Right:
"Compare webhook signatures in constant time. Adds tests for a wrong signature
of the right length."

NEVER put an unfixed finding's exploit path in a public issue, PR body, commit
message or comment, including a PR that bots or outside reviewers read.

## Step 8: Clean up

After the user has the audit results:

1. Confirm every owned test process has stopped and its loopback port has no
   listener. Remove each selected profile's checkout separately:
   `git worktree remove <scratch>/audit-<profile>-<full SHA>`.
   If git refuses, list what is left with
   `git -C <scratch>/audit-<profile>-<full SHA> status --porcelain`. Add `--force` only
   when every listed path is a dependency install or build output the auditors
   made; otherwise show the user the list and ask.
2. Run `git worktree prune`.
3. Tell the user where the probe files are: `<scratch>/security-audit-<full SHA>/`.
   Retain only evidence still needed for findings or hand-off, naming its paths.
   Probe files hold working exploit scripts; never put them in a repository.
   Use `land-task` when installed at landed closeout for this session's finished
   items; do not clean unrelated work.

## Boundaries

- Ordinary PR review belongs to pr-review. Ship-check selects complete security
  surfaces at its conditional checkpoint and reuses this dispatcher and method.
- NOT for dependency CVE scanning: Dependabot and `npm audit` (or the
  ecosystem's equivalent) cover that.
- NOT for systems the user does not own. The auditors reproduce only against
  local processes started from the audit checkout; NEVER point them at a
  deployed instance, the user's or anyone else's.
