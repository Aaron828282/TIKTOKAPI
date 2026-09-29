// 探测主站登录的 email + code 登录路径
const { chromium } = require('playwright');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function newCtx(ctx, page) {
  return (async () => {
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: UA,
      userAgentMetadata: {
        brands: [{ brand: 'Not A(Brand', version: '8' }, { brand: 'Chromium', version: '131' }, { brand: 'Google Chrome', version: '131' }],
        mobile: false, platform: 'Windows', platformVersion: '10.0.0',
        architecture: 'x86', bitness: '64', model: '', uaFullVersion: '131.0.0.0',
      },
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  })();
}

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/tt-debug15', {
    headless: true, viewport: { width: 1366, height: 900 },
    locale: 'en-US', timezoneId: 'America/New_York',
  });
  const p = ctx.pages()[0] || await ctx.newPage();
  await newCtx(ctx, p);

  await p.goto('https://www.tiktok.com/login?lang=en&enter_method=web', {
    waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(9000);
  console.log('URL:', p.url());

  // 点 Use phone / email / username
  const entry = p.locator('div:has-text("Use phone / email / username")').last();
  await p.getByText('Use phone / email / username', { exact: true }).first().click();
  await p.waitForTimeout(6000);
  console.log('after entry URL:', p.url());

  const texts = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('a,button,span,div[role="button"],div[role="tab"],label')) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 70 && el.offsetParent) out.push(`${el.tagName}: ${t}`);
    }
    return [...new Set(out)].slice(0, 45);
  }).catch((e) => ['EVAL ERR: ' + e.message]);
  console.log('TEXTS:\n' + texts.join('\n'));
  await p.screenshot({ path: '/tmp/tt-debug15.png' });
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
