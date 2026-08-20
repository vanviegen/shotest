---
name: shotest
description: |
    ShoTest is a visual testing wrapper built around Playwright Test. If `shotest` is a devDependency of this project, you must provide visual test specs for all new/modified features you create. Just write Playwright specs in `tests/`, but import from `shotest` what you would normally import from `@playwright/test`. Important: try to keep visual drift (visual changes that were not (implicitly) requested) to a minimum, as the human will need to review any changed screenshot. If you need further guidance, load this skill.
---

# UI Testing Guidance

After running `npx playwright test`, results are written flat into `test-results/`:

- <SPEC_BASE>.json: one per spec file (e.g. `login.spec.json`), listing its tests and their steps in order; each step names its screenshot by HASH and records the events that happened on it in order — actions, assertions, checks, describe-hints, named screenshots and browser console output — with message, source line, duration and the viewport box of the element involved. Consecutive events on an unchanged page share one step/screenshot.
- <HASH>.png: a step's screenshot (you can view this image for visual/layout verification); HASH is derived from the pixel content, so identical frames share one file
- <HASH>.body.html / <HASH>.head.html: DOM snapshots (useful for debugging and for writing test selectors)
- <TEST_NAME>/error.txt: error message + stack trace (in case of an error), in Playwright's per-test directory

To find the screenshot for a step, read the spec's JSON file first and look up the step's `image` hash.

When you create new UI features:
1. Make sure they are tested by `tests/*.spec.ts` Playwright test files.
2. Run the tests.
3. If you are capable of viewing images, review images at some carefully selected points in the test flow, in order for you to see your new/changed features.
4. Fix any issues (test or visual; humans like things to look good!) and repeat from 1 until satisfaction.

What follows is the README.md from `shotest`:

