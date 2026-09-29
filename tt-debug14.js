// 探测 Log in with TikTok OAuth 页的登录方式
const { chromium } = require('playwright');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/tt-debug14', {
    headless: true, viewport: { width: 1366, height: 900 },
    locale: 'en-US', timezoneId: 'America/New_York',
  });
  const p = ctx.pages()[0] || await ctx.newPage();
  await p.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: UA,
    userAgentMetadata: {
      brands: [{ brand: 'Not A(Brand', version: '8' }, { brand: 'Chromium', version: '131' }, { brand: 'Google Chrome', version: '131' }],
      mobile: false, platform: 'Windows', platformVersion: '10.0.0',
      architecture: 'x86', bitness: '64', model: '', uaFullVersion: '131.0.0.0',
    },
  });
  await p.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  let ok = false;
  for (let i = 0; i < 4 && !ok; i++) {
    await p.goto('https://ads.tiktok.com/i18n/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let w = 0; w < 10; w++) {
      if (await p.locator('input[name="username"], input[type="email"]').first().isVisible().catch(() => false)) { ok = true; break; }
      await p.waitForTimeout(2500);
    }
  }
  if (!ok) { console.log('FORM NOT RENDERED'); await ctx.close(); process.exit(2); }

  await p.locator('button:has-text("Log in with TikTok")').first().click();
  console.log('clicked OAuth btn');
  await p.waitForTimeout(10000);
  console.log('URL NOW:', p.url());

  // 也可能开了新窗口
  const page2 = ctx.pages().find((x) => x !== p) || p;
  console.log('PAGES:', ctx.pages().length, 'page2 url:', page2.url());
  const texts = await page2.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('a,button,span,div[role="button"],div[role="tab"],label,h1,h2')) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 70 && el.offsetParent) out.push(`${el.tagName}: ${t}`);
    }
    return [...new Set(out)].slice(0, 45);
  }).catch((e) => ['EVAL ERR: ' + e.message]);
  console.log('OAUTH PAGE TEXTS:\n' + texts.join('\n'));
  await page2.screenshot({ path: '/tmp/tt-debug14.png' });
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
