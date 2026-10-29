// Captures README screenshots from a running preview server.
// Usage: npm run build && npm run preview  (in another shell), then: node scripts/capture.mjs
import { chromium } from '@playwright/test';

const base = process.env.BASE_URL ?? 'http://localhost:4319';
const browser = await chromium.launch({ channel: 'chrome' });

async function shot(name, { width, height, scenario, speed = '4x', waitSimMs, compare = false, fullPage = false, scale = 1 }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.goto(base);
  if (scenario) await page.getByRole('button', { name: scenario }).click();
  if (compare) await page.getByRole('button', { name: 'Compare with fix' }).click();
  await page.getByRole('button', { name: speed, exact: true }).click();
  await page.waitForFunction((target) => {
    const [m, s] = document.querySelector('.clock').textContent.split(':');
    return (Number(m) * 60 + Number(s)) * 1000 >= target;
  }, waitSimMs, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage });
  await page.close();
}

await shot('retry-storm', { width: 1440, height: 1000, scenario: 'Retry storm', waitSimMs: 16_000, compare: true });
await shot('poison', { width: 1440, height: 1000, scenario: 'Poison messages', waitSimMs: 45_000, speed: '8x' });
await shot('mobile', { width: 390, height: 1400, scenario: 'Retry storm', waitSimMs: 14_000, scale: 2 });
await browser.close();
console.log('saved to docs/screenshots');
