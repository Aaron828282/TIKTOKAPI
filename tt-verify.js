// 验证当前 profile 里会话的账号身份与积分
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

  await p.goto('https://ads.tiktok.com/business/creative-center/quick-ai/video-gen/home',
    { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(15000);
  console.log('URL:', p.url());

  const txt = (await p.textContent('body').catch(() => '') || '').replace(/\s+/g, ' ');
  // 抓邮箱样式的串与积分相关字样
  const emails = txt.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  console.log('EMAILS FOUND:', JSON.stringify([...new Set(emails)].slice(0, 5)));
  const creditIdx = [];
  for (const kw of ['redit', 'credit', 'point', 'oint', 'uota', 'emaining']) {
    let i = txt.indexOf(kw);
    while (i >= 0 && creditIdx.length < 10) { creditIdx.push(txt.slice(Math.max(0, i - 60), i + 80)); i = txt.indexOf(kw, i + 1); }
  }
  console.log('CREDIT SNIPPETS:\n' + creditIdx.join('\n---\n'));
  await p.screenshot({ path: '/tmp/tt-verify.png' });
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
