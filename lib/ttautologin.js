'use strict';
/**
 * TikTok cookie 自动续期调度器 —— kind=登录材料的消费者（2026-09-28）。
 *
 * 背景：广告线 cookie TTL 只有 3 天，人工每 3 天粘一次 cURL 不是运维是苦役。
 * 号池存「邮箱 + 邮箱密码 + TikTok 密码」（加密），节点在 cookie 剩余寿命
 * 不足时自动网页登录换新 cookie 回填。本模块只做**调度与对账**：
 *
 *   1. 定时（默认 15min）拉一次账号清单，挑出该续期的号；
 *   2. spawn 子进程跑 `tools/tiktok_login.js`（Playwright 登录）——
 *      **子进程退出即释放内存**，平时不启动浏览器，生图执行面零打扰；
 *   3. 拿到新 cookie 先本地 probe 验活，通过了才回填号池；
 *   4. 对账：控制台删掉的号，节点上的登录 profile 缓存同步删除。
 *
 * 设计约束（每条都踩过坑）：
 *  - 一次只跑一个登录子进程。TikTok 登录页对同 IP 并发登录敏感，
 *    而且多个 Chromium 同时拉起会把生图面的内存挤爆。
 *  - 内存门槛：os.freemem() 不足时本轮跳过（默认 1.5GB）——
 *    生图满槽（8 tabs）时让路，宁可晚 15 分钟续期。
 *  - 失败退避：同一账号两次尝试至少隔 RH_TT_LOGIN_RETRY_MINUTES（默认 2h），
 *    防止密码错了死循环刷邮箱（微软侧会触发风控）。
 *  - 凭据不落盘、不打日志（日志里只出现账号 id 与脱敏邮箱）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** 单次登录子进程的总预算（含等验证码）。超时强杀，绝不留僵尸 Chromium。 */
const LOGIN_TIMEOUT_MS = 6 * 60_000;

const runtime = {
  lastCheckAt: 0,
  lastCheckOk: null,
  lastCheckError: '',
  lastRun: null,       // {id, label(masked), ok, stage, at, durMs}
  running: null,       // 正在登录的账号 id
  lastCleanup: null,   // {at, removed:[...]}
};

let timer = null;
let inflight = false;                 // 并发保护：上一轮还没跑完就不再进
const lastAttempt = new Map();        // accountId → 上次尝试的 ts（本地退避）

/** 邮箱脱敏：name@outlook.com → na***@outlook.com。日志统一走这里。 */
function maskEmail(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return '***';
  return s.slice(0, 2) + '***' + s.slice(at);
}

function status() {
  return {
    enabled: !!timer,
    running: runtime.running,
    last_check_at: runtime.lastCheckAt,
    last_check_ok: runtime.lastCheckOk,
    last_check_error: runtime.lastCheckError,
    last_run: runtime.lastRun,
    last_cleanup: runtime.lastCleanup,
  };
}

// ---------------------------------------------------------------- profile 对账

/**
 * 删除不属于现存账号的 profile 目录（控制台删号 → 节点缓存清理）。
 *
 * 目录名约定：data/tt-profiles/<account_id>（纯数字）。非数字命名的目录
 * 不动 —— 那可能是人工调试的产物，不归自动对账管。
 */
function reconcileProfiles(profileDir, accountIds, log) {
  let removed = [];
  try {
    if (!fs.existsSync(profileDir)) return removed;
    const alive = new Set(accountIds.map(String));
    for (const name of fs.readdirSync(profileDir)) {
      if (!/^\d+$/.test(name) || alive.has(name)) continue;
      const full = path.join(profileDir, name);
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(name);
      } catch (e) {
        (log || (() => {}))(`[tt-login] 清理 profile ${name} 失败：${e.message}`, 'warn');
      }
    }
    if (removed.length) {
      (log || (() => {}))(`[tt-login] 已清理 ${removed.length} 个已删账号的登录缓存：`
        + removed.join(', '));
    }
  } catch (e) {
    (log || (() => {}))(`[tt-login] profile 对账失败：${e.message}`, 'warn');
  }
  return removed;
}

// ---------------------------------------------------------------- 候选挑选

/**
 * 挑出该续期的号。三个条件按「最急的优先」排序：
 *   · expires_ts = 0（还没有 cookie，等首登）
 *   · verify_ok = 0（验活已判死，TTL 没到也得换）
 *   · 剩余寿命 < margin
 * 再叠加退避：距上次尝试（本地记的或号池记的）必须超过 retryMinutes。
 */
