// 抓浏览器实际调用 creative_bff_i18n 时的完整请求（URL/headers/cookies）+ localStorage
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

  let dumped = 0;
  p.on('request', (req) => {
    const u = req.url();
    if (dumped < 2 && /creative_bff_i18n/.test(u)) {
      dumped += 1;
      console.log('=== BFF REQUEST ===');
      console.log('URL:', u.slice(0, 220));
      const h = req.headers();
      for (const k of ['deviceid', 'x-csrftoken', 'tt-target-idc', 'cookie']) {
        const v = h[k] || h[k.toLowerCase()] || '';
        console.log(`H ${k}:`, String(v).slice(0, 160));
      }
    }
  });

  await p.goto('https://ads.tiktok.com/business/creative-center/quick-ai/video-gen/home',
    { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(15000);
  console.log('URL NOW:', p.url());

  const ls = await p.evaluate(() => {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/device|webid|user_unique|fp/i.test(k)) out[k] = String(localStorage.getItem(k)).slice(0, 60);
      }
    } catch (e) { out.err = e.message; }
    return out;
  }).catch(() => ({}));
  console.log('LOCALSTORAGE:', JSON.stringify(ls, null, 1));

  const names = (await ctx.cookies()).filter((c) => /tiktok\.com$/.test(c.domain)).map((c) => c.name);
  console.log('COOKIE NAMES:', names.join(','));
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
