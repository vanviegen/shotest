import {
  expect,
  screenshot,
  splitIntoRoles,
  waitForVisualStability,
  suppressScreenshots,
  demoTap,
  demoType,
  demoPause,
  demoSwipe
} from 'shotest';
import { test, testUrl } from './review-app.js';

// ShoTest's capture side, exercised on the review app (see review-app.js).

// A line of text of the test's own, pinned over the review app, for tests
// that need an element to change at will.
const addProbe = (page) => page.evaluate(() => {
  const probe = document.createElement('p');
  probe.id = 'probe';
  probe.textContent = '0';
  probe.style.cssText = 'position:fixed;bottom:0;right:0;margin:0;padding:8px 12px;background:#fff;z-index:1000';
  document.body.appendChild(probe);
});

test('covers core wrapped actions and assertions', async ({ page }) => {
  await page.goto(testUrl('unchanged'));
  await page.getByRole('link', { name: 'new, and failed', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'new, and failed' })).toBeVisible();

  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  const input = page.getByRole('textbox');
  await input.fill('Alpha');
  await expect(input).toHaveValue('Alpha');
  await input.clear();
  await input.type('Beta');
  await input.press('End');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Beta')).toHaveCount(0);

  const scale = page.getByRole('slider');
  await scale.fill('0.5');
  await expect(scale).toHaveValue('0.5');

  // Form controls the review app lacks, pinned over it.
  await page.evaluate(() => {
    const form = document.createElement('form');
    form.style.cssText = 'position:fixed;bottom:0;right:0;padding:8px 12px;background:#fff;z-index:1000';
    form.innerHTML = '<select aria-label="Theme color"><option>sky</option><option>mint</option></select>'
      + ' <label><input type="checkbox"> Receive newsletter</label>';
    document.body.appendChild(form);
  });
  const select = page.getByLabel('Theme color');
  await select.selectOption('mint');
  await expect(select).toHaveValue('mint');
  const newsletter = page.getByLabel('Receive newsletter');
  await newsletter.check();
  await expect(newsletter).toBeChecked();
  await newsletter.uncheck();
  await expect(newsletter).not.toBeChecked();

  await page.getByRole('link', { name: 'unchanged', exact: true }).hover();
  await page.getByRole('link', { name: 'changed, removed and new steps', exact: true }).click();
  await page.waitForTimeout(300); // the panel scrolls to its first change 150ms after opening

  // Twice pinned is back to automatic.
  const accepted = page.getByRole('button', { name: 'accepted', exact: true });
  await accepted.dblclick();
  await expect(accepted).not.toHaveClass(/pinned/);

  await waitForVisualStability(page);
  await screenshot(page, 'core-final');
});

test('keeps a hover only while the clicked element\'s parent is under the mouse', async ({ page }) => {
  await page.setContent(`
    <style>button:hover { outline: 3px solid red; }</style>
    <div><button id="keep">Keep</button></div>
    <div><button onclick="this.parentElement.outerHTML = '<div><button id=new>New</button></div>'">Swap</button></div>
  `);

  await page.locator('#keep').click();
  await screenshot(page, 'kept-hover');
  await expect(page.locator('#keep')).toHaveCSS('outline-style', 'solid');

  await page.getByRole('button', { name: 'Swap' }).click();
  await screenshot(page, 'released-hover');
  await expect(page.locator('#new')).toHaveCSS('outline-style', 'none');
});

test('covers splitIntoRoles including repeated role names', async ({ page }) => {
  await page.goto(testUrl('unchanged'));

  const { alpha, beta } = await splitIntoRoles(page, 'alpha', 'beta', 'alpha');
  await expect(beta.getByRole('heading', { name: 'unchanged', exact: true })).toBeVisible();

  await alpha.getByRole('link', { name: 'new, and failed', exact: true }).click();
  await expect(alpha.getByRole('heading', { name: 'new, and failed' })).toBeVisible();

  await beta.getByRole('link', { name: 'unchanged, with a comment', exact: true }).click();
  await expect(beta.getByText('The outline should be blue')).toBeVisible();

  await screenshot(alpha, 'alpha-state');
  await screenshot(beta, 'beta-state');
});

