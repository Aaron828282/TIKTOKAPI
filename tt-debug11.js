// 精确提交诊断 v2：渲染重试 + 列按钮 + 点 type=submit + 抓响应/错误
const { chromium } = require('playwright');

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/tt-debug11', {
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

  const respLog = [];
  p.on('response', (r) => {
    const u = r.url();
    if (/passport|login|user\/|check|verify|captcha|risk/i.test(u)) {
      respLog.push(`${r.status()} ${u.slice(0, 120)}`);
    }
  });

  // 渲染重试：最多 5 轮 reload，等邮箱框出现
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) {
    await p.goto('https://ads.tiktok.com/i18n/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let w = 0; w < 12; w++) {
      const vis = await p.locator('input[name="username"], input[type="email"]').first()
        .isVisible().catch(() => false);
      if (vis) { ok = true; break; }
      await p.waitForTimeout(2500);
    }
    console.log(`render try ${i + 1}: form=${ok}`);
  }
  if (!ok) {
    await p.screenshot({ path: '/tmp/tt-debug11.png' });
    console.log('GIVE UP: form never rendered');
    await ctx.close();
    process.exit(2);
  }

  await p.locator('input[name="username"], input[type="email"]').first().click();
  await p.locator('input[name="username"], input[type="email"]').first().fill('armidashines938100@outlook.com');
  await p.waitForTimeout(500);
  await p.locator('input[type="password"]').first().click();
  await p.locator('input[type="password"]').first().fill('tk123.');
  await p.waitForTimeout(500);

  const btns = await p.evaluate(() =>
    Array.from(document.querySelectorAll('button')).map((b, i) => ({
      i, text: (b.textContent || '').trim().slice(0, 40),
      type: b.type, disabled: b.disabled,
    })).filter((b) => /log ?in/i.test(b.text)));
  console.log('BUTTONS:', JSON.stringify(btns));

  const submitBtn = p.locator('button[type="submit"]').first();
  console.log('SUBMIT text:', ((await submitBtn.textContent().catch(() => '')) || '').trim());
  await submitBtn.click();
  console.log('CLICKED');

  await p.waitForTimeout(10000);
  console.log('URL NOW:', p.url());
  const errs = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[class*="error" i],[class*="toast" i],[role="alert"],[class*="tip" i],[class*="message" i]')) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 200 && el.offsetParent) out.push(t);
    }
    return out.slice(0, 8);
  });
  console.log('PAGE ERRORS:', JSON.stringify(errs));
  console.log('RESPONSES:\n' + respLog.slice(-18).join('\n'));
  await p.screenshot({ path: '/tmp/tt-debug11.png' });
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
