---
name: shotest
description: |
    ShoTest is a visual testing wrapper built around Playwright Test. If `shotest` is a devDependency of this project, you must provide visual test specs for all new/modified features you create. Just write Playwright specs in `tests/`, but import from `shotest` what you would normally import from `@playwright/test`. Important: try to keep visual drift (visual changes that were not (implicitly) requested) to a minimum, as the human will need to review any changed screenshot. If you need further guidance, load this skill.
---

# UI Testing Guidance

After running `npx shotest test`, results are written flat into `test-results/`:

- <TEST>.json: one per test (e.g. `login-spec-logs-in-1a2b3c4d.json`), listing its steps in order; each step names its screenshot by HASH and records the events that happened on it in order — actions, assertions, checks, describe-hints, named screenshots and browser console output — with message, source line, duration and the viewport box of the element involved. Consecutive events on an unchanged page share one step/screenshot.
- <HASH>.png: a step's screenshot (you can view this image for visual/layout verification); HASH is derived from the pixel content, so identical frames share one file
- <HASH>.body.html / <HASH>.head.html: DOM snapshots (useful for debugging and for writing test selectors)
- <TEST_NAME>/error.txt: error message + stack trace (in case of an error), in Playwright's per-test directory

To find the screenshot for a step, read the test's JSON file first and look up the step's `image` hash.

Tests that already passed on the very same source tree are skipped; `npx shotest test --all` runs them anyway.

To hand visual changes to the human, run `npx shotest review` and wait for it to end: it prints the tests that were not accepted, with the reviewer's comments, the steps they are on and the paths of their screenshots. Address the comments, run the tests, and review again.

When you create new UI features:
1. Make sure they are tested by `tests/*.spec.ts` Playwright test files.
2. Run the tests.
3. If you are capable of viewing images, review images at some carefully selected points in the test flow, in order for you to see your new/changed features.
4. Fix any issues (test or visual; humans like things to look good!) and repeat from 1 until satisfaction.

## Setting up ShoTest in TPS

When the project is managed by TPS (there is a `/tps/guest-tool`), set it up in its `Containerfile.dev` so that work only lands once its visuals are accepted:

- Install the static docker CLI in the image, so `shotest test` runs in the pinned Playwright container (through TPS's `$DOCKER_HOST`) and renders like the baselines.
- `EXPOSE 3847`, the review app's port.
- `LABEL tps.test="npm install && npx shotest test && /tps/guest-tool request-human-views 3847 && trap '/tps/guest-tool request-human-views' EXIT && npx shotest review"`: the test then passes only once the tests pass and the user has accepted every visual change (with nothing to review, `shotest review` ends right away). While the review runs, TPS points the user at its page; the trap withdraws that request once it ends.
- Ignore `test-results/` in `.gitignore`, and commit `test-accepted/`, its `.passed` stamps included: TPS commits what the test writes, so a later run on the same tree skips what already passed.

What follows is the README.md from `shotest`:

