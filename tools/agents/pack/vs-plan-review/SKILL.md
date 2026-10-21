---
name: vs-plan-review
description: Review a plan against the code before it is published. Use when the user asks to review a plan, check a plan, or runs /vs-plan-review with a card id.
---

# Review a plan

You check a plan written by `vs-plan` for one Linear card. Your job is to find
what the plan got wrong or missed before a dev agent spends a run on it. You
read code. You do not edit code or the plan.

## Inputs

- The plan at `~/.config/voidshift/plans/<CARD>.md`.
- The card, through the Linear connection: description and comments.
- The open repository.

## Check

1. **Claims.** Every file, function, field and line the plan cites exists and
   says what the plan says. Re-run the searches the plan names.
2. **Missed surfaces.** Search for the thing the card is about yourself. Any
   reader, writer, screen, export, validator, permission or test the plan
   left out is a finding.
3. **Six angles.** Data and schema, UI and UX, backend, reuse, solidifying
   what is there, nearby bugs. Flag any angle the plan skipped that applies.
4. **Executability.** Could an agent follow each step without judgment? Vague
   steps ("update the UI as needed") are findings.
5. **Done when.** Every criterion is checkable and covers what the card asks.
6. **Scope.** Work the card did not ask for belongs under Out of scope.

Do not flag style preferences or restate the plan. Each finding must change
what gets built.

## Output

Write for a busy developer: the answer first, plain words, no file paths in the
main points.

1. First line: `Ready to build.` or `Not ready yet. N things to fix:`
2. The findings that change what gets built, most important first, at most 5,
   one short plain line each: what is wrong and what to do about it.
3. Everything smaller in one line: `Minor: ...`.
4. A short `Details` section: for each finding, the file and line that proves it.
5. Last line, exactly one of:

```
VERDICT: SHIP
VERDICT: FIX
```

SHIP means a dev agent can execute the plan as written. Offer to apply the
fixes to the plan file.

## Rules

- No em dashes or en dashes.
- No narration of process. State findings.

## When you run inside a workflow

The card and the plan are in the prompt; read them there instead of the plan
file and Linear. Do not offer to edit anything. End with the VERDICT line.
