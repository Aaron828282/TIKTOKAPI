// 探页面：登录页现在长什么样
const { chromium } = require('playwright');

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/tt-debug10', {
    headless: true,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const p = ctx.pages()[0] || await ctx.newPage();
  await p.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  await p.goto('https://ads.tiktok.com/i18n/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(10000);
  console.log('URL:', p.url());
  console.log('TITLE:', await p.title().catch(() => ''));
  const inputs = await p.evaluate(() =>
    Array.from(document.querySelectorAll('input')).map((i) => ({
      name: i.name, type: i.type, vis: !!i.offsetParent, ph: i.placeholder,
    })));
  console.log('INPUTS:', JSON.stringify(inputs));
  const txt = (await p.textContent('body').catch(() => '') || '').replace(/\s+/g, ' ');
  console.log('BODY:', txt.slice(0, 300));
  await p.screenshot({ path: '/tmp/tt-debug10.png' });
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
