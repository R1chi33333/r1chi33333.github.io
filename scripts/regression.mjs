import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const page = await context.newPage();

async function shot(url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '#net,#netCanvas,#aura,canvas{display:none !important}' });
  await page.evaluate(() => new Promise(r => setTimeout(r, 1200)));
  return page.screenshot({ fullPage: true });
}

execSync('git -C .. worktree add /tmp/site-before HEAD --force 2>/dev/null || true');
execSync('cd /tmp/site-before && (python3 -m http.server 8081 > /dev/null 2>&1 &); sleep 1');

const before = await shot('http://localhost:8081');
const after = await shot('http://localhost:8092');

fs.writeFileSync('/tmp/site-before.png', before);
fs.writeFileSync('/tmp/site-after.png', after);
console.log(Buffer.compare(before, after) === 0 ? 'PIXEL-IDENTICAL' : `DIFFERS: ${before.length} vs ${after.length}`);
await browser.close();
