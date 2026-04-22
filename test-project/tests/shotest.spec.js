import {
  test,
  expect,
  screenshot,
  splitIntoRoles,
  waitForVisualStability,
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

test('passes without screenshots when only using plain page methods', async ({ page }) => {
  await page.goto('/');

  const title = await page.title();
  if (title !== 'ShoTest Test Project') {
    throw new Error(`Expected page title to be "ShoTest Test Project", got ${JSON.stringify(title)}`);
  }
});
