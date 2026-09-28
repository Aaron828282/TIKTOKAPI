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

// ---- BFF 指纹捕获：登录后的页面流量里，`x-fp-id` 在请求头、`device_id` 在
// ---- URL 查询串。号池回填时显式带上（login-refresh 支持），让新会话绑定
// ---- 该 profile 真实的设备注册结果，而不是留空。
const bffFp = { x_fp_id: '', device_id: '' };
function watchBffFp(page) {
  page.on('request', (req) => {
    try {
      const u = req.url();
      if (!/ads\.tiktok\.com/.test(u)) return;
      if (!bffFp.x_fp_id) {
        const h = req.headers()['x-fp-id'];
        if (h) bffFp.x_fp_id = h;
      }
      if (!bffFp.device_id) {
        const m = u.match(/[\?&](?:device_id|did)=(\d{10,25})/);
        if (m) bffFp.device_id = m[1];
      }
    } catch { /* 尽力而为 */ }
  });
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
const VLM_SOLVER_PY = path.join(__dirname, 'captcha_solver', 'gemini_solver.py');

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
  const bbPre = await cap.el.boundingBox().catch(() => null);
  const tag = await cap.el.evaluate((n) => n.tagName + '.' + String(n.className || '').slice(0, 60)).catch(() => '?');
  log(`验证码元素：${tag} @ frame(${cap.frame.url().slice(0, 60)}) box=${bbPre ? JSON.stringify({ x: Math.round(bbPre.x), y: Math.round(bbPre.y), w: Math.round(bbPre.width), h: Math.round(bbPre.height) }) : 'null'}`);
  // 优先拿 <img> 原图（data:URI 直接解码）—— 元素截图只有 CSS 像素分辨率，
  // 3D 字母 + 阴影在小图上轮廓分裂，是误配的主因（2026-09-28 实测 score~0.3）
  let shotDone = false;
  const srcInfo = await cap.el.evaluate((n) => ({
    src: n.currentSrc || n.src || '', nw: n.naturalWidth, nh: n.naturalHeight,
  })).catch(() => null);
  if (srcInfo) log(`验证码图源：native=${srcInfo.nw}x${srcInfo.nh} src=${srcInfo.src.slice(0, 60)}`);
  if (srcInfo && /^data:image\/(png|jpeg|jpg);base64,/.test(srcInfo.src)) {
    try {
      fs.writeFileSync(SHOT_TMP, Buffer.from(srcInfo.src.split(',')[1], 'base64'));
      shotDone = true;
      log('已用 data:URI 原图（原生分辨率）送求解器');
    } catch { /* 落回元素截图 */ }
  }
  if (!shotDone) await cap.el.screenshot({ path: SHOT_TMP });

  // —— 求解：优先 Gemini VLM（经典 CV 对 3D 透视/奶白配色/软阴影配对不稳，
  // 2026-09-28 四张真样本实测；VLM 零训练且这类题对多模态模型是简单任务），
  // 未配 key 或失败时回落经典 CV 求解器 —— ——
  const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.RH_GEMINI_API_KEY || '';
  if (GEMINI_KEY) {
    const vlm = await new Promise((resolve) => {
      const py = spawn(captchaPython(), [VLM_SOLVER_PY, SHOT_TMP],
        { env: { ...process.env, GEMINI_API_KEY: GEMINI_KEY } });
      let so = '';
      let se = '';
      let done = false;
      const finish = (r) => { if (!done) { done = true; try { py.kill('SIGKILL'); } catch { /* */ } resolve(r); } };
      setTimeout(() => finish(null), 40_000);   // VLM 链路慢些：3 模型 × 25s 上限
      py.stdout.on('data', (c) => { so += c; });
      py.stderr.on('data', (c) => { se += c; });
      py.on('error', (e) => { log(`VLM 求解器启动失败：${e.message}`); finish(null); });
      py.on('close', () => {
        const lines = so.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (line.startsWith('{')) {
            try { return finish(JSON.parse(line)); } catch { /* 不是这行 */ }
          }
        }
        if (se.trim()) finish({ ok: false, reason: 'stderr: ' + se.trim().slice(-200) });
        else finish(null);
      });
    });
    if (vlm && vlm.ok && Array.isArray(vlm.points) && vlm.points.length === 2) {
      log(`VLM 求解成功（${vlm.model || 'gemini'}）：点击 `
        + `(${vlm.points[0].rel_x},${vlm.points[0].rel_y}) / (${vlm.points[1].rel_x},${vlm.points[1].rel_y})`);
      try { fs.unlinkSync(SHOT_TMP); } catch { /* 留着也行 */ }
      return await clickCaptchaPoints(cap, page, vlm.points, log);
    }
    log(`VLM 求解未通过（${vlm && vlm.reason ? vlm.reason.slice(0, 160) : '无输出/超时'}），回落经典 CV…`);
  }
  // 经典 CV 求解：stdout 最后一行 JSON。20s 超时强杀 —— 求解器卡死不能拖垮登录。
  const result = await new Promise((resolve) => {
    const py = spawn(captchaPython(), [SOLVER_PY, SHOT_TMP]);
    let so = '';
    let se = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { py.kill('SIGKILL'); } catch { /* */ } resolve(r); } };
    setTimeout(() => finish(null), 20_000);
    py.stdout.on('data', (c) => { so += c; });
    py.stderr.on('data', (c) => { se += c; });   // 之前把 stderr 丢了，traceback 全看不见
    py.on('error', (e) => { log(`求解器启动失败（${captchaPython()}）：${e.message}`); finish(null); });
    py.on('close', () => {
      const lines = so.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{')) {
          try { return finish(JSON.parse(line)); } catch { /* 不是这行 */ }
        }
      }
      if (se.trim()) finish({ ok: false, reason: 'stderr: ' + se.trim().slice(-300) });
      else finish(null);
    });
  });
  if (!result || !result.ok) {
    // 失败时保留元素截图现场（成功才删），并带上图像尺寸，方便隔空诊断
    try {
      const sz = fs.statSync(SHOT_TMP).size;
      log(`求解失败现场已保留：${SHOT_TMP}（${sz} 字节）`);
    } catch { /* 文件不在 */ }
  } else {
    try { fs.unlinkSync(SHOT_TMP); } catch { /* 留着也行 */ }
  }
  if (!result || !result.ok || !Array.isArray(result.points) || result.points.length !== 2) {
    log(`求解失败：${result && result.reason ? result.reason : '无输出/超时'}`);
    return false;
  }
  log(`CV 求解成功（score=${result.score}）：点击 `
    + `(${result.points[0].rel_x},${result.points[0].rel_y}) / (${result.points[1].rel_x},${result.points[1].rel_y})`);
  return await clickCaptchaPoints(cap, page, result.points, log);
}

