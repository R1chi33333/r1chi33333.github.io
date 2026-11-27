/**
 * Site check: run a static server on :8092 from the repo root, then from scripts/: node verify.mjs
 * Loads every page at desktop and phone width, scrolls so lazy images load, and fails on
 * console errors, 4xx/5xx responses, broken images, missing alt text, horizontal scroll or dead local links.
 */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:8092/';
const PAGES = ['index.html', 'microduck.html', 'projects.html'];
const SIZES = [[1440, 900], [390, 844]];
let failures = 0;
const ok = (cond, label) => { console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`); if (!cond) failures++; };

const browser = await chromium.launch();
for (const page_ of PAGES) for (const [w, h] of SIZES) {
  console.log(`${page_} @${w}x${h}`);
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
  await page.goto(BASE + page_, { waitUntil: 'networkidle' });
  for (let y = 0; y < 30000; y += 500) { await page.evaluate((v) => window.scrollTo(0, v), y); await page.waitForTimeout(40); }
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({
    hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
    broken: [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src),
    noAlt: [...document.images].filter((i) => !i.hasAttribute('alt')).length,
    links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((u) => !/^(https?:|mailto:|tel:|#)/.test(u)),
  }));
  ok(errors.length === 0, `no errors ${errors.join(' | ')}`);
  ok(!r.hscroll, 'no horizontal scroll');
  ok(r.broken.length === 0, `images load ${r.broken.join(' ')}`);
  ok(r.noAlt === 0, 'every image has alt');
  for (const l of new Set(r.links)) {
    const res = await page.request.get(BASE + l.split('#')[0]).catch(() => null);
    ok(res && res.status() < 400, `link ${l}`);
  }
  await page.close();
}
await browser.close();
console.log(failures ? `${failures} failure(s)` : 'all good');
process.exit(failures ? 1 : 0);
