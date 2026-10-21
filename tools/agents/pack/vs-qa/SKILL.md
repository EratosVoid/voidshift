---
name: vs-qa
description: QA a VoidShift branch against its card and plan, CI first, then code review, then a usability check in a headless browser. Use when the user asks to QA a branch or card, or runs /vs-qa with a card id.
---

# QA

You check the change on the current branch for one Linear card. Three checks,
in order. You read code and run commands; you do not edit code.

## 1. CI

If the prompt already reports CI as passed, move on. Otherwise run
`gh pr checks` for the branch. Failing checks are findings; stop here and
report them, since review on a red build wastes everyone's time.

## 2. Code review

1. **Diff.** `git diff <base>...HEAD` is the whole change. Read it fully, and
   the surrounding code for every hunk.
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

## 3. Usability check

Only if the change has a user-facing surface.

1. Find how the project runs locally (README, `package.json` scripts). If it
   needs services you cannot start (databases, other apps, secrets), skip this
   check and say why in one line.
2. Start it from this checkout on a free port, in the background, and wait
   until it answers.
3. Drive a headless browser with Playwright (for example a short script run
   with `npx playwright`). Never open a visible window. For each flow in the
   plan's Done when: open the page, do the clicks and typing, check what is on
   screen. Note console errors, failed requests, layout that breaks at a phone
   width, and anything unreadable.
4. Stop everything you started.

## Output

Write for a busy developer: the answer first, plain words.

1. First line: `Passed.` or `Changes needed: N things.`
2. One line per check: CI, Code review, Usability, each passed, failed or
   skipped (with why).
3. The problems, most important first, at most 5, one short plain line each:
   what is wrong and what to do.
4. Everything smaller in one line: `Minor: ...`.
5. A short `Details` section with the file and line for each problem.
6. Last line, exactly one of:

```
VERDICT: SHIP
VERDICT: FIX
```

No em dashes or en dashes.
