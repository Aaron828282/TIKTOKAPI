'use strict';
/**
 * AI Studio 账号「自登录」模块 —— kind=google_login 凭据的消费者。
 *
 * 背景（2026-09-27 实锤）：Google 会话是环境绑定的，人工导出的 cookie 离开
 * 原浏览器几分钟就被 1PSIDTS 轮换作废。所以 Google 线的凭据不再走 cookie，
 * 而是「邮箱 + 密码 + Gmail 应用专用密码」：节点在自己的持久化 profile 里
 * 走一次完整的网页登录，登录态由 profile 常驻自持；之后几百次生成直接复用，
 * 只有会话真失效时才重新走一遍登录。登录中若 Google 弹验证码挑战，用
 * 应用专用密码经 IMAP 从 Gmail 收件箱自动取码填入。
 *
 * 设计约束：
 *  - 纯函数式编排，不持有全局状态；调用方（执行器/金丝雀脚本）自带
 *    Playwright context 与日志通道。
 *  - 凭据不落盘、不打日志（日志里只出现脱敏邮箱）。
 *  - 每一步的关键决策点都截图，便于事后回放（xvfb 无显示器也看得见）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOGIN_TIMEOUT_MS = 180_000;   // 密码 → (挑战 → IMAP 取码) → 落地 的总预算
const IMAP_POLL_MS = 5_000;         // 收件箱轮询间隔
const CODE_MAX_AGE_MS = 10 * 60_000; // 只认最近 10 分钟内的验证码邮件（防旧码回灌）

/** 邮箱脱敏：pro1@gmail.com → pr***@gmail.com。日志/报表统一走这里。 */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  return s.slice(0, 2) + '***' + s.slice(at);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------- TOTP
// 纯 crypto 实现（HMAC-SHA1 / 30s 窗口），零依赖 —— 2SV 挑战页没有邮件
// 验证码选项（2026-09-27 金丝雀实测），Authenticator 的 setup key 是唯一
// 不消耗、不依赖网络的自动化路径。

function _base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let val = 0; const out = [];
  for (const c of String(s || '').toUpperCase()) {
    const idx = A.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 当前 30s 窗口的 6 位 TOTP 码。允许 ±1 窗口时钟漂移由 Google 侧自己容忍。 */
function totpCode(secretB32, atMs) {
  const key = _base32Decode(secretB32);
  if (!key.length) throw new Error('TOTP 密钥解不出（base32）');
  const counter = Math.floor((atMs || Date.now()) / 30_000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE((counter >>> 0) >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16)
    | (h[off + 2] << 8) | h[off + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}

/**
 * 反「This browser or app may not be secure」：Google 登录页会查
 * navigator.webdriver 与 client-hints 指纹，裸 Playwright Chromium 必被
 * 拦在 signin/rejected。必须在进登录页**之前**挂好（2026-09-27 实测）。
 * 与执行器 aistudio.js 的 _spoofPage 同款口径。
 */
async function applySpoof(context, page, log) {
  try {
    let version = '';
    try { version = context.browser() ? context.browser().version() : ''; } catch { /* 无 */ }
    const full = version || '153.0.8010.54';
    const major = full.split('.')[0];
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        + ` (KHTML, like Gecko) Chrome/${full} Safari/537.36`,
      userAgentMetadata: {
        brands: [
          { brand: 'Google Chrome', version: major },
          { brand: 'Chromium', version: major },
          { brand: 'Not_A Brand', version: '24' },
        ],
        fullVersionList: [
          { brand: 'Google Chrome', version: full },
          { brand: 'Chromium', version: full },
          { brand: 'Not_A Brand', version: '24.0.0.0' },
        ],
        fullVersion: full,
        platform: 'Windows', platformVersion: '10.0.0',
        architecture: 'x86', bitness: '64', model: '',
        mobile: false, wow64: false, formFactors: ['Desktop'],
      },
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // Google 登录页还会探测 chrome.runtime / permissions 行为
      window.chrome = window.chrome || { runtime: {} };
    });
  } catch (err) {
    (log || (() => {}))(`  [login] 指纹伪装失败（裸跑）:${err.message}`, 'warn');
  }
}

async function shot(page, dir, name) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: false });
  } catch { /* 截图失败不阻断主流程 */ }
}

// ---------------------------------------------------------------- IMAP 取码

