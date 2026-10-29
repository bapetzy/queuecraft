import { expect, test, type Page } from '@playwright/test';

const clockMs = async (page: Page) => {
  const text = (await page.locator('.clock').textContent()) ?? '00:00.0';
  const [m, rest] = text.split(':');
  return (Number(m) * 60 + Number(rest)) * 1000;
};

const readout = (page: Page, label: string) =>
  page.locator('.readouts div', { hasText: label }).locator('dd');

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  (page as unknown as { errors: string[] }).errors = errors;
  await page.goto('/');
});

test.afterEach(async ({ page }) => {
  expect((page as unknown as { errors: string[] }).errors).toEqual([]);
});

test('runs on load: time moves and jobs finish', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Steady state' })).toBeVisible();
  await page.getByRole('button', { name: '8x' }).click();
  await expect.poll(() => clockMs(page), { timeout: 10_000 }).toBeGreaterThan(8000);
  await expect.poll(async () => Number(await readout(page, 'Throughput').textContent().then((t) => parseFloat(t ?? '0'))), { timeout: 10_000 }).toBeGreaterThan(3);
});

test('pause freezes time, step advances 100 ms', async ({ page }) => {
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(400); // let the readout catch up
  const t0 = await clockMs(page);
  await page.waitForTimeout(600);
  expect(await clockMs(page)).toBe(t0);
  await page.getByRole('button', { name: 'Step' }).click();
  await expect.poll(() => clockMs(page)).toBe(t0 + 100);
});

test('retry storm: outage banner, dead letters, redrive, compare with fix', async ({ page }) => {
  await page.getByRole('button', { name: 'Retry storm' }).click();
  await page.getByRole('button', { name: '8x' }).click();
  await expect(page.locator('.banner', { hasText: 'Dependency down' })).toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => Number(await readout(page, 'Dead-lettered').textContent()), { timeout: 15_000 }).toBeGreaterThan(20);

  // Inspect a dead-lettered job.
  await page.locator('.dlq button').first().click();
  await expect(page.locator('.inspector .state')).toHaveText('in the dead-letter queue');
  await expect(page.locator('.attempts li')).toHaveCount(8);

  // Redrive empties the DLQ.
  await page.getByRole('button', { name: 'Redrive all' }).click();
  await expect(page.locator('.toast')).toContainText('sent back to the queue');

  // Compare runs a ghost with the fix on the same traffic.
  await page.getByRole('button', { name: 'Compare with fix' }).click();
  await expect(page.locator('.versus')).toBeVisible();
  await expect.poll(() => clockMs(page), { timeout: 15_000 }).toBeGreaterThan(30_000);
  const cells = page.locator('.versus tbody tr', { hasText: 'DLQ' }).locator('td');
  const run = Number(await cells.nth(0).textContent());
  const fix = Number(await cells.nth(1).textContent());
  expect(run).toBeGreaterThan(fix * 3);
});

test('a hand-injected fault shows as a live lamp and banner', async ({ page }) => {
  await page.getByRole('button', { name: 'Crash', exact: true }).click();
  await expect(page.locator('.banner', { hasText: 'Workers crashed' })).toBeVisible();
  await expect(page.locator('.fault.live', { hasText: 'Crash' })).toBeVisible();
});

test('settings live in the URL and survive a reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Sandbox' }).click();
  await page.locator('#workerCount').evaluate((el: HTMLInputElement) => {
    el.value = '17';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('output[for="workerCount"]')).toHaveText('17');
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#run=/);
  await page.reload();
  await expect(page.locator('output[for="workerCount"]')).toHaveText('17');
  await expect(page.getByRole('heading', { name: 'Your own queue' })).toBeVisible();
});

test('a broken share link falls back to defaults with a notice', async ({ page }) => {
  await page.goto('/#run=this-is-not-valid');
  await expect(page.locator('.toast')).toContainText('could not be read');
  await expect(page.getByRole('heading', { name: 'Steady state' })).toBeVisible();
});

test('no horizontal scroll and the panel is drawn', async ({ page }) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await page.locator('.panel canvas').boundingBox();
  expect(box!.width).toBeGreaterThan(300);
  expect(box!.height).toBeGreaterThan(300);
  // The canvas has actually been painted (not blank).
  const painted = await page.locator('.panel canvas').evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d')!;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] > 150) lit++;
    return lit;
  });
  expect(painted).toBeGreaterThan(100);
});
