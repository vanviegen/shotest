# Notes for agents

- Versions: a user-facing change bumps `version` in `package.json` and the matching `shotest` entry in `test-project/package-lock.json`, semver-style (new options or behavior: minor; fixes: patch). There is no changelog: the release commit's subject is `vX.Y.Z: <what changed>`. A version not yet on npm (`npm view shotest version`) is still pending; fold further changes into it.
- Deploying is `scripts/deploy.sh` (TPS's deploy): it publishes to npm unless that version is already there, handing the user, through ask-human, npm's web login and then the page that confirms the publish with their security key. npm only offers the latter on a terminal, hence the `script` pseudo-terminal.
- Tests: `npm test` builds and runs `test-project/` in the pinned Playwright container. A new or changed test's screenshots are accepted into `test-project/test-accepted/` (via `npm run review`) and committed with it.