function pickCandidate(accounts, cfg, now) {
  const marginSec = cfg.ttLoginMarginHours * 3600;
  const retrySec = cfg.ttLoginRetryMinutes * 60;
  const scored = [];
  for (const a of accounts || []) {
    const lg = a.login;
    if (!lg || !lg.auto_refresh) continue;
    // 材料不全：邮箱 + TikTok 密码是登录的最低要求；邮箱密码缺了收不了
    // 验证码 —— TikTok 新设备登录几乎必弹邮箱验证码，所以三项都要求。
    if (!lg.email || !lg.tiktok_pass || !lg.email_pass) continue;
    const last = Math.max(lastAttempt.get(a.id) || 0, a.last_login_ts || 0);
    if (now - last < retrySec) continue;
    const remain = a.expires_ts ? a.expires_ts - now : -1;
    let urgency = 0;
    if (!a.expires_ts) urgency = 3;
    else if (a.verify_ok === 0) urgency = 2;
    else if (remain < marginSec) urgency = 1;
    if (!urgency) continue;
    scored.push({ a, urgency, remain });
  }
  scored.sort((x, y) => y.urgency - x.urgency || x.remain - y.remain);
  return scored.map((s) => s.a);
}

// ---------------------------------------------------------------- 执行一次登录

/**
 * spawn 登录子进程并等待结果。
 * 子进程 stdout 的**最后一行**是 JSON（中间可能有它自己 spawn 的接码器输出，
 * 所以不能拿整段 stdout 当 JSON 解）。
 */
function runLoginChild(cfg, acct) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath,
      [path.join(__dirname, '..', 'tools', 'tiktok_login.js')],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DISPLAY: cfg.ttLoginHeadful ? (process.env.DISPLAY || ':98') : '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      done({ ok: false, stage: 'timeout', error: `登录超时（${Math.round(LOGIN_TIMEOUT_MS / 1000)}s）` });
    }, LOGIN_TIMEOUT_MS);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => {
      clearTimeout(killTimer);
      done({ ok: false, stage: 'spawn', error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      const lines = stdout.trim().split('\n');
      let result = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('{')) {
          try { result = JSON.parse(line); break; } catch { /* 不是这行 */ }
        }
      }
      if (result) resolve(result);
      else done({ ok: false, stage: 'no-output',
        error: `子进程退出码 ${code}${stderr ? '，stderr: '
          + String(stderr).slice(-300) : '，无输出'}` });
    });
    child.stdin.write(JSON.stringify({
      account_id: acct.id,
      email: acct.login.email,
      email_pass: acct.login.email_pass,
      tiktok_pass: acct.login.tiktok_pass,
      profile_dir: path.join(cfg.ttProfileDir, String(acct.id)),
      headless: !cfg.ttLoginHeadful,
    }));
    child.stdin.end();
  });
}

/**
 * 给一个号跑完整续期：登录 → 验活 → 回填号池。
 * 任何失败都回报号池（ok=false + 原因），控制台能看到「上次登录为什么炸」。
 */
async function refreshOne(client, cfg, log, acct, tiktok) {
  const t0 = Date.now();
  runtime.running = acct.id;
  log(`[tt-login] 账号 #${acct.id}（${maskEmail(acct.login.email)}）开始自动登录…`);
  let result;
  try {
    result = await runLoginChild(cfg, acct);
  } finally {
    runtime.running = null;
  }
  lastAttempt.set(acct.id, Math.floor(Date.now() / 1000));
  const durMs = Date.now() - t0;

  if (!result.ok || !result.cookie) {
    log(`[tt-login] 账号 #${acct.id} 登录失败（${result.stage}）：${result.error}`, 'warn');
    runtime.lastRun = { id: acct.id, ok: false, stage: result.stage, at: Date.now(), durMs };
    try {
      await client.loginReport({ account_id: acct.id, ok: false,
        note: `${result.stage}: ${result.error}` });
    } catch (e) {
      log(`[tt-login] 回报号池失败：${e.message}`, 'warn');
    }
    return false;
  }

  // —— 合成标准凭据：新 cookie + 旧凭据的设备指纹（沿用 device_id 口径）——
  const old = acct.session || {};
  const session = {
    cookie: result.cookie,
    user_agent: result.user_agent || old.user_agent || '',
    device_id: old.device_id || '',
    x_fp_id: old.x_fp_id || '',
    x_csrftoken: (result.cookie.match(/csrftoken=([^;]+)/) || [])[1] || '',
  };
  // 上游验活：号池在北京够不到 ads.tiktok.com，验活只能在节点做。
  // 没验过就回填，一条死 cookie 会把控制台的「有效」结论污染 15 分钟。
  let alive = true, probeMsg = '（未探测）';
  try {
    const probe = await tiktok.probeSession(session, cfg);
    alive = !!probe.alive;
    probeMsg = `code=${probe.code} ${probe.message || ''}`.trim();
  } catch (e) {
    log(`[tt-login] 探测失败（按失败处理）：${e.message}`, 'warn');
    alive = false;
    probeMsg = `probe-error: ${e.message}`;
  }
  if (!alive) {
    log(`[tt-login] 账号 #${acct.id} 新 cookie 探测未通过：${probeMsg}`, 'warn');
    runtime.lastRun = { id: acct.id, ok: false, stage: 'probe', at: Date.now(), durMs };
    try {
      await client.loginReport({ account_id: acct.id, ok: false,
        note: `登录成功但新 cookie 验活未通过（${probeMsg}）` });
    } catch { /* 尽力而为 */ }
    return false;
  }

  try {
    const r = await client.loginReport({ account_id: acct.id, ok: true,
      cookie: session.cookie, user_agent: session.user_agent,
      note: '自动登录成功' });
    log(`[tt-login] 账号 #${acct.id} 自动登录成功并回填（v${r.version}，`
      + `${Math.round(durMs / 1000)}s）`);
    runtime.lastRun = { id: acct.id, ok: true, at: Date.now(), durMs };
    return true;
  } catch (e) {
    log(`[tt-login] 账号 #${acct.id} cookie 回填号池失败：${e.message} —— `
      + 'cookie 在本地探活已通过，下一轮会重试回填', 'error');
    runtime.lastRun = { id: acct.id, ok: false, stage: 'report', at: Date.now(), durMs };
    return false;
  }
}

