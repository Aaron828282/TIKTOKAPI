// 精确提交诊断 v3：完整 UA 伪装（与 tiktok_login.js spoofPage 同款）
const { chromium } = require('playwright');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function spoofPage(ctx, page) {
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: UA,
    userAgentMetadata: {
      brands: [
        { brand: 'Not A(Brand', version: '8' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Google Chrome', version: '131' },
      ],
      mobile: false, platform: 'Windows', platformVersion: '10.0.0',
      architecture: 'x86', bitness: '64', model: '', uaFullVersion: '131.0.0.0',
    },
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/tt-debug12', {
    headless: true,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  const p = ctx.pages()[0] || await ctx.newPage();
  await spoofPage(ctx, p);

  const respLog = [];
  p.on('response', (r) => {
    const u = r.url();
    if (/passport|login|user\/|check|verify|captcha|risk/i.test(u)) {
      respLog.push(`${r.status()} ${u.slice(0, 120)}`);
    }
  });

  // 渲染重试
  let ok = false;
  for (let i = 0; i < 4 && !ok; i++) {
    await p.goto('https://ads.tiktok.com/i18n/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let w = 0; w < 10; w++) {
      if (await p.locator('input[name="username"], input[type="email"]').first().isVisible().catch(() => false)) { ok = true; break; }
      await p.waitForTimeout(2500);
    }
    console.log(`render try ${i + 1}: form=${ok}`);
  }
  if (!ok) { await p.screenshot({ path: '/tmp/tt-debug12.png' }); console.log('GIVE UP'); await ctx.close(); process.exit(2); }

  await p.locator('input[name="username"], input[type="email"]').first().click();
  await p.locator('input[name="username"], input[type="email"]').first().fill('armidashines938100@outlook.com');
  await p.waitForTimeout(500);
  await p.locator('input[type="password"]').first().click();
  await p.locator('input[type="password"]').first().fill('tk123.');
  await p.waitForTimeout(500);

  const btns = await p.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map((b, i) => ({
      i, text: (b.textContent || '').trim().slice(0, 40), type: b.type, disabled: b.disabled,
    })).filter((b) => /log ?in/i.test(b.text)));
  console.log('BUTTONS:', JSON.stringify(btns));

  const submitBtn = p.locator('button[type="submit"]').first();
  console.log('SUBMIT text:', ((await submitBtn.textContent().catch(() => '')) || '').trim());
  await submitBtn.click();
  console.log('CLICKED submit');

  await p.waitForTimeout(12000);
  console.log('URL NOW:', p.url());
  const errs = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[class*="error" i],[class*="toast" i],[role="alert"],[class*="tip" i],[class*="message" i],[class*="captcha" i],iframe')) {
      const tag = el.tagName;
      const t = (el.textContent || '').trim();
      const src = el.src || '';
      if (tag === 'IFRAME') { if (src) out.push(`IFRAME: ${src.slice(0, 100)}`); continue; }
      if (t && t.length < 200 && el.offsetParent) out.push(t);
    }
    return out.slice(0, 10);
  });
  console.log('PAGE AFTER:', JSON.stringify(errs));
  console.log('RESPONSES:\n' + respLog.slice(-18).join('\n'));
  await p.screenshot({ path: '/tmp/tt-debug12.png' });
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