/**
 * 人类化点击两个验证码坐标并点 Confirm（VLM / CV 求解器共用）。
 * 坐标 = 验证码图区 boundingBox × 归一化比例（与截图分辨率/DPR 无关）。
 */
async function clickCaptchaPoints(cap, page, points, log) {
  const bb = await cap.el.boundingBox().catch(() => null);
  if (!bb) { log('验证码图区 boundingBox 拿不到（可能已消失）'); return false; }
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
  await humanClick(points[0].rel_x, points[0].rel_y);
  await sleep(350 + Math.random() * 500);
  await humanClick(points[1].rel_x, points[1].rel_y);
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

// ---- 原生弹窗清扫（2026-09-28 账号#7 实锤后新增）----
// 有头模式下 Chrome 会弹 **Playwright 完全不可见** 的原生 Views 弹窗：
// 「Open xdg-open?」（登录页触发外部协议确认）、「Restore pages?」、
// 「Save password」…… 这类弹窗模态挡住整窗，页面级点击/填表全部无效，
// 状态机只会干转到超时。处置分层：
//   ① 启动参数掐掉已知来源（restore 气泡等）；
//   ② 预写 Preferences 关掉保存密码气泡；
//   ③ 有头时定期在 X 层发 Esc 兜底清扫（无头模式没有 OS 级弹窗，不扫）。
// Esc 对登录页/OTP 页无害；验证码求解期间不扫，避免误关挑战。
let lastSweep = 0;
let sweepCount = 0;
function sweepNativePopups(reason) {
  if (HEADLESS) return;
  const now = Date.now();
  if (now - lastSweep < 5000) return;          // 节流：5s 最多一次
  lastSweep = now;
  sweepCount++;
  try {
    const c = spawn('xdotool', ['key', '--clearmodifiers', 'Escape'], {
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':98' },
      stdio: 'ignore', detached: true });
    c.unref();
    if (sweepCount % 3 === 1) {
      try { process.stderr.write(`[tt-login] 清扫原生弹窗(Esc) · ${reason}\n`); } catch { /* 无 */ }
    }
  } catch { /* 没装 xdotool 就只能靠启动参数兜着 */ }
}

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const log = (m) => { try { process.stderr.write(`[tt-login] ${m}\n`); } catch { /* 无 */ } };

  // ② 预写 Preferences：关掉保存密码气泡（原生弹窗来源之一）
  try {
    const pdir = path.join(PROFILE, 'Default');
    fs.mkdirSync(pdir, { recursive: true });
    const pf = path.join(pdir, 'Preferences');
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch { /* 新 profile */ }
    prefs.credentials_enable_service = false;
    prefs.profile = { ...(prefs.profile || {}), password_manager_enabled: false };
    fs.writeFileSync(pf, JSON.stringify(prefs));
  } catch { /* 尽力而为 */ }

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    viewport: { width: 1366, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    // ① 掐掉已知的原生弹窗来源（「Restore pages?」崩溃恢复气泡等）
    args: ['--hide-crash-restore-bubble', '--disable-session-crashed-bubble', '--noerrdialogs'],
  });
  let page = ctx.pages()[0] || (await ctx.newPage());
  await spoofPage(ctx, page);
  watchBffFp(page);
  // 登录流可能弹新窗口（OAuth 子域等），新 page 一律先伪装再干活
  ctx.on('page', (p) => { spoofPage(ctx, p).catch(() => {}); watchBffFp(p); });

  try {
    // ⚠️ 直连登录页，**不走落地页**：落地页的 Log in 按钮点击行为不稳定
    // （有时弹菜单不导航），而且从落地页点进登录页后 SPA 长时间白屏
    // （实测 5 分钟不渲染）；直连 /i18n/login 则 10s 内表单可用。
    // 🔴 必须带 redirect=creativestudio/create 参数（2026-09-28 用户指正）：
    // 裸 /i18n/login 登录后落点不对，拿不到 Symphony Creative Studio 会话。
    // 已登录的 profile 访问登录页会被重定向回主站 —— 正好当出口判定。
    await page.goto('https://ads.tiktok.com/i18n/login?redirect='
      + encodeURIComponent('https://ads.tiktok.com/creative/creativestudio/create'), {
      waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(6000);
    sweepNativePopups('进入登录页');
    await shot(page, 'entry');

    let otpUsed = false;       // 一次运行最多收一次码（防止连续触发风控）
    let captchaTries = 0;      // 形状验证码已尝试次数（连续失败超限报人工）
    let lastWasCaptcha = false; // 上一轮是否在解形状验证码（求解轮入口不扫弹窗）
    const deadline = Date.now() + 6 * 60_000;
    let step = 0;

    for (; step < 30 && Date.now() < deadline; step++) {
      // ③ 每轮入口先扫一次原生弹窗（上一轮在解验证码时跳过，见下）
      if (!lastWasCaptcha) sweepNativePopups('循环入口');
      lastWasCaptcha = false;
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
        // ⚠️ 给页面补 cookie 的时间要够：Symphony SPA 渐进加载，BFF 调用
        // 用的 csrf/tt_target 等 cookie 落地较晚 —— 只等 1.5s 收割的 cookie
        // 集不全，探测会 10001106（2026-09-28 02:51 实锤）。等网络空闲再收。
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const all = await ctx.cookies();
        // 只收 *.tiktok.com 域的 cookie（httpOnly 的 sessionid_ads 也在内）
        const tt = all.filter((c) => /tiktok\.com$/.test(c.domain));
        const cookieStr = tt.map((c) => `${c.name}=${c.value}`).join('; ');
        const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
        if (!cookieStr.includes('sessionid_ads=')) {
          OUT({ ok: false, stage: 'cookie', error: '登录页面成功但 cookie 里没有 sessionid_ads', _rc: 1 });
        }
        OUT({ ok: true, stage: 'done', cookie: cookieStr, user_agent: ua,
          x_fp_id: bffFp.x_fp_id, device_id: bffFp.device_id });
      }

      if (!onLogin) {
        // 落在营销落地页（ads.tiktok.com/business/...）且还没拿到会话 ——
        // 这里不会自动弹登录框，必须**主动点 Log in**（按钮在页头右上角；
        // 别点 a:has-text 那个 —— .first() 命中的是页脚 y=10000+ 的隐藏链接）。
        if (!hasSess) {
          sweepNativePopups('落地页点Login前');
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

      // ---- 挑战：形状验证码（「点选两个相同物体」—— 实测几乎每次密码
      // 提交后都会弹，2026-09-28 起自动求解，不再交人工）----
      // ⚠️ 必须**先于 OTP 检查**：OTP 提交后 TikTok 会立刻弹第二道形状
      // 验证码，而背景页还残留 "Confirm your email" 文本 —— 先查 OTP 会
      // 误判 otp-stuck 直接退出（2026-09-28 02:15 截图实锤）。
      // 滑块/拼图类仍自动化扛不住：识别出滑块特征就维持人工退出。
      const pageText = await page.locator('body').innerText().catch(() => '') || '';
      const capWidget = await findShapeCaptcha(page);
      if (capWidget) {
        lastWasCaptcha = true;   // 求解轮：下轮入口跳过 Esc 清扫，避免误关挑战
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

      // ---- 挑战：邮箱验证码（身份验证页）----
      // ⚠️ 必须用 innerText（只算可见文本）：textContent 会把 body 里隐藏的
      // i18n 模板（"a verification code has been sent"）也算进去，登录表单页
      // 就会被误判成 OTP 页（2026-09-28 01:38 实测：跳过填邮箱、码填进空框）。
      // ⚠️ 且**必须以输入框为准**：登录成功进 Symphony 后，文案可能残留
      // （"Confirm your email"），但输入框没了 —— 只看文案会把成功页误判
      // 成 otp-stuck、放弃收割（2026-09-28 02:45 实锤：人已在站内 4000 分）。
      // （pageText 已在上方形状验证码分支前取得）
      const otpInputs = await page.locator(
        'input[inputmode="numeric"], input[maxlength="1"], input[autocomplete="one-time-code"]'
      ).count().catch(() => 0);
      const needOtp = otpInputs >= 4
        || await page.locator('div[class*="code" i] input').count() >= 4;
      if (needOtp) {
        // ③ OTP 页也弹原生模态（2026-09-28 用户实测：邮箱验证码页出弹窗
        // 后什么都点不动）—— 先清扫再干活
        sweepNativePopups('OTP页');
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
        // TikTok 的码输入框两种形态：一个整输入框 / 6 个数字小框。
        // 6 小框是 React 受控组件，Playwright fill() 不触发 onChange ——
        // 必须用原生 value setter + input/change 事件（2026-09-27 CDP 实测）。
        // ⚠️ 输入框可能在 iframe 里（登录表单整体是 iframe）——遍历所有 frame。
        let filled = null;
        let fillFrame = null;   // 记下码填进哪个 frame，提交按钮也去那里找
        {
          const chars = otp.code.split('');
          // ⚠️ 首选「逐格真实键入」：这个页面没有提交按钮，输满 6 位靠
          // React onKeyDown 自动提交 —— 原生 setter 只改显示值不触发键盘
          // 事件，框看着填满了但表单状态是空（2026-09-28 02:06 截图实锤）。
          const typeFill = async (frame) => {
            const inputs = frame.locator('input:visible');
            const n = await inputs.count().catch(() => 0);
            if (n < chars.length) return false;
            for (let i = 0; i < chars.length; i++) {
              const box = inputs.nth(i);
              await box.click().catch(() => {});
              await box.pressSequentially(chars[i], { delay: 90 + Math.random() * 140 })
                .catch(() => {});
              await sleep(120 + Math.random() * 200);
            }
            return true;
          };
          for (const frame of page.frames()) {
            if (await typeFill(frame).catch(() => false)) {
              filled = 'typed'; fillFrame = frame;
              log(`填码成功(真实键入, frame: ${frame.url().slice(0, 60)})`);
              break;
            }
          }
          // 兜底1：原生 value setter（React 受控组件的通用填法）
          if (!filled) {
            const fillFn = (code) => {
              const inputs = [...document.querySelectorAll('input')]
                .filter((i) => i.offsetParent !== null);
              if (inputs.length < code.length) return null;
              for (let i = 0; i < code.length; i++) {
                const el = inputs[i];
                const desc = Object.getOwnPropertyDescriptor(
                  Object.getPrototypeOf(el), 'value');
                desc.set.call(el, code[i]);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
              return 'boxes';
            };
            for (const frame of page.frames()) {
              filled = await frame.evaluate(fillFn, chars).catch(() => null);
              if (filled) { fillFrame = frame; log(`填码成功（setter, frame: ${frame.url().slice(0, 60)}）`); break; }
            }
          }
          if (!filled) {
            // 兜底1：逐 frame 找单框整码输入
            for (const frame of page.frames()) {
              filled = await fillFirst(frame, [
                'input[autocomplete="one-time-code"]',
                'input[name="code"]', 'input[name="verifyCode"]',
                'input[placeholder*="code" i]', 'input[placeholder*="验证码"]',
              ], otp.code);
              if (filled) { log(`填码成功(单框, frame: ${frame.url().slice(0, 60)})`); break; }
            }
          }
          if (!filled) {
            // 兜底2：6 格在主文档但可见性过滤误杀 —— 不筛 offsetParent 重试
            for (const frame of page.frames()) {
              filled = await frame.evaluate((code) => {
                const inputs = [...document.querySelectorAll('input')];
                if (inputs.length < code.length) return null;
                for (let i = 0; i < code.length; i++) {
                  const el = inputs[i];
                  const desc = Object.getOwnPropertyDescriptor(
                    Object.getPrototypeOf(el), 'value');
                  desc.set.call(el, code[i]);
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                }
                return 'boxes-all';
              }, chars).catch(() => null);
              if (filled) { log(`填码成功(不过滤可见性, frame: ${frame.url().slice(0, 60)})`); break; }
            }
          }
        }
        if (!filled) {
          await shot(page, 'otp-no-input');
          for (const frame of page.frames()) {
            const info = await frame.evaluate(() =>
              ({ inputs: document.querySelectorAll('input').length,
                 vis: [...document.querySelectorAll('input')].filter((i) => i.offsetParent !== null).length }))
              .catch(() => ({ inputs: -1, vis: -1 }));
            log(`OTP 诊断 frame ${frame.url().slice(0, 80)} → inputs=${info.inputs} visible=${info.vis}`);
          }
          OUT({ ok: false, stage: 'otp', error: '取到码但找不到输入框（含全部frame）', _rc: 1 });
        }
        await page.waitForTimeout(1200);
        // ⚠️ 2026-09-28 实测：「Confirm your email」页的提交按钮是 Confirm，
        // 不在旧点击列表里 → 码填了但页面纹丝不动（06/07 截图相同）。
        const otpSel = [
          'button:has-text("Confirm")', 'button:has-text("Next")',
          'button:has-text("Verify")', 'button:has-text("Log in")',
          'button:has-text("提交")', 'button:has-text("下一步")',
          'button[type="submit"]', '[role="button"]:has-text("Confirm")',
        ];
        let otpSubmitted = await clickFirst(page, otpSel, { timeout: 2500 });
        if (!otpSubmitted && fillFrame && fillFrame !== page.mainFrame()) {
          otpSubmitted = await clickFirst(fillFrame, otpSel, { timeout: 2000 });
        }
        if (!otpSubmitted) {
          // 兜底：焦点在输入框里直接回车提交
          await page.keyboard.press('Enter').catch(() => {});
        }
        await page.waitForTimeout(3500);
        await shot(page, 'after-otp');
        continue;
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
        sweepNativePopups('提交登录前');
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
        sweepNativePopups('提交密码前');
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
      sweepNativePopups('兜底点击前');
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
      error: `6 分钟内没走完登录（最后 URL: ${page.url().slice(0, 120)}）`, _rc: 1 });
  } catch (e) {
    await shot(page, 'crash').catch(() => {});
    OUT({ ok: false, stage: 'crash', error: String(e && e.message || e), _rc: 1 });
  } finally {
    await ctx.close().catch(() => {});
  }
})();
