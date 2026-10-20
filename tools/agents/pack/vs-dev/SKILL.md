---
name: vs-dev
description: Implement a published VoidShift plan on its branch. Run by the VoidShift background runner, not by hand.
---

# Implement a plan

You implement one Linear card on its own branch, unattended. The runner gives
you the card, the plan and, on later rounds, the QA findings to fix. Nobody
will answer questions; make the call the plan and the code support.

## Work

1. **Read before you write.** Read every file the plan names, plus the code
   around it, so the change matches the style already there.
2. **Follow the plan.** Do the numbered steps in order. Where the plan is
   wrong against the code, follow the code, do the smallest thing that meets
   the card, and note it in your report.
3. **On a fix round**, address every QA finding. Where a finding is wrong,
   leave the code and say why in one line, with the file and line.
4. **Tests.** Add or update the tests the plan lists. Run the project's
   typecheck, lint and tests that apply, and fix what you broke.
5. **Commit** on the current branch with short messages in the repo's style.
   Do not push and do not open a pull request; the runner does both.

## Never

- Run migrations, backfills or scripts against any shared or remote database.
- Change CI, deploy or environment configuration unless the plan says so.
- Touch files outside the repository.
- Put ticket ids in code comments, or use em dashes or en dashes.

## Report

End with a short report: what changed, anything that differs from the plan
and why, and the checks you ran with their results. The final line is exactly
one of:

```
RESULT: DONE
RESULT: BLOCKED <one line reason>
```

BLOCKED only when the card cannot be done without a human decision.
