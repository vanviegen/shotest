# Changelog

## 2.10.0 (2026-11-13)

- A review is applied in one go: mark tests as accepted or comment on their screenshots, then press Apply to write it all to `test-accepted/`, or Discard to drop it.
- Comments on screenshots are kept in `test-accepted/` until the test is accepted, so they reach whoever fixes it.
- `shotest review` ends once the review is applied or discarded, printing the tests that were not accepted and their comments. This replaces `--close-on-accept`. Reverting a baseline from the review app is gone.
- Tests that already passed on the same code are skipped. Their results come from a cache (`~/.cache/shotest`, or `SHOTEST_CACHE_DIR`) that every checkout of the project shares, so running tests never changes a file git tracks. `npx shotest test --all` runs them anyway.
- `SHOTEST_IGNORE` names files that no test depends on: changing them does not make tests run again.
- The review only offers to delete the baselines of tests that no longer exist. After running just a few tests, it used to offer those of every other test.
- The review app marks tests that ran on code that has changed since with a clock.
- Baselines are stored as one JSON file per test, so branches that accept different tests merge without conflicts. Older baselines are converted automatically.
- New command `shotest-prune-history`: removes old baseline images from git history, to shrink the repository.
- The skill for AI agents has a document of its own (`TPS.md`) on setting ShoTest up in TPS and working with it there.

## 2.9.0 (2026-11-04)

- A test now fails when its page throws an uncaught error. The new `failOnPageError` test option can make it fail on `console.error` output as well (`'console'`), or only record errors (`false`).
- The review app shows an unchanged step with the events of the current run only.

## 2.8.0 (2026-10-19)

- After a click, the mouse is moved off the page when the page changes under it, so screenshots no longer show hover styling on whatever landed under the pointer.
- The test container also runs on rootless, proxied and locked-down docker sockets.
- The review app outlines an event's element on the screenshot only while its row is hovered or pinned.

## 2.7.0 (2026-09-13)

- A screenshot of a page that never comes to rest now fails the test, naming what kept moving, instead of producing a frame that can never match its baseline.
- Scrolling counts as movement to wait for before a screenshot.
- `SHOTEST_DETECT_UNSTABLE` (or the `detectUnstable` test option) takes every screenshot twice and fails the test when the two differ: it finds animated images, videos and canvases that are drawn every frame.
