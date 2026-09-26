'use strict';
/**
 * 人机协同首登：VPS 常驻虚拟屏（:99）上开真浏览器，自动填邮箱+密码，
 * 之后所有验证（手机提示 / 短信 / Authenticator / 恢复流程）交给真人
 * 通过 noVNC 亲手完成 —— 冷启动只此一次，profile 常驻后不再登录。
 *
 * 跑法（VPS，DISPLAY 必须已起，见 bin/assisted-login.sh）：
 *   DISPLAY=:99 node selftest/aistudio-assisted-login.js [账号id]
 *
 * 登录成功的判定与执行器同款：profile 内出现 SID + SAPISID cookie。
 * 凭据来源与金丝雀同款：号池 GET /agent/accounts，不经命令行传密码。
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const util = require('node:util');
const { chromium } = require('playwright');
const { applySpoof } = require('../lib/aistudio_login');

const OUT = '/tmp/aissist';
const WIDE = 1440;

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

async function hasLiveSession(context) {
  try {
    const cookies = await context.cookies('https://aistudio.google.com/');
    const names = cookies.map((c) => c.name);
    return names.includes('SID') && names.some((k) => /SAPISID/.test(k));
  } catch { return false; }
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const selftest = process.argv.includes('--selftest');

  let acc = null, sess = null, profileDir = '';
  if (!selftest) {
    const wantId = process.argv[2] && !process.argv[2].startsWith('--')
      ? String(process.argv[2]) : '';
    const data = await poolGet('/api/v1/agent/accounts?backend=aistudio_image');
    const list = data.accounts || [];
    const accSel = wantId ? list.find((a) => String(a.id) === wantId) : list[0];
    if (!accSel) throw new Error(`账号不在池子里（现有：${list.map((a) => a.id).join(',')}）`);
    acc = accSel;
    sess = acc.session || {};
    if (sess.kind !== 'google_login') throw new Error(`账号 #${acc.id} 不是登录凭据`);
    log(`账号 #${acc.id}（${sess.email}）—— 人机协同首登`);
    profileDir = path.resolve('/opt/rhnode',
      env.RH_AISTUDIO_PROFILE_DIR || 'data/aistudio-profiles', String(acc.id));
    fs.mkdirSync(profileDir, { recursive: true });
    log(`持久 profile：${profileDir}`);
  }

  if (!process.env.DISPLAY) throw new Error('需要 DISPLAY=:99 —— 用 bin/assisted-login.sh 启动');

  const context = await chromium.launchPersistentContext(profileDir || '/tmp/aissist/profile', {
    headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage',
      '--window-size=1280,860', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: WIDE, height: 860 },
    timeout: 90_000,
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await applySpoof(context, page, log);

    if (selftest) {
      await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const title = await page.title();
      log(`selftest：页面打开 OK（title=${title}）`);
      fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ status: 'selftest_ok' }));
      await context.close().catch(() => {});
      return;
    }

    // 自动走前两步：进登录页 → 填邮箱 → 填密码。之后全部交给真人。
    const signinUrl = 'https://accounts.google.com/v3/signin/identifier?continue='
      + encodeURIComponent('https://aistudio.google.com/') + '&flowName=GlifWebSignIn&hl=en';
    await page.goto(signinUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForSelector('input[type="email"]', { timeout: 45_000, state: 'visible' });
    await page.fill('input[type="email"]', String(sess.email || ''));
    await page.click('#identifierNext').catch(() => {});
    log('邮箱已提交 —— 等密码页…');
    await page.waitForSelector('input[type="password"]:visible', { timeout: 45_000 });
    await page.fill('input[type="password"]', String(sess.password || ''));
    await page.click('#passwordNext').catch(() => {});
    log('密码已提交。★★ 从现在起请由你在 noVNC 里亲手完成剩余验证 ★★');
    log('（手机提示点「是」/ 短信码 / Authenticator 码，任由 Google 给什么你点什么）');

    // 只盯结果：profile 里出现 SID+SAPISID 即成功，最多等 25 分钟
    const deadline = Date.now() + 25 * 60_000;
    let ok = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(5_000);
      if (await hasLiveSession(context)) { ok = true; break; }
      if (/signin\/rejected/.test(page.url())) { log('页面进入 rejected —— 请换一种验证方式'); }
    }

    const report = { account_id: acc.id, status: ok ? 'logged_in' : 'timeout',
      email_masked: sess.email.replace(/^(.{2}).*(@.*)$/, '$1***$2'), profileDir };
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
    log(ok ? '✅ 登录成功，profile 已持久化 —— 可以关窗了' : '⏳ 25 分钟内未等到登录态');
  } finally {
    await context.close().catch(() => {});
  }
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
