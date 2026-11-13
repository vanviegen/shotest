# ShoTest in TPS

TPS runs each task's agent in a container of its own, built from the project's `Containerfile.dev`, and merges a task once the project's test (`tps.test`) passes on the task's work combined with the latest default branch. With ShoTest set up as below, that test passes only once the tests pass and the user has accepted every visual change.

## Setting it up

In `Containerfile.dev` (with the home of the image's user for `/home/dev`):

```dockerfile
# The docker CLI, talking to the socket TPS serves at $DOCKER_HOST.
RUN curl -fsSL https://download.docker.com/linux/static/stable/$(uname -m)/docker-29.9.1.tgz \
      | tar xz -C /usr/local/bin --strip-components=1 docker/docker

# The review app, served by `shotest review`.
EXPOSE 3847

ENV SHOTEST_CACHE_DIR=/home/dev/.shotest-cache SHOTEST_IGNORE=.tps-commit-message
LABEL tps.cache="/home/dev/.shotest-cache"

LABEL tps.test="npm install && npx shotest test && /tps/guest-tool show-user-text 'Visual changes await your review in the **3847** tab: accept them or comment on them, then press **Apply**.' && trap '/tps/guest-tool show-user-text' EXIT && npx shotest review"
```

- The docker CLI has `shotest test` run in the pinned Playwright container, so that it renders like the baselines.
- `SHOTEST_CACHE_DIR` names where ShoTest keeps the results of tests that passed, and `tps.cache` (add the path to the ones it already names) has TPS share that directory between all tasks and the test that merging runs: no test runs twice on the same source tree.
- `SHOTEST_IGNORE` keeps the commit message TPS asks for out of that source tree, so writing it after the tests ran does not make them run again when merging.
- `tps.test` runs every test, then the review: with nothing to review, `shotest review` ends right away, and otherwise it ends once the user applies the review, failing if a visual change was not accepted. While it runs, the user is told where to find it; the trap removes that text once it ends.

In `.gitignore`, ignore `test-results/`. Commit `test-accepted/`: running tests leaves it alone, and TPS commits what a review accepts.

## Working on a task

1. Run only the tests your change is likely to affect, in one go (`test-results/` holds the last run only):

   ```sh
   npx shotest test tests/login.spec.ts tests/signup.spec.ts
   ```

   Do not run `tps.test` yourself.

2. Once the work is ready, have the user review what those tests show:

   ```sh
   /tps/guest-tool show-user-text 'Visual changes await your review in the **3847** tab: accept them or comment on them, then press **Apply**.'
   /tps/guest-tool start rvw 1800 npx shotest review
   /tps/guest-tool show-user-text
   ```

   The review takes as long as the user does: on exit code 124 it is still running, and `/tps/guest-tool await rvw 1800` waits some more. Do not leave it running when your turn ends (`/tps/guest-tool stop rvw`): the review of `tps.test` needs its port. It exits with 0 when everything is accepted. Otherwise it prints the tests that were not accepted and the user's comments: address them, run the tests again, and have them reviewed again.

3. Leave the rest to `tps.test`, which TPS runs when the task is merged. The merged code is what has to pass, and no run of yours can vouch for that. It runs every test (those that passed on that very source tree come from the cache), and the user accepts what else changed, which TPS commits. If a test fails or the user does not accept everything, the task comes back to you with the test's output: the failed tests, or the tests not accepted and the user's comments.
