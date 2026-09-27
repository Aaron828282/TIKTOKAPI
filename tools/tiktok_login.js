#!/usr/bin/env node
/**
 * TikTok 广告平台自动登录器（自动续期 Phase 2，2026-09-28）
 *
 * 被谁调：lib/ttautologin.js（spawn 子进程）。也可以手工跑：
 *
 *   echo '{"account_id":1,"email":"a@outlook.com","email_pass":"..",
 *          "tiktok_pass":"..","profile_dir":"data/tt-profiles/1"}' \
 *     | node tools/tiktok_login.js
 *
 * 输入（stdin JSON）：
 *   account_id  账号 id（号池 agent_accounts.id，用于日志）
 *   email       TikTok 登录邮箱
 *   email_pass  邮箱密码（TikTok 弹邮箱验证码时经 outlook 网页接码收取）
 *   tiktok_pass TikTok 登录密码
 *   profile_dir Playwright 持久 profile 目录（登录态在这里常驻自持）
 *   headless    默认 true；DISPLAY=:98 + headless=false 可有头调试
 *
 * 输出（stdout **最后一行**是 JSON，父进程只认这行）：
 *   {ok, stage, cookie?, user_agent?, error?, shot?}
 *   cookie = 所有 *.tiktok.com cookie 拼成的 header 串（含 httpOnly 的
 *   sessionid_ads —— 这正是控制台手工粘贴时最难拿到的那个）。
 *
 * 退出码：0 成功 / 1 失败 / 2 遇到自动化扛不住的挑战（需人工，如滑块）。
 *
 * 为什么网页登录而不是协议登录：TikTok 广告线登录有完整的设备指纹 +
 * 风控链（tt_webid / SLARDAR 埋点 / Guard EC 私钥），裸 HTTP 重放扛不住，
 * 真浏览器 + 持久 profile 是唯一实测能长期存活的路径。
 */
'use strict';

const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------- 输入输出

let CFG = {};
try {
  // stdin 整段读进来再 parse（父进程一次 write + end，没有分帧问题）
  CFG = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (e) {
  console.log(JSON.stringify({ ok: false, stage: 'config', error: 'stdin 不是合法 JSON: ' + e.message }));
  process.exit(1);
}
const OUT = (obj) => { console.log(JSON.stringify(obj)); process.exit(obj._rc || (obj.ok ? 0 : 1)); };

const EMAIL = String(CFG.email || '');
const EMAIL_PASS = String(CFG.email_pass || '');
const TT_PASS = String(CFG.tiktok_pass || '');
const PROFILE = String(CFG.profile_dir || path.join('data', 'tt-profiles', String(CFG.account_id || 'default')));
const HEADLESS = CFG.headless !== false;
const SHOTS = path.join('/tmp', 'tt-login-' + (CFG.account_id || 'x'));
const OTP_TOOL = path.join(__dirname, 'outlook_read.js');
const OTP_PROFILE_ROOT = path.join('data', 'mail-profiles');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 指纹伪装 —— **必须在 goto 之前挂**。
 * 裸 headless Chromium 的 UA 带 `HeadlessChrome`，TikTok 的 WAF 直接对主文档
 * 回 403 白屏（2026-09-28 实测）。CDP 覆盖成正常有头 Chrome UA +
 * client-hints + 去 navigator.webdriver 后，200 正常渲染。
 * 与 lib/aistudio_login.js 的 applySpoof 同款口径。
 */
async function applySpoof(ctx, page) {
  let version = '';
  try { version = ctx.browser() ? ctx.browser().version() : ''; } catch { /* 无 */ }
  const full = version || '140.0.0.0';
  const major = full.split('.')[0];
  const cdp = await ctx.newCDPSession(page);
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
    window.chrome = window.chrome || { runtime: {} };
  });
}

/** 给一个 page 挂伪装（含未来弹出的新 page）。 */
async function spoofPage(ctx, page) {
  try { await applySpoof(ctx, page); } catch { /* 伪装失败裸跑 */ }
  return page;
}

if (!EMAIL || !TT_PASS) {
  OUT({ ok: false, stage: 'config', error: '缺 email 或 tiktok_pass' });
}

