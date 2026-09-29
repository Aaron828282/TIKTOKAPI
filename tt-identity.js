// 看这个登录态下的业务身份与工作空间
process.chdir('/opt/rhnode');
const { chromium } = require('playwright');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const ctx = await chromium.launchPersistentContext('/opt/rhnode/data/tt-profiles/1', {
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

  // 业务中心首页（登录态下会显示当前广告账户/BC 信息）
  await p.goto('https://ads.tiktok.com/business/home', {
    waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(14000);
  console.log('URL:', p.url());
  const txt = (await p.textContent('body').catch(() => '') || '').replace(/\s+/g, ' ');
  const emails = [...new Set(txt.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])];
  console.log('EMAILS:', JSON.stringify(emails.slice(0, 6)));
  // 用户名/ID 片段
  for (const kw of ['Account', 'account id', 'Business', 'Welcome', 'Switch']) {
    const i = txt.indexOf(kw);
    if (i >= 0) console.log(`[${kw}]:`, txt.slice(i, i + 120));
  }
  await p.screenshot({ path: '/tmp/tt-identity.png' });
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
