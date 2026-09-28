#!/usr/bin/env node
/**
 * Outlook 网页版接码器（第一阶段原型）
 * 用法:
 *   DISPLAY=:98 node outlook_read.js --email a@outlook.com --password xxx \
 *     [--profile-dir data/mail-profiles/<name>] [--headed] [--no-login]
 * 输出: JSON {ok, stage, code?, subject?, date?, error?, shot?}
 * 退出码: 0=拿到码 1=失败 2=遇风控挑战(需 noVNC 人工)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
}
const has = (n) => process.argv.includes('--' + n);

const EMAIL = arg('email');
const PASSWORD = arg('password');
const PROFILE = arg('profile-dir', path.join('data', 'mail-profiles', (EMAIL || 'default').split('@')[0].toLowerCase()));
const HEADLESS = !has('headed');

function out(obj) { console.log(JSON.stringify(obj)); process.exit(obj._rc); }

(async () => {
  if (!EMAIL) return out({ ok: false, error: 'missing --email', _rc: 1 });
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 850 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const shot = async (tag) => {
    const f = path.join('/tmp', 'otp-' + tag + '-' + Date.now() + '.png');
    await page.screenshot({ path: f }).catch(() => {});
    return f;
  };

  try {
    // 1) 进邮箱（已登录的 profile 会直接落在收件箱）
    await page.goto('https://outlook.live.com/mail/0/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    // 匿名访问会被弹到微软营销页 —— 直接去登录页
    if (/microsoft\.com.*(outlook|deeplink)/i.test(page.url())) {
      await page.goto('https://login.live.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
    }
    if (/login\.live\.com|login\.microsoftonline/.test(page.url())) {
      if (has('no-login')) return out({ ok: false, stage: 'need-login', _rc: 1 });
      // —— 登录流程（状态机：邮箱页/密码页/选账户/保持登录）——
      for (let step = 0; step < 8; step++) {
        if (await page.$('input[type="email"]')) {
          await page.fill('input[type="email"]', EMAIL);
          await page.click('#idSIButton9, button[type="submit"], input[type="submit"]');
          await page.waitForTimeout(2500); continue;
        }
        if (await page.$('#idBtn_Back')) {  // 个人/工作账户选择
          await page.click('#idBtn_Back'); await page.waitForTimeout(1500); continue;
        }
        if (await page.$('input[type="password"]')) {
          await page.fill('input[type="password"]', PASSWORD);
          await page.click('#idSIButton9, button[type="submit"], input[type="submit"]');
          await page.waitForTimeout(3500); continue;
        }
        if (await page.$('#idSIButton9')) {  // 保持登录？
          await page.click('#idSIButton9'); await page.waitForTimeout(3000); continue;
        }
        await page.waitForTimeout(1500);
        if (!/login\.(live|microsoftonline)\.com/.test(page.url())) break;
      }
      const bodyTxt = await page.evaluate(() => document.body.innerText.slice(0, 800)).catch(() => '');
      if (/password is incorrect|that password/i.test(bodyTxt)) {
        const f = await shot('badpass');
        return out({ ok: false, stage: 'bad-password', error: '邮箱密码错误（Microsoft 明确拒绝，请核对控制台里的邮箱密码）', shot: f, hint: bodyTxt.replace(/\n/g, ' ').slice(0, 200), _rc: 1 });
      }
      if (/verify your identity|Help us protect|prove you|验证身份|protect your account/i.test(bodyTxt) || /login\.live\.com/.test(page.url())) {
        const f = await shot('challenge');
        return out({ ok: false, stage: 'challenge', error: 'Microsoft 风控/二次验证: ' + page.url(), shot: f, hint: bodyTxt.replace(/\n/g, ' ').slice(0, 200), _rc: 2 });
      }
    }

    // 2) 已登录态：确保落在收件箱（微软有时引到 account.microsoft.com）
    for (const u of ['https://outlook.live.com/mail/0/', 'https://outlook.office.com/mail/0/', 'https://outlook.live.com/mail/0/inbox']) {
      if (await page.$('div[role="option"]')) break;
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(4000);
      // 又被弹去营销页说明会话没带上，重走一次登录
      if (/login\.live\.com/.test(page.url())) break;
    }
    await page.waitForSelector('div[role="option"]', { timeout: 45000 });
    // 3) 找最新一封 TikTok 邮件 —— ⚠️ 新码邮件常有 10~30s 延迟，而收件箱里
    //    躺着上一轮的旧码邮件。直接抓会拿到过期码（2026-09-28 实测被拒）。
    //    策略：轮询等「新邮件」（列表相对时间 ≤4 分钟），~90s 后放弃等待、
    //    退而取最新一封（总预算 180s 内）。
    const readInbox = () => page.$$eval('div[role="option"]', els => els.map(e => ({
      label: e.getAttribute('aria-label') || '', text: (e.innerText || '').slice(0, 160),
    })));
    const ageMinutes = (s) => {
      const t = s.toLowerCase();
      if (/just now|\d+\s*second/.test(t)) return 0;
      const mm = t.match(/(\d+)\s*min/);
      if (mm) return parseInt(mm[1], 10);
      return 999; // 钟点时间/Yesterday/日期 = 判不了或旧
    };
    let hitIdx = -1, waitedPolls = 0;
    for (let poll = 0; poll < 9; poll++) {
      const items = await readInbox();
      hitIdx = items.findIndex(it => /tiktok/i.test(it.label + ' ' + it.text));
      if (hitIdx >= 0) {
        const age = ageMinutes(items[hitIdx].label + ' ' + items[hitIdx].text);
        if (age <= 4 || poll >= 6) break;   // 够新，或等太久认命用最新的
      }
      waitedPolls = poll + 1;
      await page.waitForTimeout(12000);
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForSelector('div[role="option"]', { timeout: 30000 }).catch(() => {});
    }
    if (hitIdx < 0) {
      const items = await readInbox().catch(() => []);
      return out({ ok: false, stage: 'no-tiktok-mail', inbox_first3: items.slice(0, 3), _rc: 1 });
    }
    await page.$$eval('div[role="option"]', (els, i) => els[i].click(), hitIdx);
    await page.waitForTimeout(3000);
    // 4) 读正文抓 6 位码
    const body = await page.evaluate(() => {
      const m = document.querySelector('div[role="main"]');
      return (m ? m.innerText : document.body.innerText).slice(0, 4000);
    });
    const m = body.match(/\b([A-Z0-9]{6})\b/);
    const subj = (body.split('\n').find(l => /verification|code/i.test(l)) || '').slice(0, 80);
    if (!m) {
      const f = await shot('nocode');
      return out({ ok: false, stage: 'no-code', subject: subj, body_head: body.slice(0, 300), shot: f, _rc: 1 });
    }
    return out({ ok: true, stage: 'code', code: m[1], subject: subj });
  } catch (e) {
    const f = await shot('err');
    return out({ ok: false, stage: 'exception', error: String(e).slice(0, 300), url: page.url().slice(0, 120), shot: f, _rc: 1 });
  } finally {
    await ctx.close().catch(() => {});
  }
})();