test('covers demo helpers in non-video mode', async ({ page }) => {
  await page.goto(testUrl('unchanged'));

  await demoTap(page, page.getByRole('link', { name: 'unchanged, with a comment', exact: true }));
  await expect(page.getByText('The outline should be blue')).toBeVisible();

  await page.getByRole('button', { name: 'Comment', exact: true }).first().click();
  await demoType(page, page.getByRole('textbox'), 'DemoUser');
  await expect(page.getByRole('textbox')).toHaveValue('DemoUser');
  await demoPause(page, 50);
  await page.getByRole('button', { name: 'Cancel' }).click();

  const shot = page.locator('img').first();
  await demoSwipe(page, shot, 'right', 120);
  await expect(shot).toBeVisible();

  await screenshot(page, 'demo-final');
});

test('supports describe hints and screenshot suppression', async ({ page }) => {
  await page.goto(testUrl('unchanged'));

  await suppressScreenshots('Open the failed test', async () => {
    await page.getByRole('link', { name: 'new, and failed', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'new, and failed' })).toBeVisible();
  });

  page.describe('Verify the error is shown');
  await expect(page.getByText('Error', { exact: true })).toBeVisible();
});

test.describe(() => {
  test.use({ busySelector: '.busy-marker' });

  test('captures wait while busySelector matches', async ({ page }) => {
    await page.goto('/');
    await addProbe(page);

    // The busy marker holds past the 500ms settle cap; the content change
    // lands only as it clears, so the settle must outwait the marker.
    await page.evaluate(() => {
      const marker = document.createElement('div');
      marker.className = 'busy-marker';
      document.body.appendChild(marker);
      window.setTimeout(() => {
        document.getElementById('probe').textContent = 'ready';
        marker.remove();
      }, 700);
    });

    const start = Date.now();
    await waitForVisualStability(page);
    expect(Date.now() - start).toBeGreaterThan(600);
    await expect(page.locator('#probe')).toHaveText('ready');
  });
});

test('logs page-level commands as events without screenshots', async ({ page }) => {
  // All of these queue a 'page' event instead of capturing; they should show
  // up beneath the next capture (the expect below), dimmed in the review app.
  await page.setViewportSize({ width: 500, height: 700 });
  await page.goto('/');
  await page.goto('/?variant=1');
  await page.goBack();
  await page.goForward();
  await page.reload();
  await expect(page.getByText('with visual changes')).toBeVisible();
});

test('passes without screenshots when only using plain page methods', async ({ page }) => {
  await page.goto('/');

  const title = await page.title();
  if (title !== 'Overview · ShoTest') {
    throw new Error(`Expected page title to be "Overview · ShoTest", got ${JSON.stringify(title)}`);
  }
});

test('captures browser console messages', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(() => {
    console.info('console info before increment');
    console.warn('console warning before increment - this text is very long and should not cause the step box to grow beyond the width of the screenshot');
  });

  await page.getByText('Start reviewing (2)').click();

  await page.evaluate(() => {
    console.error('console error before final screenshot');
  });

  await screenshot(page, 'console-final');
});

test('an uncaught page exception fails the test', async ({ page }) => {
  test.fail();
  await page.goto('/');
  await addProbe(page);
  await page.evaluate(() => { window.setTimeout(() => { throw new Error('uncaught in the page'); }); });
  await expect(page.locator('#probe')).toHaveText('0');
});

test('captures screenshots for locator reads and timed waits', async ({ page }) => {
  await page.goto('/');
  await addProbe(page);

  await page.evaluate(() => {
    const probe = document.getElementById('probe');
    probe.textContent = 'before';
    window.setTimeout(() => {
      probe.textContent = 'after';
    }, 50);
  });

  const value = page.locator('#probe').first();
  const before = (await value.textContent())?.trim() ?? '';
  await page.waitForTimeout(120);
  const after = (await value.textContent())?.trim() ?? '';

  expect(before).toBe('before');
  expect(after).toBe('after');
});

test('negative assertions on absent elements complete quickly', async ({ page }) => {
  await page.goto('/');

  // Each of these goes through the step-overlay path after the underlying
  // operation succeeds. Since the element does not exist, the overlay must
  // not wait the full default timeout for it (a regression here blows the
  // 10s test timeout many times over).
  const start = Date.now();
  await expect(page.getByText('this text exists nowhere on the page')).not.toBeVisible();
  await page.getByText('no such element either').waitFor({ state: 'hidden' });
  expect(await page.getByText('still nothing').isHidden()).toBe(true);
  expect(Date.now() - start).toBeLessThan(8000);
});

