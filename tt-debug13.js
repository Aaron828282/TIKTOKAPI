// 探测登录页的登录方式选项（找 Log in with code）
const { chromium } = require('playwright');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/tt-debug13', {
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

  // 列出所有可点击文本
  const texts = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('a,button,span,div[role="button"],div[role="tab"],label')) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 60 && el.offsetParent) out.push(`${el.tagName}: ${t}`);
    }
    return [...new Set(out)].slice(0, 40);
  });
  console.log('CLICKABLE TEXTS:\n' + texts.join('\n'));
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
