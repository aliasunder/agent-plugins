# plan-check

Pre-implementation plan review — the upstream counterpart to
[ship-check](../ship-check/). Ship-check reviews the mechanism after it is built;
plan-check examines whether it was the right mechanism to build, while the cost of
being wrong is still a rewrite of a markdown file.

## Why it exists

The founding case: a row cap on OAuth client registrations was planned,
implemented, and passed all four ship-check phases (9 code-level findings, all
mechanism-correct). Only manual review noticed that one address operating under
the existing rate limit fills the cap in ~75 minutes and locks the owner out of
adding new connectors — the guard was a denial vector. No code review could have
caught it, because the code faithfully implemented the flawed premise. Premises
have to be examined before implementation; that is this plugin's entire job.

## Components

| Component | Type | Role |
|-----------|------|------|
| `plan-reviewer` | Agent | Fresh-eyes critique of a plan, task note, or plan-mode output. Findings only — never edits, never implements. |
| `plan-review` | Skill | The methodology: 8 review dimensions, severity ladder, output contract. Usable standalone/inline on surfaces without agents. |

## Review dimensions

1. **Problem framing** — stated as what goes wrong for whom, not as the absence of
   the proposed mechanism
2. **Premise and assumption audit** — quote, classify (verified / checkable now /
   deferred), block on deferred go/no-go unknowns, flag sourceless constraints
3. **Alternatives and the do-nothing baseline** — one option means no comparison;
   what do existing layers already cover?
4. **Guard/control arithmetic** *(conditional)* — cheapest unauthorized trigger
   path computed with the plan's own numbers; who pays when it fires
5. **Concurrent writers and async state** — every other writer of touched state;
   proxy-for-truth conflations; what survives the reset
6. **Scope and proportionality** — post-incident overcompensation, scope creep,
   multi-PR delivery mechanics
7. **Verification plan quality** — runnable checks that can fail; destructive test
   steps get their own blast-radius analysis
8. **Structure and open-question hygiene** — task-note conventions; go/no-go
   unknowns separated from user-judgment questions

Dimensions and severity rules are distilled from a corpus of real planning
failures and conventions in the maintainer's project history (plans, task notes,
and session logs), not from first principles.

## Usage

```
/plan-check:plan-review                 # inline, reviews the plan in context
```

Or dispatch the agent for fresh-eyes review:

> Use the plan-reviewer agent to review plans/my-feature.md

Like ship-check, the agents load personal context (vault-cortex MCP, fable-mode
skill) and won't work for anyone else without adaptation — the structure and
review dimensions are the reusable part.
