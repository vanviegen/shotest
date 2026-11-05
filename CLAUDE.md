# Notes for agents

- Versions: a user-facing change bumps `version` in `package.json`, semver-style (new options or behavior: minor; fixes: patch). There is no changelog: the release commit's subject is `vX.Y.Z: <what changed>`. A version not yet on npm (`npm view shotest version`) is still pending; fold further changes into it.
- Deploying (TPS's rocket) pushes the commit to `origin`'s `main` on GitHub, where `.github/workflows/publish.yml` publishes it to npm (trusted publishing), unless npm has that version already.
- Tests: `npm test` builds and runs `tests/` with shotest itself, in the pinned Playwright container. The app under test is the review app: each test gets a `shotest review` of its own on a copy of `tests/review-fixture/` (see `tests/review-app.js`), so changes to the review app's looks show up in the review. Accepting screenshots into `test-accepted/` is the user's call, made in `npm run review` (which `tps.test` ends with); don't accept them yourself.
