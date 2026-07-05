import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

// Real content: the pipeline architecture from the job-hunter README.
const arch = readFileSync('/tmp/jh-arch.txt', 'utf8');

const html = `<!doctype html><html><head><style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap');
  body{margin:0;background:#eef0f6;display:flex;align-items:center;justify-content:center;height:100vh;}
  .term{width:1080px;background:#0d1117;border-radius:12px;box-shadow:0 30px 80px -20px rgba(11,14,22,.45);overflow:hidden;}
  .bar{display:flex;gap:8px;padding:13px 16px;background:#161b22;}
  .dot{width:12px;height:12px;border-radius:50%;}
  .r{background:#ff5f57}.y{background:#febc2e}.g{background:#28c840}
  .title{margin-left:12px;color:#8b949e;font:500 12px 'JetBrains Mono',monospace;}
  pre{margin:0;padding:22px 26px;color:#c9d1d9;font:400 13.5px/1.5 'JetBrains Mono',monospace;}
  .p{color:#7ee787;} .c{color:#8b949e;}
</style></head><body>
  <div class="term">
    <div class="bar"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
      <span class="title">job-hunter — 5-agent pipeline (Claude Code, no API key)</span></div>
    <pre><span class="p">$</span> python3 main.py <span class="c"># orchestrates the five agents</span>

${arch.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.screenshot({ path: '../media/shots/job-hunter.jpg', type: 'jpeg', quality: 85 });
console.log('saved');
await browser.close();
