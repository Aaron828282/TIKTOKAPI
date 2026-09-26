'use strict';
/**
 * 金丝雀登录试点：用号池里的 aistudio 登录凭据，在 VPS 上（xvfb 有头）
 * 完整走一次「profile 冷启动 → 自登录 → （可选验证码）→ 落地 AI Studio」，
 * 验证持久化 profile 能把登录态握在手里。
 *
 * 跑法（VPS）：
 *   cd /opt/rhnode
 *   xvfb-run -a node selftest/aistudio-login-canary.js [账号id]
 *
 * 产物：/tmp/aicanary/report.json + 每步截图 + profile 落在
 *       /opt/rhnode/data/aistudio-profiles/<账号id>/（与执行器同款路径，
 *       登录成果直接被后续执行器复用）。
 *
 * 凭据来源：号池 GET /agent/accounts（含凭据、不占槽位），绝不经命令行
 * 参数或环境变量传密码。
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const util = require('node:util');
const { chromium } = require('playwright');
const { ensureLogin } = require('../lib/aistudio_login');

const OUT = '/tmp/aicanary';
const WIDE = 1440;

// ---- 读 .env（与执行器同一份凭据口径）----
const env = {};
for (const ln of fs.readFileSync('/opt/rhnode/.env', 'utf-8').split('\n')) {
  const m = ln.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

function poolGet(p) {
  return new Promise((resolve, reject) => {
    const u = new URL(env.RH_POOL_URL.replace(/\/$/, '') + p);
    const req = https.request(u, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.RH_AGENT_TOKEN}`, Accept: 'application/json' },
      rejectUnauthorized: false,
      timeout: 25000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function log(...a) { console.log(new Date().toISOString().slice(11, 19), util.format(...a)); }

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const shots = path.join(OUT, 'shots');

  const wantId = process.argv[2] ? String(process.argv[2]) : '';
  const data = await poolGet('/api/v1/agent/accounts?backend=aistudio_image');
  const list = data.accounts || [];
  if (!list.length) throw new Error('号池无 aistudio 账号 —— 先在控制台添加');
  const acc = wantId ? list.find((a) => String(a.id) === wantId) : list[0];
  if (!acc) throw new Error(`账号 ${wantId} 不在池子里（现有：${list.map((a) => a.id).join(',')}）`);
  const sess = acc.session || {};
  if (sess.kind !== 'google_login') {
    throw new Error(`账号 #${acc.id} 不是登录凭据（kind=${sess.kind || 'cookie'}）—— `
      + '请用「邮箱+密码」方式重新添加');
  }
  log(`取到账号 #${acc.id}（${sess.email}），凭据形态 google_login`);

  const profileDir = path.resolve('/opt/rhnode', env.RH_AISTUDIO_PROFILE_DIR || 'data/aistudio-profiles', String(acc.id));
  fs.mkdirSync(profileDir, { recursive: true });
  log(`持久 profile：${profileDir}`);

  // 🔑 有头（xvfb 虚拟屏下）：Google 登录页对无头指纹更敏感，这里不省这个内存。
  // ignoreDefaultArgs 去 --enable-automation + --disable-blink-features=Automation
  // Controlled 是过「This browser or app may not be secure」的必要条件
  // （2026-09-27 实测：裸跑必被拦在 signin/rejected）。
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--window-size=1280,860', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: WIDE, height: 860 },
    timeout: 90_000,
  });

  let result;
  try {
    result = await ensureLogin({
      context,
      creds: { email: sess.email, password: sess.password, app_password: sess.app_password },
      log,
      shotsDir: shots,
    });
  } finally {
    if (result && result.page) await result.page.close().catch(() => {});
    // 落盘最终 cookie 状态（含 1PSIDTS 等会话 cookie 是否已在 profile 内自持）
    try {
      const cookies = await context.cookies('https://aistudio.google.com/');
      const keys = cookies.map((c) => c.name);
      fs.writeFileSync(path.join(OUT, 'cookies.json'), JSON.stringify({
        dumped_at: new Date().toISOString(),
        names: keys,
        has_sid: keys.includes('SID'),
        has_sapisid: keys.some((k) => /SAPISID/.test(k)),
      }), { mode: 0o600 });
      log(`profile 内 cookie：${keys.length} 键，SID=${keys.includes('SID')}，SAPISID=${keys.some((k) => /SAPISID/.test(k))}`);
    } catch (e) { log('cookie 读取失败：' + e.message); }
    await context.close().catch(() => {});
  }

  const report = { account_id: acc.id, email_masked: sess.email.replace(/^(.{2}).*(@.*)$/, '$1***$2'),
    status: result.status, detail: result.detail || '', profileDir };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  log('结果：', JSON.stringify(report));
  if (result.status === 'failed' || result.status === 'challenge') process.exit(2);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
