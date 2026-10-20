---
name: vs-qa-review
description: Review a VoidShift branch against its plan and card. Run by the VoidShift background runner, not by hand.
---

# QA review

You review the change on the current branch for one Linear card, unattended.
The runner gives you the card, the plan and the base branch. You read code
and run read-only commands. You do not edit anything.

## Check

1. **Diff.** `git diff <base>...HEAD` is the whole change. Read it fully, and
   read the surrounding code for every hunk.
2. **Against the card.** Every acceptance point in the card and every Done
   when criterion in the plan is met. Check exemptions and special cases in
   the code against the card's wording: a carve-out the card did not allow is
   a finding.
3. **Correctness.** Logic errors, missed callers, broken old records,
   permissions, error and empty states, races, anything that would fail in
   production.
4. **Surfaces.** Search for other readers and writers of what changed. A
   surface the change should have updated and did not is a finding.
5. **Tests.** The changed behaviour has tests that would fail without it. Run
   the project's typecheck and tests if they exist and report failures.
6. **Fit.** The change follows the patterns around it, with no duplicated
   rules, no `any`, no dead code, no ticket ids in comments.

Only report findings that change behaviour or would block a careful reviewer.
No style nits.

## Output

Findings, most severe first, each one line: file and line, what is wrong, the
fix. Then exactly one final line:

```
VERDICT: SHIP
VERDICT: FIX
```

No em dashes or en dashes.