/**
 * 从 Gmail 收件箱拉 Google 登录验证码。
 *
 * 为什么用应用专用密码而不是「用户手发验证码」：登录是无人值守的（凌晨、
 * 会话过期自动触发），人工通道会把整条自愈链路打断成等待人工。
 *
 * 只认 `sinceTs` 之后来自 accounts.google.com 的邮件，提取 G-xxxxxx；
 * 轮询到 deadline 为止。返回 null = 到点没等到（调用方决定怎么处置）。
 */
async function fetchVerificationCode({ email, appPassword, log, sinceTs, maxWaitMs }) {
  let ImapFlow;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    ImapFlow = require('imapflow').ImapFlow;
  } catch (e) {
    throw new Error('未安装 imapflow（npm i imapflow）—— IMAP 取码不可用: ' + e.message);
  }
  const since = new Date((sinceTs || Date.now()) - 60_000);
  const deadline = Date.now() + (maxWaitMs || 120_000);
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: String(email), pass: String(appPassword).replace(/\s+/g, '') },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
  await client.connect();
  const logline = log || (() => {});
  try {
    const lock = client.getMailboxLock('INBOX');
    try {
      while (Date.now() < deadline) {
        let uids = [];
        try {
          uids = await client.search({ since, from: 'accounts.google.com' }) || [];
        } catch (e) {
          logline(`  [imap] search 失败：${e.message}，重试`);
        }
        // 只看最新的 3 封，别在验证码轰炸时抓到旧码
        for (const uid of uids.slice(-3)) {
          const msg = await client.fetchOne(String(uid), { bodyStructure: true, source: true });
          const text = String(msg.source || '');
          const age = Date.now() - (msg.date ? new Date(msg.date).getTime() : Date.now());
          if (age > CODE_MAX_AGE_MS) continue;
          const m = text.match(/G-(\d{6})/) || text.match(/\b(\d{6})\b\s*(?:\n|$)/);
          if (m) {
            logline(`  [imap] 取到验证码（邮件 uid=${uid}，${Math.round(age / 1000)}s 前）`);
            return m[1];
          }
        }
        await sleep(IMAP_POLL_MS);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return null;
}

// ---------------------------------------------------------------- 登录编排

/**
 * profile 里是否握着有效的 Google 登录态。
 *
 * ⚠️ 不能用「页面 URL 停在 aistudio.google.com」判：未登录访问 AI Studio
 * 首页也不跳 accounts.google.com（前端 JS 延迟重定向），实测会误判"已登录"。
 * SID + SAPISID cookie 在场才是确定性信号（号池侧同款校验口径）。
 */
async function hasLiveSession(context) {
  const cookies = await context.cookies('https://aistudio.google.com/');
  const names = new Set(cookies.map((c) => c.name));
  return names.has('SID') && (names.has('SAPISID')
    || names.has('__Secure-1PAPISID') || names.has('__Secure-3PAPISID'));
}

/**
 * 确保这个持久化 profile 处于已登录状态。
 *
 * @param {{context: object, creds: {email,password,app_password}, log: function,
 *          shotsDir: string}} opts
 * @returns {{status: 'already'|'logged_in'|'challenge'|'failed', page, detail?}}
 *
 * 挑战处理只自动化「邮件验证码」这条路（Gmail 账号在 Try another way 里
 * 通常提供）。其他挑战形态（手机提示/备用码）截图后原样上报 —— 那需要
 * 人决策，绝不瞎猜乱点。
 */
async function ensureLogin({ context, creds, log, shotsDir }) {
  const out = log || (() => {});
  const email = String(creds.email || '');
  out(`  [login] 开始自登录：${maskEmail(email)}`);
  const sinceTs = Date.now();

  const page = await context.newPage();
  await applySpoof(context, page, out);
  const tag = (n) => path.join(shotsDir, n);

  // 第 0 步：先看会话是否还活着（profile 常驻的日常路径 —— 大多数调用走这里）
  await page.goto('https://aistudio.google.com/', {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  }).catch(() => {});
  await page.waitForTimeout(4_000);
  if (await hasLiveSession(context)) {
    out('  [login] 会话仍有效（SID/SAPISID 在场，profile 自持），跳过登录');
    return { status: 'already', page };
  }
  await shot(page, shotsDir, '1-need-login');

  // 第 1 步：进登录页。优先点落地页的「Get started」（真人路径，refer 链
  // 自然）；点不到再直接跳 signin URL。强制英文界面，选择器才稳定。
  const goSignin = async () => {
    const btn = await page.$('a:has-text("Get started"), a:has-text("Sign in")');
    if (btn) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(5_000);
    }
    if (!(await page.$('input[type="email"]'))) {
      await page.goto('https://accounts.google.com/v3/signin/identifier?continue='
        + encodeURIComponent('https://aistudio.google.com/')
        + '&flowName=GlifWebSignIn&hl=en', {
        waitUntil: 'domcontentloaded', timeout: 60_000,
      }).catch(() => {});
      await page.waitForTimeout(4_000);
    }
  };
  await goSignin();
  await shot(page, shotsDir, '2-signin-page');
  // Google v3 登录页的输入框 id 是 identifierId；多选择器兜底
  //（type 属性在部分渲染下不是 email）。
  const emailInput = await page.waitForSelector(
    '#identifierId, input[name="identifier"], input[type="email"]',
    { timeout: 45_000, state: 'visible' },
  ).catch(() => null);
  if (!emailInput) {
    const inputs = await page.$$eval('input',
      (els) => els.map((el) => `${el.tagName}[type=${el.type}]#${el.id}[name=${el.name}]`))
      .catch(() => []);
    const body = await page.innerText('body').catch(() => '');
    return { status: 'failed', page,
      detail: `登录页没找到邮箱输入框（url=${page.url().slice(0, 120)}；`
        + `inputs=${inputs.join(' | ') || '无'}）：`
        + body.slice(0, 200).replace(/\s+/g, ' ') };
  }
  await page.fill('#identifierId, input[name="identifier"], input[type="email"]', email);
  await page.click('#identifierNext');
  out('  [login] 邮箱已提交');

  // 第 2 步起：统一轮询。Google 的流程顺序不固定（密码页可能在
  // /v3/signin/challenge/pwd，也可能 identifier 页预置了隐藏密码框），
  // 所以「看到什么填什么」：密码框 → 填密码；pin 框 → TOTP/备用码；
  // 2SV 选择页 → 点可自动化的挑战项。绝不盲点无关按钮。
  let passSubmitted = false;
  let selectionTries = 0;
  const usedBackup = new Set();
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000);
    const url = page.url();
    if (await hasLiveSession(context)) {
      await shot(page, shotsDir, '3-landed');
      out('  [login] 登录成功，已落地 AI Studio');
      return { status: 'logged_in', page };
    }

    // 密码框（首次 or 挑战页重询）：只提交一次，错了不重试（防锁号）。
    // 例外：「Verify it's you」→ Account recovery 页（2SV 关闭后新设备/IP
    // 首登仍会触发风控确认，Try another way 落到「输入你记得的最后一次密码」）
    // 要的就是当前正确密码 —— 允许在这里第二次提交，不算盲目重试。
    const recoveryPage = /recovery|last.?password/i.test(url)
      || /account recovery|enter the last password/i.test(
        await page.innerText('body').catch(() => ''));
    const pass = await page.$('#password input[type="password"], input[type="password"]:visible');
    if (pass && (!passSubmitted || recoveryPage)) {
      passSubmitted = true;
      await shot(page, shotsDir, '2-password-page');
      await pass.fill(String(creds.password || ''));
      const next = await page.$('#passwordNext, button:has-text("Next")');
      if (next) await next.click().catch(() => {});
      else await pass.press('Enter').catch(() => {});
      out('  [login] 密码已提交');
      continue;
    }

    // pin 输入框：优先 TOTP（不消耗），否则按顺序烧备用码；
    // 都没有但配了应用专用密码 → 走 IMAP 收「Google 发到本邮箱的验证码」
    // （Account recovery / 异常登录确认会给这个选项）
    const pin = await page.$('input[name="pin"], #idvPin');
    if (pin) {
      let code = '';
      if (creds.totp_secret) {
        code = totpCode(creds.totp_secret);
        out('  [login] 提交 TOTP 码（当前 30s 窗口）');
      } else if ((creds.backup_codes || []).length) {
        const avail = creds.backup_codes.filter((c) => !usedBackup.has(c));
        if (!avail.length) {
          await shot(page, shotsDir, '5-codes-exhausted');
          return { status: 'challenge', page, detail: '备用码已用尽，需补充新的备用码' };
        }
        code = avail[0];
        usedBackup.add(code);
        out(`  [login] 提交备用码（已烧 ${usedBackup.size} 张）`);
      } else if (creds.app_password) {
        out('  [login] 无 TOTP/备用码，走 IMAP 收发往本邮箱的验证码');
        const mailed = await fetchVerificationCode({
          email: creds.email, appPassword: creds.app_password,
          log: out, sinceTs, maxWaitMs: 90_000,
        });
        if (!mailed) {
          await shot(page, shotsDir, '5-no-mail-code');
          return { status: 'challenge', page, detail: '验证码挑战：IMAP 到点未取到码' };
        }
        code = mailed;
      } else {
        await shot(page, shotsDir, '5-no-second-factor');
        return { status: 'challenge', page,
          detail: '验证码挑战但无可用第二因子（TOTP/备用码/应用专用密码都没配）' };
      }
      await shot(page, shotsDir, '4-challenge-pin');
      await pin.fill(code);
      const next = await page.$('#idvAnyNext, #pinNext, button:has-text("Next")');
      if (next) await next.click().catch(() => {});
      else await pin.press('Enter').catch(() => {});
      await shot(page, shotsDir, '6-code-submitted');
      continue;
    }

    // 2SV 选择页 / 短信验证码页 / Verify it's you：轮着点「Try another way」
    // 直到翻出 Authenticator（Google 每点一次轮换一个选项，短信页也有入口）
    const bodyText = await page.innerText('body').catch(() => '');
    if (/2-Step Verification|Choose how you want to sign in|Verify it.s you|Get a verification code|Enter the code/i.test(bodyText)) {
      selectionTries += 1;
      if (selectionTries > 8) {
        await shot(page, shotsDir, '4-challenge-unknown');
        return { status: 'challenge', page,
          detail: `两步验证页找不到可自动化的挑战项（url=${url.slice(0, 120)}）：`
            + bodyText.slice(0, 300).replace(/\s+/g, ' ') };
      }
      await shot(page, shotsDir, `4-challenge-select-${selectionTries}`);
      const picked = await _pickChallengeOption(page, creds, out);
      if (!picked && selectionTries >= 4) {
        return { status: 'challenge', page,
          detail: `两步验证页点不出 Authenticator/备用码选项：`
            + bodyText.slice(0, 300).replace(/\s+/g, ' ') };
      }
      continue;
    }

    // 其余未知拦截（异常风控/账号停用）：交给人
    if (/speedbump|denied|suspended|rejected/i.test(url)) {
      await shot(page, shotsDir, '7-blocked');
      return { status: 'challenge', page,
        detail: `未知拦截（${url.slice(0, 120)}）：${bodyText.slice(0, 300).replace(/\s+/g, ' ')}` };
    }
    if (/wrong.?password|couldn.t find your google account|suspended/i.test(url)) break;
  }
  await shot(page, shotsDir, '7-timeout');
  const body = await page.innerText('body').catch(() => '');
  return { status: 'failed', page,
    detail: `登录未在预算内落地：${body.slice(0, 300).replace(/\s+/g, ' ')}` };
}

/** 在 2SV 选择页点一条可自动化的挑战。返回点了什么（null=没点到）。 */
async function _pickChallengeOption(page, creds, out) {
  const want = [];
  if (creds.totp_secret) want.push('Authenticator');
  if ((creds.backup_codes || []).length) want.push('backup code', 'Backup codes', 'one-time');
  for (const text of want) {
    const opt = await page.$(`div[role="link"]:has-text("${text}"),`
      + ` li[role="link"]:has-text("${text}"), li:has-text("${text}"),`
      + ` div[role="button"]:has-text("${text}"), a:has-text("${text}")`);
    if (opt) {
      await opt.click().catch(() => {});
      out(`  [login] 选择挑战：${text}`);
      return text;
    }
  }
  const more = await page.$('div[role="link"]:has-text("Try another way"),'
    + ' button:has-text("Try another way")');
  if (more) {
    await more.click().catch(() => {});
    out('  [login] 展开 Try another way');
    return 'another-way';
  }
  return null;
}

module.exports = { ensureLogin, fetchVerificationCode, totpCode, applySpoof, maskEmail, hasLiveSession };
