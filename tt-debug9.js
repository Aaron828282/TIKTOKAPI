// 精确诊断：填表 → 点真正的 Log in 提交按钮 → 抓响应/错误提示
const { chromium } = require('playwright');

(async () => {
  const ctx = await chromium.launchPersistentContext('/tmp/tt-debug9', {
    headless: true,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await ctx.browserContext && null;

  const ua = await page.evaluate(() => navigator.userAgent);
  await page.close();
  const ctx2 = ctx; // reuse
  // 重新拿 page（刚才关了默认页）
  const p = ctx2.pages()[0] || await ctx2.newPage();

  const respLog = [];
  p.on('response', (r) => {
    const u = r.url();
    if (/passport|login|user\/|check|verify|captcha/i.test(u)) {
      respLog.push(`${r.status()} ${u.slice(0, 110)}`);
    }
  });

  await p.goto('https://ads.tiktok.com/i18n/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(8000);

  // 填邮箱
  const emailSel = 'input[name="username"], input[type="email"]';
  await p.locator(emailSel).first().waitFor({ timeout: 15000 });
  await p.locator(emailSel).first().click();
  await p.locator(emailSel).first().fill('armidashines938100@outlook.com');
  await p.waitForTimeout(600);
  // 填密码
  const passSel = 'input[type="password"]';
  await p.locator(passSel).first().click();
  await p.locator(passSel).first().fill('tk123.');
  await p.waitForTimeout(600);

  // 列出所有含 Log in 文本的按钮，确认哪个是提交
  const btns = await p.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map((b, i) => ({
      i, text: (b.textContent || '').trim().slice(0, 40),
      type: b.type, disabled: b.disabled, cls: (b.className || '').slice(0, 60),
    })).filter((b) => b.text.toLowerCase().includes('log in'));
  });
  console.log('BUTTONS:', JSON.stringify(btns));

  // 点 type=submit 的那个（真正的表单提交按钮）
  const submitBtn = p.locator('button[type="submit"]').first();
  const submitText = await submitBtn.textContent().catch(() => null);
  console.log('SUBMIT BTN text:', (submitText || '').trim());
  await submitBtn.click();
  console.log('CLICKED submit');

  await p.waitForTimeout(9000);
  console.log('URL NOW:', p.url());
  // 页面上的错误提示
  const errs = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('[class*="error" i],[class*="toast" i],[role="alert"],[class*="tip" i]')) {
      const t = (el.textContent || '').trim();
      if (t && t.length < 200 && el.offsetParent) out.push(t);
    }
    return out;
  });
  console.log('PAGE ERRORS:', JSON.stringify(errs));
  console.log('RESPONSES:\n' + respLog.slice(-15).join('\n'));
  await p.screenshot({ path: '/tmp/tt-debug9.png' });
  await ctx.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
