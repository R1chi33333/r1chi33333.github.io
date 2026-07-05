import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://localhost:8873/docs', { waitUntil: 'networkidle' });
await page.waitForSelector('.opblock', { timeout: 20000 });
// expand the chat endpoint so the shot shows real API shape
const chat = page.locator('.opblock', { hasText: '/chat' }).first();
await chat.click().catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: '../media/shots/rag-chatbot.jpg', type: 'jpeg', quality: 82 });
console.log('saved');
await browser.close();
