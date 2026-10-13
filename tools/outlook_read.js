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
    // 3) 找最新一封 TikTok 验证码邮件 —— 三级查找（2026-09-28 no-code 教训）：
    //    ① 焦点收件箱：轮询等 ≤4min 新邮件，~90s 后认命取最新
    //    ② 「其他」收件箱：Outlook 常把陌生发件人分到 Other
    //    ③ 垃圾邮件文件夹：新 Outlook 账号 TikTok 邮件高发进 Junk
    // 3) 找最新一封 TikTok 验证码邮件 —— v2（2026-10-13 大改版）：
//    ① 新邮件只落「Other」标签页（微软已把 TikTok 发件人分流出 Focused，
//       Focused 里只剩 10-09 前的旧邮件）—— 每轮轮询前先确保切到 Other；
//    ② 投递延迟实测 7~10 分钟（号池看板对照实锤）—— 轮询预算放宽到 ~12 分钟；
//    ③ 时区无关的「位置增量」判定：进入时快照现有验证码邮件集合，轮询中
//       出现集合外的新邮件才命中 —— 旧邮件的死码绝不再兜底（旧逻辑打开
//       10-08 的旧邮件抓死码提交，被 TikTok 拒 → no-code / otp-stuck）。
const readList = () => page.$$eval('div[role="option"]', els => els.map(e => ({
  label: e.getAttribute('aria-label') || '', text: (e.innerText || '').slice(0, 200),
})));
const isCodeMail = (s) => /verif|code|验证/i.test(s);
const snapKey = (it) => (it.label || '') + '|' + (it.text || '').slice(0, 60);
const gotoOtherTab = async () => {
  for (const sel of ['span:text-is("Other")', 'button:has-text("Other")', '[role="tab"]:has-text("Other")', 'span:text-is("其他")', 'button:has-text("其他")']) {
    const okc = await page.click(sel, { timeout: 1500 }).then(() => true).catch(() => false);
    if (okc) { await page.waitForTimeout(2500); return true; }
  }
  return false;
};
const snapFreshSet = async (set) => {
  const items = await readList().catch(() => []);
  items.forEach((it) => {
    const hay = it.label + ' ' + it.text;
    if (/tiktok/i.test(hay) && isCodeMail(hay)) set.add(snapKey(it));
  });
  return set;
};
// 基线 1：Other 收件箱现有验证码邮件 = 旧邮件
let baselineSet = new Set();
await gotoOtherTab();
baselineSet = await snapFreshSet(baselineSet);
// 基线 2：垃圾邮件文件夹（顺路快照，后面兜底扫描时同样只认新邮件）
await page.goto('https://outlook.live.com/mail/0/junkemail', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
await page.waitForSelector('div[role="option"]', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);
baselineSet = await snapFreshSet(baselineSet);
await page.goto('https://outlook.live.com/mail/0/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
await page.waitForSelector('div[role="option"]', { timeout: 30000 }).catch(() => {});
const freshFind = async () => {
  const items = await readList().catch(() => []);
  let hit = -1;
  items.forEach((it, i) => {
    const hay = it.label + ' ' + it.text;
    if (hit >= 0) return;
    if (!/tiktok/i.test(hay) || !isCodeMail(hay)) return;
    if (baselineSet.has(snapKey(it))) return;      // 快照里已有 = 旧邮件，跳过
    hit = i;                                        // 列表 newest-first，取第一条新邮件
  });
  return hit;
};
let hitIdx = -1;
for (let poll = 0; poll < 34 && hitIdx < 0; poll++) {
  await gotoOtherTab();
  hitIdx = await freshFind();
  if (hitIdx >= 0) break;
  await page.waitForTimeout(20000);
  // 每 3 轮强刷一次（防 live-update 失灵）；窗口尾声把垃圾箱也扫一遍（同样只认新邮件）
  if (poll % 3 === 2) {
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForSelector('div[role="option"]', { timeout: 30000 }).catch(() => {});
  }
  if (poll === 27) {
    await page.goto('https://outlook.live.com/mail/0/junkemail', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForSelector('div[role="option"]', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    hitIdx = await freshFind();
    if (hitIdx >= 0) break;
    await page.goto('https://outlook.live.com/mail/0/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForSelector('div[role="option"]', { timeout: 30000 }).catch(() => {});
  }
}
if (hitIdx < 0) {
  const items = await readList().catch(() => []);
  return out({ ok: false, stage: 'no-fresh-code',
    error: '等待约 12 分钟未出现新验证码邮件（Other 收件箱 + 垃圾箱均无）。投递延迟 7~10 分钟属正常，持续缺码多为 TikTok 侧限频静默丢弃。',
    inbox_first3: items.slice(0, 3), _rc: 1 });
}
await page.$$eval('div[role="option"]', (els, i) => els[i].click(), hitIdx);
    await page.waitForTimeout(3000);
    // 4) 读正文抓 6 位码
    const body = await page.evaluate(() => {
      const m = document.querySelector('div[role="main"]');
      return (m ? m.innerText : document.body.innerText).slice(0, 4000);
    });
    let m = body.match(/\b([A-Z0-9]{6})\b/);
    if (!m) {
      // 兜底：从列表项预览文本抓码（预览常含验证码数字）
      const items2 = await readList().catch(() => []);
      const hay2 = items2[hitIdx] ? (items2[hitIdx].label + ' ' + items2[hitIdx].text) : '';
      m = hay2.match(/\b([A-Z0-9]{6})\b/);
    }
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