// ---------------------------------------------------------------- 小工具

let shotN = 0;
async function shot(page, tag) {
  try {
    fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, `${String(++shotN).padStart(2, '0')}-${tag}.png`);
    await page.screenshot({ path: f }).catch(() => {});
    return f;
  } catch { return null; }
}

/** 点第一个能点的（可见 + enabled），成功返回 true。 */
async function clickFirst(page, selectors, { timeout = 2500 } = {}) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout });
      if (await el.isEnabled()) { await el.click(); return sel; }
    } catch { /* 下一个 */ }
  }
  return null;
}

async function fillFirst(page, selectors, value, { timeout = 3000 } = {}) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      await el.waitFor({ state: 'visible', timeout });
      await el.fill(value);
      return sel;
    } catch { /* 下一个 */ }
  }
  return null;
}

// ---------------------------------------------------------------- 邮箱接码

/**
 * 调 outlook 网页接码器取 TikTok 验证码。一次性子进程：拿到码就退出，
 * 内存立即归还 —— 这也是为什么整个登录器本身也做成子进程。
 * 发件人过滤交给接码器外的正则：TikTok 的码邮件标题带「TikTok」/「verify」，
 * 接码器抓的是收件箱里最近的 6 位码 —— 刚触发的登录是最新一封，天然正确。
 */
function fetchOtpCode(log) {
  return new Promise((resolve) => {
    const local = EMAIL.split('@')[0].toLowerCase();
    const child = spawn(process.execPath, [
      OTP_TOOL,
      '--email', EMAIL,
      '--password', EMAIL_PASS,
      '--profile-dir', path.join(OTP_PROFILE_ROOT, local),
    ], { cwd: process.cwd() });
    let stdout = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } finish(null); }, 180_000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('error', (e) => { log(`接码器启动失败：${e.message}`); finish(null); });
    child.on('close', () => {
      const lines = stdout.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{')) {
          try {
            const r = JSON.parse(line);
            if (r.ok && r.code) return finish(r);
            return finish({ error: r.error || r.stage || 'no-code' });
          } catch { /* 不是这行 */ }
        }
      }
      finish({ error: '接码器无输出' });
    });
  });
}

// ---------------------------------------------------------------- 形状验证码求解

/**
 * 「点选两个相同形状」验证码求解（2026-09-28 接入，本机真图实测通过）。
 *
 * 链路：检测 widget → 截图验证码图 → 子进程跑 Python 求解器（CV，零打码
 * 平台成本）→ 归一化坐标 → **人类化鼠标轨迹**点击两个物体 → 点 Confirm。
 * 失败让主循环下一轮重新检测重试（TikTok 会自动换新图）；连续失败超限才
 * 报人工。验证码可能在 iframe（captcha 域）也可能就地渲染 —— 两种都找。
 */
const SOLVER_PY = path.join(__dirname, 'captcha_solver', 'solver.py');

function captchaPython() {
  if (process.env.RH_CAPTCHA_PY) return process.env.RH_CAPTCHA_PY;
  const local = path.join(__dirname, 'captcha_solver', 'venv',
    process.platform === 'win32' ? 'Scripts\\python.exe' : 'bin', 'python');
  for (const c of [local, '/opt/rhnode/tools/captcha_solver/venv/bin/python']) {
    try { if (fs.existsSync(c)) return c; } catch { /* 无 */ }
  }
  return 'python3';  // 兜底：系统 python（需自行装 opencv-headless + numpy）
}

