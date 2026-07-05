/**
 * Capture 16:9 screenshots of the live demos into media/shots/.
 * Run from scripts/: node capture.mjs [only-name]
 */

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = new URL('../media/shots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const only = process.argv[2];

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});

async function save(name) {
  await page.screenshot({ path: `${OUT}${name}.jpg`, type: 'jpeg', quality: 82 });
  console.log('saved', name);
}

const jobs = {
  'nz-bank-parser': async () => {
    await page.goto('https://nz-bank-parser.vercel.app', { waitUntil: 'networkidle' });
    // Load the ANZ sample so the screenshot shows parsed output.
    await page.getByRole('button', { name: 'ANZ', exact: true }).click();
    await page.waitForSelector('tbody tr');
    await page.waitForTimeout(600);
    await save('nz-bank-parser');
  },
  flatsplit: async () => {
    await page.goto('https://flatsplit-nz.vercel.app/login', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Open the demo flat' }).click();
    await page.waitForURL('**/app');
    await page.goto('https://flatsplit-nz.vercel.app/app/settle');
    await page.waitForSelector('text=transfers to settle everything');
    await page.waitForTimeout(500);
    await save('flatsplit');
  },
  'housing-observatory': async () => {
    await page.goto('https://nz-housing-observatory.vercel.app', { waitUntil: 'networkidle' });
    await page.waitForSelector('.maplibregl-canvas');
    await page.waitForTimeout(5000); // let region fills and tiles paint
    await save('housing-observatory');
  },
  statusping: async () => {
    await page.goto('https://statusping-production.up.railway.app/status/portfolio', {
      waitUntil: 'networkidle',
    });
    await page.waitForSelector('text=uptime');
    await save('statusping');
  },
  tenancymate: async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto('https://tenancymate.vercel.app', { waitUntil: 'networkidle' });
        await page
          .getByLabel('Your question')
          .fill('Can my landlord raise the rent twice in one year?');
        await page.getByRole('button', { name: 'Send' }).click();
        await page.waitForSelector('aside [data-section]', { timeout: 180000 });
        await page.waitForTimeout(800);
        await save('tenancymate');
        return;
      } catch (error) {
        console.log(`tenancymate attempt ${attempt} failed:`, error.message.slice(0, 80));
        if (attempt === 3) throw error;
      }
    }
  },
};

for (const [name, job] of Object.entries(jobs)) {
  if (only && name !== only) continue;
  await job();
}

await browser.close();
console.log('done');
