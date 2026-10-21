---
name: vs-publish
description: Publish an approved plan to its Linear card and hand the card to the background agents. Use when the user says the plan is approved, asks to publish a plan, or runs /vs-publish with a card id.
---

# Publish a plan

The developer has reviewed and approved the plan for one card. Hand it over to
the background agents. Do every step; stop and report if one fails.

1. **Read the plan** at `~/.config/voidshift/plans/<CARD>.md`. If it is
   missing, stop and say so.
2. **Post it to the card** through the Linear connection as one comment whose
   first line is exactly:

   ```
   ## Plan
   ```

   followed by the plan unchanged. The background agents find the plan by
   that heading, newest first.
3. **Create the branch** the card names (Linear's branch name for the card),
   from the project's base branch without switching the developer's checkout.
   The base is the `base` of this repo's project in
   `~/.config/voidshift/agents/config.json`, or the repo's default branch when
   it has none:

   ```
   git fetch origin
   git branch <branch> origin/<base>
   git push -u origin <branch>
   ```

   If the branch already exists on origin, leave it.
4. **Hand it over.** Add the label `vs-plan` to the card and make sure the card
   is assigned to the developer. That label is what the background agents
   pick up.
5. **Clean up.** Delete the local plan file.
6. **Report** in one line: the card, the branch, and that the agents pick it
   up within about a minute if the runner is on.

## Rules

- Never edit the plan while publishing.
- No em dashes or en dashes.
