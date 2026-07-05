/**
 * Post-revamp verification per plan: run from scripts/: node verify.mjs
 * Checks index tiles + projects.html gallery at desktop & mobile widths.
 */

import { chromium } from '@playwright/test';

const BASE = 'http://localhost:8092';
let failures = 0;
const ok = (cond, label) => {
  console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();

async function newPage(width, height, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, ...opts });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('requestfailed', (r) => failedRequests.push(r.url()));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(BASE)) failedRequests.push(`${r.status()} ${r.url()}`);
  });
  return { ctx, page, consoleErrors, failedRequests };
}

// ---------- index.html desktop ----------
console.log('index.html @1440x900');
{
  const { ctx, page, consoleErrors, failedRequests } = await newPage(1440, 900);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  ok((await page.locator('.cat-tile').count()) === 3, '3 category tiles');
  for (const img of await page.locator('.cat-tile img').all()) {
    await img.scrollIntoViewIfNeeded();
    const loaded = await page
      .waitForFunction((el) => el.complete && el.naturalWidth > 0, await img.elementHandle(), {
        timeout: 5000,
      })
      .then(() => true)
      .catch(() => false);
    ok(loaded, `tile image loaded (${await img.getAttribute('src')})`);
  }
  ok(
    (await page.locator('nav .links a', { hasText: 'Work' }).getAttribute('href')) ===
      'projects.html',
    'nav Work -> projects.html',
  );
  ok(consoleErrors.length === 0, `no console errors (${consoleErrors.join('; ')})`);
  ok(failedRequests.length === 0, `no failed requests (${failedRequests.join('; ')})`);
  // tile click navigates to gallery anchor
  await page.locator('.cat-tile[data-cat="swe"]').click();
  await page.waitForURL('**/projects.html#swe');
  const labelY = await page
    .locator('#swe .group-label')
    .evaluate((el) => el.getBoundingClientRect().top);
  ok(labelY > 70 && labelY < 400, `#swe group label below nav (top=${Math.round(labelY)})`);
  await ctx.close();
}

// ---------- projects.html desktop ----------
console.log('projects.html @1440x900');
{
  const { ctx, page, consoleErrors, failedRequests } = await newPage(1440, 900);
  await page.goto(`${BASE}/projects.html`, { waitUntil: 'networkidle' });
  ok((await page.locator('.gcard').count()) === 13, '13 gcards (3 video + 10 screenshot)');
  ok((await page.locator('a.gthumb').count()) === 10, '10 screenshot link thumbs');
  for (const img of await page.locator('.gthumb img').all()) {
    await img.scrollIntoViewIfNeeded();
    const w = await img.evaluate((el) => el.naturalWidth);
    ok(w > 0, `image loaded (${await img.getAttribute('src')})`);
  }
  // accent morph on scroll into #mle (return to top first — the image loop scrolled the page)
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForTimeout(1200);
  const accentBefore = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  );
  await page.locator('#mle .group-label').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1200);
  const accentAfter = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  );
  ok(accentBefore !== accentAfter, `accent morph fires (${accentBefore} -> ${accentAfter})`);
  // lightbox open/close on FireBoy
  await page.locator('button.gthumb[data-video="media/fireboy.mp4"]').click();
  ok(
    await page.locator('#lightbox').evaluate((el) => el.classList.contains('open')),
    'lightbox opens',
  );
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok(
    await page.locator('#lightbox').evaluate((el) => !el.classList.contains('open')),
    'lightbox closes on Esc',
  );
  // Pattern C thumb opens live URL in a new tab
  const [popup] = await Promise.all([
    ctx.waitForEvent('page'),
    page.locator('a.gthumb[href="https://nz-bank-parser.vercel.app"]').click(),
  ]);
  ok(popup.url().startsWith('https://nz-bank-parser.vercel.app'), 'thumb opens live URL in new tab');
  await popup.close();
  ok(consoleErrors.length === 0, `no console errors (${consoleErrors.join('; ')})`);
  ok(failedRequests.length === 0, `no failed local requests (${failedRequests.join('; ')})`);
  await ctx.close();
}

// ---------- mobile ----------
for (const path of ['index.html', 'projects.html']) {
  console.log(`${path} @390x844`);
  const { ctx, page } = await newPage(390, 844);
  await page.goto(`${BASE}/${path}`, { waitUntil: 'networkidle' });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  ok(overflow <= 0, `no horizontal overflow (delta=${overflow})`);
  if (path === 'index.html') {
    const boxes = await page.locator('.cat-tile').evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().width),
    );
    ok(new Set(boxes.map(Math.round)).size === 1 && boxes[0] > 300, 'tiles stack 1-col full width');
  } else {
    const xs = await page.locator('#swe .gcard').evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().x)),
    );
    ok(new Set(xs).size === 1, 'gallery cards stack 1-col');
  }
  await ctx.close();
}

// ---------- GSAP CDN blocked fallback ----------
console.log('projects.html with GSAP blocked');
{
  const { ctx, page } = await newPage(1440, 900);
  await page.route('**cdn.jsdelivr.net**', (r) => r.abort());
  await page.goto(`${BASE}/projects.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const visible = await page
    .locator('#swe h3', { hasText: 'FlatSplit' })
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && Number(s.opacity) > 0.5;
    });
  ok(visible, 'content visible without GSAP');
  await ctx.close();
}

await browser.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