// ---------------------------------------------------------------- 主循环

async function check(client, cfg, log, tiktok) {
  runtime.lastCheckAt = Date.now();
  if (inflight) return;
  inflight = true;
  try {
    const r = await client.accounts('tiktok_r2v');
    const accounts = (r && r.accounts) || [];
    // 对账先做：删号后的 profile 缓存不该等到有活才清。
    const removed = reconcileProfiles(cfg.ttProfileDir,
      accounts.map((a) => a.id), log);
    runtime.lastCleanup = { at: Date.now(), removed };
    const cands = pickCandidate(accounts, cfg, Math.floor(Date.now() / 1000));
    if (!cands.length) { runtime.lastCheckOk = true; return; }
    const acct = cands[0];
    // 内存门槛：生图满槽时让路。宁可晚一轮，不抢执行面的内存。
    const freeMb = Math.round(os.freemem() / 1048576);
    if (freeMb < cfg.ttLoginMinFreeMb) {
      log(`[tt-login] 账号 #${acct.id} 该续期，但可用内存 ${freeMb}MB < `
        + `${cfg.ttLoginMinFreeMb}MB，本轮跳过（生图优先）`, 'warn');
      runtime.lastCheckOk = true;
      return;
    }
    await refreshOne(client, cfg, log, acct, tiktok);
    runtime.lastCheckOk = true;
  } catch (e) {
    runtime.lastCheckOk = false;
    runtime.lastCheckError = e.message;
    log(`[tt-login] 续期检查失败：${e.message}`, 'warn');
  } finally {
    inflight = false;
  }
}

function start(client, cfg, log, tiktok) {
  if (!cfg.ttLoginCheckSeconds || cfg.ttLoginCheckSeconds <= 0) {
    log('[tt-login] RH_TT_LOGIN_CHECK_SECONDS=0，自动续期已关闭');
    return;
  }
  // 模块级 tiktok 引用：refreshOne 里 probe 用
  currentTiktok = tiktok;
  stop();
  timer = setInterval(() => {
    check(client, cfg, log, currentTiktok).catch((e) =>
      log(`[tt-login] 检查循环意外退出：${e && e.stack || e}`, 'error'));
  }, cfg.ttLoginCheckSeconds * 1000);
  timer.unref && timer.unref();
  // 启动后 45s 先跑一轮：刚在控制台配完材料/刚重启节点时不用等满一个周期。
  // 45s 是刻意的 —— 避开启动风暴（session 探活、账号采集都在抢跑）。
  const first = setTimeout(() => {
    check(client, cfg, log, currentTiktok).catch(() => {});
  }, 45_000);
  first.unref && first.unref();
  log(`[tt-login] 自动续期已启动：每 ${cfg.ttLoginCheckSeconds}s 检查，`
    + `寿命余量 ${cfg.ttLoginMarginHours}h，失败退避 ${cfg.ttLoginRetryMinutes}min，`
    + `内存门槛 ${cfg.ttLoginMinFreeMb}MB`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

let currentTiktok = null;

module.exports = { start, stop, status, pickCandidate, reconcileProfiles };
