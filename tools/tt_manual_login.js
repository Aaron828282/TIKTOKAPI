// 人工登录监视器：在 Xvfb :98 上开有头浏览器（无 VNC 看不到），
// 用户经 noVNC 手动完成登录（含人机验证）。脚本只做三件事：
//   1) 打开 ads.tiktok.com/i18n/login（持久 profile，登录态沉淀给后续自动续期用）
//   2) 监听验证码音频响应存文件（供用户本地收听作答）
//   3) 轮询 sessionid_ads —— 拿到即导出 cookie JSON 后退出
// 用法：DISPLAY=:98 node tools/tt_manual_login.js --account-id <id> --timeout-min 30
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const ACCOUNT_ID = arg('account-id', '1');
const TIMEOUT_MIN = Number(arg('timeout-min', '30'));
const PROFILE = path.resolve('data', 'tt-profiles', ACCOUNT_ID);
const AUDIO_DIR = path.resolve('data', 'captcha-audio', ACCOUNT_ID);

function out(obj) {
  console.log(JSON.stringify(obj));
  process.exit(obj._rc || 0);
}

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const log = (m) => process.stderr.write(`[tt-manual] ${m}\n`);

  // 有头模式跑在 Xvfb 上（DISPLAY 由外部给）；UA 伪装与自动登录器同款
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    viewport: { width: 1280, height: 860 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    userAgentMetadata: {
      brands: [{ brand: 'Not A(Brand', version: '8' }, { brand: 'Chromium', version: '131' },
        { brand: 'Google Chrome', version: '131' }],
      mobile: false, platform: 'Windows', platformVersion: '10.0.0',
      architecture: 'x86', bitness: '64', model: '', uaFullVersion: '131.0.0.0',
    },
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // 验证码音频抓取：TikTok 音频验证码的音频本体走网络请求，存下来给用户本地听
  let audioSeq = 0;
  page.on('response', async (r) => {
    try {
      const u = r.url();
      const ct = (r.headers()['content-type'] || '');
      if (/captcha/i.test(u) && /audio|octet-stream|mp3|wav/i.test(ct)) {
        const buf = await r.body().catch(() => null);
        if (buf && buf.length > 2000) {
          const ext = /wav/.test(ct) ? 'wav' : 'mp3';
          const f = path.join(AUDIO_DIR, `captcha-${Date.now()}-${++audioSeq}.${ext}`);
          fs.writeFileSync(f, buf);
          log(`验证码音频已存：${f} (${buf.length}B)`);
        }
      }
    } catch { /* 无害 */ }
  });

  // 已登录（profile 里有会话）则直接验证并导出，不再走登录页
  let cookies = await ctx.cookies();
  if (cookies.some((c) => c.name === 'sessionid_ads')) {
    log('profile 已有会话，直接导出');
  } else {
    await page.goto('https://ads.tiktok.com/i18n/login', {
      waitUntil: 'domcontentloaded', timeout: 60_000 });
    log('登录页已打开');

    // --fill=1：脚本代填邮箱+密码并点 Log in，人只负责过人机验证
    if (arg('fill', '0') === '1') {
      const EMAIL = arg('email');
      const TT_PASS = arg('pass');
      // 等表单渲染（SPA 偶发慢），最多 60s
      for (let i = 0; i < 24; i++) {
        if (await page.locator('input[name="username"], input[type="email"]').first()
          .isVisible().catch(() => false)) break;
        await page.waitForTimeout(2500);
      }
      const em = page.locator('input[name="username"], input[type="email"]').first();
      await em.click().catch(() => {});
      await em.fill(EMAIL).catch(() => {});
      log('邮箱已填');
      const pw = page.locator('input[type="password"]').first();
      await pw.click().catch(() => {});
      await pw.fill(TT_PASS).catch(() => {});
      log('密码已填');
      await page.waitForTimeout(800);
      // ⚠️ 真·登录按钮是 type="button" 文本恰好 "Log in"；type="submit" 是隐藏的
      // 「Log in with TikTok」OAuth 按钮，点它永远无效
      const btn = page.locator('button[type="button"]', { hasText: /^Log in$/ }).first();
      await btn.click().catch(async () => {
        await page.locator('button:has-text("Log in")').first().click().catch(() => {});
      });
      log('已点 Log in —— 剩下的人机验证请在 noVNC 里手动完成');
    } else {
      log('请在 noVNC 里手动完成登录');
    }
  }

  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let otpUsed = 0;               // 最多自动收 2 次码（防限频死循环）
  let otpFilledAt = 0;

  // 调网页接码器取最新验证码
  const { spawn } = require('child_process');
  const fetchOtp = () => new Promise((resolve) => {
    const otpEmail = arg('otp-email', arg('email'));
    const otpPass = arg('otp-pass');
    const child = spawn(process.execPath, [
      path.resolve('tools', 'outlook_read.js'),
      '--email', otpEmail, '--password', otpPass,
      '--profile-dir', path.resolve('data', 'mail-profiles',
        otpEmail.split('@')[0].toLowerCase()),
    ], { cwd: process.cwd() });
    let stdout = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch { /* 已退出 */ } resolve(r); } };
    setTimeout(() => finish(null), 180_000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('error', () => finish(null));
    child.on('close', () => {
      const lines = stdout.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().startsWith('{')) {
          try { const r = JSON.parse(lines[i]); return finish(r.ok && r.code ? r : { error: r.error || 'no-code' }); } catch { /* 继续 */ }
        }
      }
      finish({ error: '接码器无输出' });
    });
  });

  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    cookies = await ctx.cookies();
    if (cookies.some((c) => c.name === 'sessionid_ads')) break;

    // ---- 自动 OTP：检测验证码输入页 → 取码 → 填码 → 提交 ----
    if (otpUsed < 2 && Date.now() - otpFilledAt > 30_000) {
      const onOtp = await page.locator(
        'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[name="code"], input[name="verifyCode"]'
      ).first().isVisible().catch(() => false);
      if (onOtp) {
        log(`第 ${otpUsed + 1} 次检测到验证码页，调接码器…`);
        const otp = await fetchOtp();
        if (!otp || !otp.code) {
          log('接码失败：' + (otp ? (otp.error || 'unknown') : '超时'));
        } else {
          log(`取到验证码 ${otp.code}，填入`);
          const boxes = page.locator('input[inputmode="numeric"]');
          const nBoxes = await boxes.count().catch(() => 0);
          if (nBoxes >= 4) {
            const chars = otp.code.split('');
            for (let i = 0; i < Math.min(nBoxes, chars.length); i++) {
              await boxes.nth(i).fill(chars[i]).catch(() => {});
            }
          } else {
            await page.locator('input[autocomplete="one-time-code"], input[name="code"], input[name="verifyCode"], input[placeholder*="code" i]')
              .first().fill(otp.code).catch(() => {});
          }
          await page.waitForTimeout(1200);
          // 有的布局填完自动提交；没提交就点验证按钮
          await page.locator(
            'button:has-text("Next"), button:has-text("Verify"), button:has-text("Log in"), button:has-text("Submit"), button[type="submit"]'
          ).first().click({ timeout: 3000 }).catch(() => { /* 自动提交了 */ });
          otpUsed += 1;
          otpFilledAt = Date.now();
        }
      }
    }
  }

  const all = await ctx.cookies();
  const tt = all.filter((c) => /tiktok\.com$/.test(c.domain));
  const cookieStr = tt.map((c) => `${c.name}=${c.value}`).join('; ');
  if (!cookieStr.includes('sessionid_ads=')) {
    out({ ok: false, stage: 'timeout', error: `${TIMEOUT_MIN} 分钟内没等到登录成功`, _rc: 1 });
  }
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
  out({ ok: true, stage: 'done', cookie: cookieStr, user_agent: ua, account_id: ACCOUNT_ID });
})().catch((e) => out({ ok: false, stage: 'crash', error: e.message, _rc: 1 }));
