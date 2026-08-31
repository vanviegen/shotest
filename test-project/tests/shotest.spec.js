import {
  test,
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

test('covers core wrapped actions and assertions', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Increment' }).click();
  await expect(page.locator('#count-value')).toHaveText('1');

  const nameInput = page.getByLabel('Name');
  await nameInput.fill('Alpha');
  await expect(nameInput).toHaveValue('Alpha');
  await nameInput.clear();
  await nameInput.type('Beta');
  await nameInput.press('End');

  const select = page.getByLabel('Theme color');
  await select.selectOption('mint');
  await expect(select).toHaveValue('mint');

  const newsletter = page.getByLabel('Receive newsletter');
  await newsletter.check();
  await expect(newsletter).toBeChecked();
  await newsletter.uncheck();
  await expect(newsletter).not.toBeChecked();

  const hoverButton = page.getByRole('button', { name: 'Hover me' });
  await hoverButton.hover();
  await expect(page.locator('#hover-state')).toHaveText('hovered');

  const doubleButton = page.getByRole('button', { name: 'Double click me' });
  await doubleButton.dblclick();
  await expect(page.locator('#double-state')).toHaveText('doubled');

  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByText('Beta|mint|news:off').waitFor();
  await expect(page.getByText('Beta|mint|news:off')).toBeVisible();

  await waitForVisualStability(page);
  await screenshot(page, 'core-final');
});

test('covers splitIntoRoles including repeated role names', async ({ page }) => {
  await page.goto('/');

  const { alpha, beta } = await splitIntoRoles(page, 'alpha', 'beta', 'alpha');
  await expect(beta.getByRole('heading', { name: 'Client Demo' })).toBeVisible();

  await alpha.getByRole('button', { name: 'Toggle role state' }).click();
  await expect(alpha.locator('#role-state')).toHaveText('on');

  await beta.getByRole('button', { name: 'Toggle role state' }).click();
  await expect(beta.locator('#role-state')).toHaveText('on');

  await screenshot(alpha, 'alpha-state');
  await screenshot(beta, 'beta-state');
});

test('covers demo helpers in non-video mode', async ({ page }) => {
  await page.goto('/');

  await demoTap(page, page.getByRole('button', { name: 'Increment' }));
  await expect(page.locator('#count-value')).toHaveText('1');

  await demoType(page, page.getByLabel('Name'), 'DemoUser');
  await expect(page.getByLabel('Name')).toHaveValue('DemoUser');

  await demoPause(page, 50);

  const swipeZone = page.locator('#swipe-zone');
  await demoSwipe(page, swipeZone, 'right', 120);
  await expect(swipeZone).toBeVisible();

  await screenshot(page, 'demo-final');
});

test('supports describe hints and screenshot suppression', async ({ page }) => {
  await page.goto('/');

  await suppressScreenshots('Prepare the counter (2x increment)', async () => {
    await page.getByRole('button', { name: 'Increment' }).click();
    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.locator('#count-value')).toHaveText('2');
  });

  page.describe('Verify the prepared counter');
  await expect(page.locator('#count-value')).toHaveText('2');
});

test.describe(() => {
  test.use({ busySelector: '.busy-marker' });

  test('captures wait while busySelector matches', async ({ page }) => {
    await page.goto('/');

    // The busy marker holds past the 500ms settle cap; the content change
    // lands only as it clears, so the settle must outwait the marker.
    await page.evaluate(() => {
      const marker = document.createElement('div');
      marker.className = 'busy-marker';
      document.body.appendChild(marker);
      window.setTimeout(() => {
        document.getElementById('count-value').textContent = 'ready';
        marker.remove();
      }, 700);
    });

    const start = Date.now();
    await waitForVisualStability(page);
    expect(Date.now() - start).toBeGreaterThan(600);
    await expect(page.locator('#count-value')).toHaveText('ready');
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
  await expect(page.getByRole('heading', { name: 'Client Demo' })).toBeVisible();
});

test('passes without screenshots when only using plain page methods', async ({ page }) => {
  await page.goto('/');

  const title = await page.title();
  if (title !== 'ShoTest Test Project') {
    throw new Error(`Expected page title to be "ShoTest Test Project", got ${JSON.stringify(title)}`);
  }
});

test('captures browser console messages', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(() => {
    console.info('console info before increment');
    console.warn('console warning before increment - this text is very long and should not cause the step box to grow beyond the width of the screenshot');
  });

  await page.getByRole('button', { name: 'Increment' }).click();

  await page.evaluate(() => {
    console.error('console error before final screenshot');
  });

  await screenshot(page, 'console-final');
});

test('captures screenshots for locator reads and timed waits', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(() => {
    const countValue = document.getElementById('count-value');
    if (!countValue) {
      throw new Error('Missing #count-value test element');
    }
    countValue.textContent = 'before';
    window.setTimeout(() => {
      countValue.textContent = 'after';
    }, 50);
  });

  const value = page.locator('#count-value').first();
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
