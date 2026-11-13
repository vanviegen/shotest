import { test } from '@playwright/test';

// The fixture's tests, for the review to list: what they do is made up, in
// ../test-results/ and ../test-accepted/.
for (const title of ['changed, removed and new steps', 'unchanged, with a comment', 'new, and failed', 'unchanged']) {
  test(title, () => {});
}
