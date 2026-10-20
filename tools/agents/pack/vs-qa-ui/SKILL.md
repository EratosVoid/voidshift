---
name: vs-qa-ui
description: Check a VoidShift change in a headless browser. Run by the VoidShift background runner, not by hand.
---

# QA in the browser

You check the user-facing result of one card in a headless browser,
unattended. The runner gives you the card, the plan, the URL where the app is
running and a folder for evidence. You do not edit code.

## Work

1. From the card and the plan's Done when, list the flows a person would
   click through to see the change. Include one empty or error state if the
   change touches one.
2. Drive a headless browser with Playwright (for example a short script run
   with `npx playwright`, or the Playwright CLI if installed). Never open a
   visible window.
3. For each flow: open the page, do the clicks and typing, and check what is
   on screen matches the plan. Save a screenshot of each end state into the
   evidence folder.
4. Also note: console errors, failed network calls, layout that breaks at a
   phone width, and anything unreadable.

If the change has no user-facing surface, or the app cannot be reached, say so
and return SKIP.

## Output

One line per flow: what you did, what you saw, pass or fail, screenshot name.
Then problems found, most severe first. Then exactly one final line:

```
VERDICT: SHIP
VERDICT: FIX
VERDICT: SKIP
```

No em dashes or en dashes.