/** 在所有 frame 里找形状验证码的图区元素，返回 {frame, el} 或 null。 */
async function findShapeCaptcha(page) {
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
  for (const frame of frames) {
    // 候选容器：captcha 专域 iframe 的 body / 主页面里 id|class 带 captcha 的可见块
    let containers = [];
    if (/captcha/i.test(frame.url())) {
      containers = [frame.locator('body')];
    } else if (frame === page.mainFrame()) {
      const pageText = (await page.textContent('body').catch(() => '')) || '';
      if (!/select\s*2|same\s*shape|选择两个|两个相同|形状相同/i.test(pageText)) continue;
      containers = [
        frame.locator('[id*="captcha" i]'),
        frame.locator('[class*="captcha" i]'),
      ];
    } else {
      const ft = (await frame.textContent('body').catch(() => '')) || '';
      if (!/select\s*2|same\s*shape|选择两个|两个相同|形状相同/i.test(ft)) continue;
      containers = [frame.locator('body')];
    }
    for (const c of containers) {
      const n = await c.count().catch(() => 0);
      for (let k = 0; k < Math.min(n, 4); k++) {
        const box = c.nth(k);
        if (!(await box.isVisible().catch(() => false))) continue;
        const bb = await box.boundingBox().catch(() => null);
        if (!bb || bb.width < 150 || bb.height < 100) continue;
        // 优先容器内的 img/canvas（更贴近验证码图本体）；没有就用容器整体
        let el = null;
        for (const sel of ['img', 'canvas', 'div[style*="background-image"]']) {
          const inner = box.locator(sel).first();
          if (await inner.isVisible().catch(() => false)) { el = inner; break; }
        }
        el = el || box;
        return { frame, el };
      }
    }
  }
  return null;
}

/** 跑一次求解并人类化点击。返回 true = 已点完 Confirm（成败由主循环判定）。 */
async function solveShapeCaptchaOnce(cap, page, log) {
  const SHOT_TMP = path.join(SHOTS, `captcha-${Date.now()}.png`);
  fs.mkdirSync(SHOTS, { recursive: true });
  await cap.el.screenshot({ path: SHOT_TMP });
  // 子进程求解：stdout 最后一行 JSON。20s 超时强杀 —— 求解器卡死不能拖垮登录。
  const result = await new Promise((resolve) => {
    const py = spawn(captchaPython(), [SOLVER_PY, SHOT_TMP]);
    let so = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { py.kill('SIGKILL'); } catch { /* */ } resolve(r); } };
    setTimeout(() => finish(null), 20_000);
    py.stdout.on('data', (c) => { so += c; });
    py.on('error', (e) => { log(`求解器启动失败（${captchaPython()}）：${e.message}`); finish(null); });
    py.on('close', () => {
      const lines = so.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{')) {
          try { return finish(JSON.parse(line)); } catch { /* 不是这行 */ }
        }
      }
      finish(null);
    });
  });
  try { fs.unlinkSync(SHOT_TMP); } catch { /* 留着也行 */ }
  if (!result || !result.ok || !Array.isArray(result.points) || result.points.length !== 2) {
    log(`求解失败：${result && result.reason ? result.reason : '无输出/超时'}`);
    return false;
  }
  const bb = await cap.el.boundingBox().catch(() => null);
  if (!bb) { log('验证码图区 boundingBox 拿不到（可能已消失）'); return false; }

  // 人类化点击：缓动 + 抖动 + 变速，两击之间随机停顿。坐标 = 截图区
  // boundingBox × 归一化比例（与截图分辨率/DPR 无关）。
  const humanClick = async (relX, relY) => {
    const tx = bb.x + bb.width * relX;
    const ty = bb.y + bb.height * relY;
    let sx = tx + (Math.random() * 240 - 120);
    let sy = ty + (Math.random() * 180 - 90);
    await page.mouse.move(sx, sy);
    const steps = 12 + Math.floor(Math.random() * 10);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 3);
      sx = tx + (sx - tx) * (1 - ease);
      sy = ty + (sy - ty) * (1 - ease);
      await page.mouse.move(
        sx + (Math.random() - 0.5) * 3 * (1 - t),
        sy + (Math.random() - 0.5) * 3 * (1 - t));
      await sleep(12 + Math.random() * 26);
    }
    await sleep(80 + Math.random() * 180);
    await page.mouse.down();
    await sleep(45 + Math.random() * 70);
    await page.mouse.up();
  };
  const p = result.points;
  log(`求解成功（score=${result.score}）：点击 (${p[0].rel_x},${p[0].rel_y}) / (${p[1].rel_x},${p[1].rel_y})`);
  await humanClick(p[0].rel_x, p[0].rel_y);
  await sleep(350 + Math.random() * 500);
  await humanClick(p[1].rel_x, p[1].rel_y);
  await sleep(500 + Math.random() * 600);
  // Confirm：优先在验证码所在 frame 里找按钮；找不到就用主页面（就地渲染形态）
  const confirmSel = ['button:has-text("Confirm")', 'button:has-text("确认")',
    '[class*="submit" i] button', 'button:has-text("Verify")'];
  for (const sel of confirmSel) {
    try {
      const btn = cap.frame.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) { await btn.click(); break; }
    } catch { /* 下一个 */ }
  }
  return true;
}