test('scripted smooth scrolling lands instantly', async ({ page }) => {
  await page.goto('/');

  // A smooth scroll keeps animating under the assertion that follows it, so the
  // screenshot catches the scroller wherever the animation had got to. The
  // injected `scroll-behavior: auto !important` only covers scrolls that leave the
  // behavior to the CSS; these three name it themselves, and used to slip past.
  const offsets = await page.evaluate(() => {
    const box = document.createElement('div');
    box.style.cssText = 'width:200px;overflow:auto;scroll-behavior:smooth;white-space:nowrap';
    box.innerHTML = '<div style="width:2000px;height:2000px"></div>';
    document.body.appendChild(box);
    try {
      box.scrollBy({ left: 300, behavior: 'smooth' });
      const scrollBy = box.scrollLeft;
      box.scrollTo({ left: 600, behavior: 'smooth' });
      const scrollTo = box.scrollLeft;
      box.firstElementChild.scrollIntoView({ behavior: 'smooth', inline: 'start' });
      const scrollIntoView = box.scrollLeft;
      return { scrollBy, scrollTo, scrollIntoView };
    } finally {
      box.remove();
    }
  });

  // Read back the instant a scroll is requested: mid-animation these would still
  // be at their previous offsets.
  expect(offsets.scrollBy).toBe(300);
  expect(offsets.scrollTo).toBe(600);
  expect(offsets.scrollIntoView).toBe(0);
});

// A page that never goes quiet: an attention effect rewriting an attribute on
// every animation frame. Invisible, so the captures stay pixel-identical and
// only the settle logic is exercised. Returns a stop function.
const startTicking = (page) => page.evaluate(() => {
  const target = document.getElementById('probe');
  let tick = 0;
  let handle = requestAnimationFrame(function loop() {
    target.setAttribute('data-tick', String(++tick));
    handle = requestAnimationFrame(loop);
  });
  window.__stopTicking = () => cancelAnimationFrame(handle);
});
const stopTicking = (page) => page.evaluate(() => window.__stopTicking());

test('settling sees scrolling', async ({ page }) => {
  await page.goto('/');

  // A requestAnimationFrame scroll loop is neither a DOM mutation nor an
  // Animation; without the scroll listener it passed as a still page.
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'scroller';
    box.style.cssText = 'height:100px;overflow:auto';
    box.innerHTML = '<div style="height:5000px"></div>';
    document.body.appendChild(box);
    let handle = requestAnimationFrame(function loop() {
      box.scrollTop = (box.scrollTop + 7) % 4000;
      handle = requestAnimationFrame(loop);
    });
    window.__stopScrolling = () => { cancelAnimationFrame(handle); box.remove(); };
  });

  const start = Date.now();
  expect(await waitForVisualStability(page)).toBe(false);
  expect(Date.now() - start).toBeGreaterThan(400);

  await page.evaluate(() => window.__stopScrolling());
  expect(await waitForVisualStability(page)).toBe(true);
});

test('a capture on a page that never settles fails the test, naming the culprit', async ({ page }) => {
  await page.goto('/');
  await addProbe(page);
  await startTicking(page);

  const error = await expect(page.locator('#probe')).toHaveText('0').catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe('StabilityError');
  expect(error.message).toMatch(/did not settle within 500ms: the DOM kept mutating \(last: attribute "data-tick" on p#probe\)/);

  // The escape hatch: nothing captured, nothing to fail on — actions still
  // settle (best effort) and run.
  await suppressScreenshots('Open a test while the page keeps moving', async () => {
    await page.getByText('Start reviewing (2)').click();
    await expect(page.getByRole('heading', { name: 'changed, removed and new steps' })).toBeVisible();
  });
  // An explicit screenshot inside it is recorded, flagged, and not failed on.
  await suppressScreenshots('Capture the moving page anyway', async () => {
    await screenshot(page, 'ticking');
  });

  await stopTicking(page);
  await expect(page.locator('#probe')).toHaveText('0');
});

test.describe(() => {
  // Two captures 600ms apart — wide enough for the change scheduled below to
  // land between them well ahead of the second, even on a slow machine.
  test.use({ detectUnstable: 600 });

  test('detectUnstable fails a capture whose second look differs', async ({ page }) => {
    await page.goto('/');
    await addProbe(page);

    // Nothing moves while the capture settles and takes its first shot; the
    // change lands before the second. A DOM-based settle cannot know.
    await page.evaluate(() => {
      window.setTimeout(() => {
        document.getElementById('probe').style.background = '#f88';
      }, 300);
    });

    const error = await expect(page.locator('#probe')).toHaveText('0').catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StabilityError');
    expect(error.message).toMatch(/Unstable frame: a second capture 600ms later differed within the marked area/);
  });
});