// ---------------------------------------------------------------- 登录状态机

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const log = (m) => { try { process.stderr.write(`[tt-login] ${m}\n`); } catch { /* 无 */ } };

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  let page = ctx.pages()[0] || (await ctx.newPage());
  await spoofPage(ctx, page);
  // 登录流可能弹新窗口（OAuth 子域等），新 page 一律先伪装再干活
  ctx.on('page', (p) => spoofPage(ctx, p).catch(() => {}));

  try {
    // ⚠️ 直连登录页，**不走落地页**：落地页的 Log in 按钮点击行为不稳定
    // （有时弹菜单不导航），而且从落地页点进登录页后 SPA 长时间白屏
    // （实测 5 分钟不渲染）；直连 /i18n/login 则 10s 内表单可用。
    // 已登录的 profile 访问登录页会被重定向回 business 主站 —— 正好当出口判定。
    await page.goto('https://ads.tiktok.com/i18n/login', {
      waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(6000);
    await shot(page, 'entry');

    let otpUsed = false;       // 一次运行最多收一次码（防止连续触发风控）
    let captchaTries = 0;      // 形状验证码已尝试次数（连续失败超限报人工）
    const deadline = Date.now() + 5 * 60_000;
    let step = 0;

    for (; step < 30 && Date.now() < deadline; step++) {
      // 登录页若在新窗口打开（点击 Log in 后常见），把活动页切过去
      if (ctx.pages().length > 1 && !/login|passport|sso/i.test(page.url())) {
        const alt = ctx.pages().find((p) => /login|passport|sso/i.test(p.url()));
        if (alt) { page = alt; await spoofPage(ctx, page); }
      }
      const url = page.url();
      const cookies = await ctx.cookies();
      const hasSess = cookies.some((c) => c.name === 'sessionid_ads');
      const onLogin = /\/login|\/sso\/|passport|identity-verification|verify/i.test(url)
        || !url.includes('ads.tiktok.com');

      // ---- 出口判定：落在 ads.tiktok.com 主站且拿到 sessionid_ads ----
      if (hasSess && !/\/login|passport|identity-verification/i.test(url)) {
        await shot(page, 'success');
        // 给页面一秒补 cookie（有些键是落地后才 set）
        await page.waitForTimeout(1500);
        const all = await ctx.cookies();
        // 只收 *.tiktok.com 域的 cookie（httpOnly 的 sessionid_ads 也在内）
        const tt = all.filter((c) => /tiktok\.com$/.test(c.domain));
        const cookieStr = tt.map((c) => `${c.name}=${c.value}`).join('; ');
        const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
        if (!cookieStr.includes('sessionid_ads=')) {
          OUT({ ok: false, stage: 'cookie', error: '登录页面成功但 cookie 里没有 sessionid_ads', _rc: 1 });
        }
        OUT({ ok: true, stage: 'done', cookie: cookieStr, user_agent: ua });
      }

      if (!onLogin) {
        // 落在营销落地页（ads.tiktok.com/business/...）且还没拿到会话 ——
        // 这里不会自动弹登录框，必须**主动点 Log in**（按钮在页头右上角；
        // 别点 a:has-text 那个 —— .first() 命中的是页脚 y=10000+ 的隐藏链接）。
        if (!hasSess) {
          const clicked = await clickFirst(page, [
            'button:has-text("Log in")', 'button:has-text("登录")',
            'a[href*="login"]',
          ], { timeout: 1500 });
          if (clicked) {
            await page.waitForTimeout(3500);
            await shot(page, 'to-login');
            continue;
          }
        }
        await page.waitForTimeout(2500);
        continue;
      }

      // ---- 挑战：邮箱验证码（身份验证页）----
      const pageText = await page.textContent('body').catch(() => '') || '';
      const needOtp = /verification code|verify.*identity|enter the code|验证码|输入验证码/i
        .test(pageText.slice(0, 4000))
        || await page.locator('input[autocomplete="one-time-code"]').count() > 0
        || await page.locator('input[inputmode="numeric"]').count() >= 4;
      if (needOtp) {
        if (!EMAIL_PASS) {
          // 有时登录只弹形状验证码、不弹邮箱验证码（2026-09-28 实测）——
          // 所以邮箱密码是可选材料；但 OTP 真弹出来而没有它，只能明确失败。
          await shot(page, 'otp-no-pass');
          OUT({ ok: false, stage: 'otp',
            error: '弹出邮箱验证码但控制台未配置邮箱密码（接不了码）', _rc: 1 });
        }
        // 先点「发送验证码」（如果页面要求手动触发）
        await clickFirst(page, [
          'button:has-text("Send code")', 'div:has-text("Send code")',
          'button:has-text("发送验证码")', '[data-e2e="send-code"]',
        ], { timeout: 1200 });
        if (otpUsed) {
          // 码已填过还在这页 → 可能是码错了或新的一封。等 20s 再取新码没意义
          //（TikTok 限频），直接报人工。
          await shot(page, 'otp-stuck');
          OUT({ ok: false, stage: 'otp-stuck',
            error: '验证码页反复出现 —— 码被拒或触发了限频，需人工看一眼', _rc: 2 });
        }
        log('需要邮箱验证码，调网页接码器…');
        await shot(page, 'otp-page');
        const otp = await fetchOtpCode(log);
        if (!otp || !otp.code) {
          OUT({ ok: false, stage: 'otp',
            error: '接码失败：' + (otp ? (otp.error || 'unknown') : '子进程超时'), _rc: 1 });
        }
        log(`取到验证码 ${otp.code}`);
        otpUsed = true;
        // TikTok 的码输入框两种形态：一个整输入框 / 6 个数字小框
        const boxes = page.locator('input[inputmode="numeric"]');
        const nBoxes = await boxes.count().catch(() => 0);
        let filled = null;
        if (nBoxes >= 4) {
          const chars = otp.code.split('');
          for (let i = 0; i < Math.min(nBoxes, chars.length); i++) {
            await boxes.nth(i).fill(chars[i]).catch(() => {});
          }
          filled = 'boxes';
        } else {
          filled = await fillFirst(page, [
            'input[autocomplete="one-time-code"]',
            'input[name="code"]', 'input[name="verifyCode"]',
            'input[placeholder*="code" i]', 'input[placeholder*="验证码"]',
          ], otp.code);
        }
        if (!filled) {
          await shot(page, 'otp-no-input');
          OUT({ ok: false, stage: 'otp', error: '取到码但找不到输入框', _rc: 1 });
        }
        await page.waitForTimeout(1200);
        await clickFirst(page, [
          'button:has-text("Next")', 'button:has-text("Verify")',
          'button:has-text("Log in")', 'button:has-text("提交")',
          'button:has-text("下一步")', 'button[type="submit"]',
        ], { timeout: 2500 });
        await page.waitForTimeout(3500);
        await shot(page, 'after-otp');
        continue;
      }

      // ---- 挑战：形状验证码（「点选两个相同物体」—— 实测几乎每次密码
      // 提交后都会弹，2026-09-28 起自动求解，不再交人工）----
      // 滑块/拼图类仍自动化扛不住：识别出滑块特征就维持人工退出。
      const capWidget = await findShapeCaptcha(page);
      if (capWidget) {
        captchaTries++;
        if (captchaTries > 6) {
          await shot(page, 'captcha-exhausted');
          OUT({ ok: false, stage: 'captcha',
            error: `形状验证码连续 ${captchaTries - 1} 次未通过，需人工处理`, _rc: 2 });
        }
        log(`检测到形状验证码（第 ${captchaTries} 次尝试）…`);
        await shot(page, 'captcha-before');
        await solveShapeCaptchaOnce(capWidget, page, log);
        // 点完等判定：通过 → widget 消失走主循环；失败 → TikTok 换新图，下轮重试
        await page.waitForTimeout(4000);
        await shot(page, 'captcha-after');
        continue;
      }
      if (/slider|puzzle|拖[动移]|滑[块动]/i.test(pageText.slice(0, 4000))) {
        await shot(page, 'captcha-slider');
        OUT({ ok: false, stage: 'captcha',
          error: '遇到滑块/拼图挑战，自动化扛不住，需人工处理后重跑', _rc: 2 });
      }

      // ---- 邮箱框：默认登录页就是 Email 标签；⚠️ 邮箱+密码是**同页一个
      // 表单**，两个都填了才能提交 —— 只填邮箱点 Log in 会原地报错打转 ----
      const emailFilled = await fillFirst(page, [
        'input[name="username"]', 'input[type="email"]',
        'input[placeholder*="email" i]', 'input[placeholder*="邮箱"]',
      ], EMAIL, { timeout: 1800 });
      if (emailFilled) {
        log('填邮箱');
        const pwAlso = page.locator('input[type="password"]').first();
        if (await pwAlso.isVisible().catch(() => false)) {
          await pwAlso.fill(TT_PASS).catch(() => {});
          log('同页密码框已填');
        }
        await page.waitForTimeout(800);
        await clickFirst(page, [
          'button:has-text("Log in")', 'button:has-text("Next")',
          'button:has-text("Send code")', 'button[type="submit"]',
          'button:has-text("登录")', 'button:has-text("下一步")',
        ], { timeout: 2500 });
        await page.waitForTimeout(3500);
        await shot(page, 'after-email');
        continue;
      }

      // ---- 邮箱框没出现 → 可能默认在手机号标签，切到邮箱再试一次 ----
      if (/i18n\/login|passport/.test(url)) {
        const switched = await clickFirst(page, [
          'text="Use email"', 'text=使用邮箱',
          '[role="tab"]:has-text("Email")',
        ], { timeout: 1200 });
        if (switched) {
          log('切到邮箱登录标签');
          await page.waitForTimeout(1500);
          if (await fillFirst(page, [
            'input[type="email"]', 'input[name="username"]',
          ], EMAIL, { timeout: 2500 })) {
            log('切标签后填邮箱');
            await page.waitForTimeout(800);
            await clickFirst(page, [
              'button:has-text("Log in")', 'button:has-text("Next")',
              'button[type="submit"]',
            ], { timeout: 2500 });
            await page.waitForTimeout(2500);
            await shot(page, 'after-email');
            continue;
          }
        }
      }

      // ---- 密码框 ----
      const pw = page.locator('input[type="password"]').first();
      if (await pw.count() && await pw.isVisible().catch(() => false)) {
        log('填密码');
        await pw.fill(TT_PASS).catch(() => {});
        await page.waitForTimeout(800);
        await clickFirst(page, [
          'button:has-text("Log in")', 'button[type="submit"]',
          'button:has-text("登录")', 'input[type="submit"]',
        ], { timeout: 2500 });
        await page.waitForTimeout(3500);
        await shot(page, 'after-password');
        continue;
      }

      // ---- 兜底：只点「动作类」按钮。⚠️ 绝不能点 a[href*=login] —— 在登录
      // 页上会无限重新导航，SPA 永远渲染不完（实测白屏 5 分钟的根因）----
      const clicked = await clickFirst(page, [
        'button:has-text("Next")', 'button:has-text("登录")',
        'button:has-text("下一步")', 'button[type="submit"]',
      ], { timeout: 1500 });
      if (!clicked) {
        // 没有任何认识的东西 → 可能是账户选择页 / 风控页，截图后等一轮
        if (step > 0 && step % 6 === 5) await shot(page, 'stuck');
      }
      await page.waitForTimeout(2500);
    }

    await shot(page, 'timeout');
    OUT({ ok: false, stage: 'timeout',
      error: `5 分钟内没走完登录（最后 URL: ${page.url().slice(0, 120)}）`, _rc: 1 });
  } catch (e) {
    await shot(page, 'crash').catch(() => {});
    OUT({ ok: false, stage: 'crash', error: String(e && e.message || e), _rc: 1 });
  } finally {
    await ctx.close().catch(() => {});
  }
})();
